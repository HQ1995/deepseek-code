#![cfg(unix)]

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const KEYBOARD_QUERY: &[u8] = b"\x1b[?u\x1b[c";
const STARTUP_BUDGET: Duration = Duration::from_millis(1_500);

fn pager_binary() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("PAGER_BINARY") {
        return std::path::absolute(&path).expect("absolute PAGER_BINARY");
    }
    option_env!("CARGO_BIN_EXE_dscode")
        .map(std::path::PathBuf::from)
        .expect("PAGER_BINARY is unset and cargo did not expose dscode")
}

struct Scenario {
    name: &'static str,
    env: &'static [(&'static str, &'static str)],
    response: Option<&'static [u8]>,
    expect_query: bool,
}

fn run_scenario(scenario: &Scenario) {
    let home = tempfile::tempdir().expect("isolated home");
    let empty_path = home.path().join("empty-bin");
    std::fs::create_dir(&empty_path).expect("empty PATH directory");

    let mut master_fd = -1;
    let mut slave_fd = -1;
    let mut size = libc::winsize {
        ws_row: 40,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: openpty initializes both descriptors and reads the supplied size.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        },
        0,
        "{}: openpty: {}",
        scenario.name,
        std::io::Error::last_os_error()
    );
    // SAFETY: successful openpty returned owned descriptors.
    let mut master = unsafe { File::from_raw_fd(master_fd) };
    // SAFETY: successful openpty returned owned descriptors.
    let slave = unsafe { File::from_raw_fd(slave_fd) };
    let flags = unsafe { libc::fcntl(master.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0, "{}: get master flags", scenario.name);
    assert_eq!(
        unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) },
        0,
        "{}: set master nonblocking",
        scenario.name
    );

    let stdin = slave.try_clone().expect("clone PTY stdin");
    let stdout = slave.try_clone().expect("clone PTY stdout");
    let mut command = Command::new(pager_binary());
    command
        .arg("--debug")
        .env_clear()
        .env("HOME", home.path())
        .env("DSH_HOME", home.path().join(".dsh"))
        .env("PATH", &empty_path)
        .env("TERM", "xterm-256color")
        .env("GROK_THEME", "grok-night")
        .env("GROK_APPEARANCE", "dark")
        .env("DISABLE_TELEMETRY", "1")
        .env("DISABLE_ERROR_REPORTING", "1")
        .env("GROK_MEMTRACE", "0")
        .env("DSH_TELEMETRY_DISABLED", "1")
        .env("DSCODE_SOCKET", home.path().join("leader.sock"))
        .env("DSCODE_LOG", home.path().join("leader.log"))
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(slave));
    for (key, value) in scenario.env {
        command.env(key, value);
    }

    let started = Instant::now();
    let mut child = command.spawn().expect("spawn dscode");
    let mut output = Vec::new();
    let mut response_sent = false;
    let status = loop {
        let mut chunk = [0u8; 4096];
        loop {
            match master.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => output.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                // Linux PTY masters report EIO once every slave is closed.
                Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                Err(error) => panic!("{}: read PTY: {error}", scenario.name),
            }
        }

        let query_seen = output
            .windows(KEYBOARD_QUERY.len())
            .any(|window| window == KEYBOARD_QUERY);
        if query_seen && !response_sent {
            if let Some(response) = scenario.response {
                master.write_all(response).expect("write terminal response");
            }
            response_sent = true;
        }

        if let Some(status) = child.try_wait().expect("poll dscode") {
            break status;
        }
        if started.elapsed() >= STARTUP_BUDGET {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "{}: startup exceeded {:?}; output={:?}",
                scenario.name,
                STARTUP_BUDGET,
                String::from_utf8_lossy(&output)
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    // Drain the final error/restore sequences.
    for _ in 0..10 {
        let mut chunk = [0u8; 4096];
        match master.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => output.extend_from_slice(&chunk[..count]),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == Some(libc::EIO) =>
            {
                break;
            }
            Err(error) => panic!("{}: final PTY read: {error}", scenario.name),
        }
    }

    assert!(
        !status.success(),
        "{}: missing dsh must fail",
        scenario.name
    );
    let query_seen = output
        .windows(KEYBOARD_QUERY.len())
        .any(|window| window == KEYBOARD_QUERY);
    assert_eq!(
        query_seen,
        scenario.expect_query,
        "{}: unexpected query policy; output={:?}",
        scenario.name,
        String::from_utf8_lossy(&output)
    );
    assert!(
        output
            .windows(b"no dsh CLI found".len())
            .any(|window| window == b"no dsh CLI found"),
        "{}: expected post-probe leader error; output={:?}",
        scenario.name,
        String::from_utf8_lossy(&output)
    );
}

#[test]
fn common_terminal_and_multiplexer_environments_never_block_startup() {
    for scenario in [
        Scenario {
            name: "silent WezTerm",
            env: &[("TERM_PROGRAM", "WezTerm")],
            response: None,
            expect_query: true,
        },
        Scenario {
            name: "Kitty",
            env: &[("TERM", "xterm-kitty"), ("KITTY_WINDOW_ID", "1")],
            response: Some(b"\x1b[?1u\x1b[?1;2c"),
            expect_query: true,
        },
        Scenario {
            name: "Ghostty",
            env: &[("TERM_PROGRAM", "ghostty"), ("TERM", "xterm-ghostty")],
            response: Some(b"draft\x1b[?3u\x1b[?1;2c"),
            expect_query: true,
        },
        Scenario {
            name: "WezTerm",
            env: &[("TERM_PROGRAM", "WezTerm")],
            response: Some(b"\x1b[?5u\x1b[?1;2c"),
            expect_query: true,
        },
        Scenario {
            name: "Zellij",
            env: &[("ZELLIJ", "0"), ("ZELLIJ_VERSION", "0.42.2")],
            response: Some(b"\x1b[7;9R\x1b[?1u\x1b[?1;2c"),
            expect_query: true,
        },
        Scenario {
            name: "Herdr",
            env: &[("HERDR_ENV", "1"), ("HERDR_PANE_ID", "7")],
            response: None,
            expect_query: false,
        },
        Scenario {
            name: "Apple Terminal",
            env: &[("TERM_PROGRAM", "Apple_Terminal")],
            response: None,
            expect_query: false,
        },
        Scenario {
            name: "VTE",
            env: &[("VTE_VERSION", "7600")],
            response: None,
            expect_query: false,
        },
        Scenario {
            name: "VS Code",
            env: &[("TERM_PROGRAM", "vscode")],
            response: None,
            expect_query: false,
        },
    ] {
        run_scenario(&scenario);
    }
}
