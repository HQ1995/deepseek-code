//! `grok update` is a recovery command: a config failure must not block it.
//!
//! Hermetic: a local server serves the binary's own version as the channel
//! pointer, so a healthy run exits 0 ("already up to date") and a corrupt
//! config must too — reintroducing a config `?` fails exactly that run.
//! The pointer must equal the current version: the installer converges in
//! both directions, so an older pointer triggers a downgrade attempt.
//!
//! DIVERGENCE(dscode): the corrupt run also names the file it ignored on
//! stderr (in Rust `build_update_config` and in the managed JS updater), and
//! dscode drops inherited `GROK_*` values: the profile comes from `DSCODE_HOME` and the release
//! from the loopback `DSC_UPDATE_BASE_URL` seam, in GitHub-release form.
//! `PATH` is not passed: the updater installs through `npx`, and a test must
//! not reach npm.

use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};

/// Resolve the pager binary like the PTY harness: `PAGER_BINARY` under
/// Bazel (runfiles-relative), else cargo's compile-time constant.
fn pager_binary() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PAGER_BINARY") {
        return std::path::absolute(&p)
            .unwrap_or_else(|e| panic!("failed to absolutize PAGER_BINARY {p}: {e}"));
    }
    // DIVERGENCE(dscode): the binary target is `dscode`, not `xai-grok-pager`.
    option_env!("CARGO_BIN_EXE_dscode")
        .map(std::path::PathBuf::from)
        .expect("PAGER_BINARY is unset and this build is not `cargo test`")
}

/// Local base answering every request with the channel pointer body.
fn spawn_pointer_server(body: Arc<Mutex<String>>) -> (std::net::TcpListener, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let serving = listener.try_clone().unwrap();
    std::thread::spawn(move || {
        for stream in serving.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buf = [0u8; 1024];
            let read = stream.read(&mut buf).unwrap_or(0);
            let version = body.lock().unwrap_or_else(|e| e.into_inner()).clone();
            // DIVERGENCE(dscode): `/releases/latest` answers one GitHub
            // release; the alpha/beta lookup lists them.
            let release =
                format!(r#"{{"tag_name":"v{version}","draft":false,"prerelease":false}}"#);
            let latest = String::from_utf8_lossy(&buf[..read]).contains("/releases/latest");
            let version = if latest {
                release
            } else {
                format!("[{release}]")
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    version.len(),
                    version
                )
                .as_bytes(),
            );
        }
    });
    (listener, base)
}

/// Run `grok update` in an isolated home against the local pointer base.
fn run_update(base: &str, config_toml: &str, extra_args: &[&str]) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("config.toml"), config_toml).unwrap();
    Command::new(pager_binary())
        .arg("update")
        .args(extra_args)
        .env_clear()
        .env("HOME", home.path())
        .env("DSCODE_HOME", home.path())
        .env("DSC_UPDATE_BASE_URL", base)
        .output()
        .expect("spawn grok update")
}

/// The valid run proves the environment resolves to success, so a nonzero
/// corrupt run can only mean a config failure aborted the update.
#[test]
fn corrupt_config_never_changes_update_outcome() {
    let body = Arc::new(Mutex::new("0.0.1".to_owned()));
    let (_listener, base) = spawn_pointer_server(body.clone());

    // Probe the binary's own version so the pointer matches it exactly.
    let check = run_update(&base, "[cli]\n", &["--check", "--json"]);
    let status: serde_json::Value = serde_json::from_slice(&check.stdout)
        .unwrap_or_else(|e| panic!("update --check --json must emit JSON: {e}"));
    let current = status["currentVersion"]
        .as_str()
        .expect("currentVersion in update --check --json")
        .to_owned();
    *body.lock().unwrap_or_else(|e| e.into_inner()) = current;

    let valid = run_update(&base, "[cli]\n", &[]);
    assert!(
        valid.status.success(),
        "healthy grok update against the local base must exit 0\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&valid.stdout),
        String::from_utf8_lossy(&valid.stderr)
    );

    let corrupt = run_update(&base, "this is not toml {{{[[[", &[]);
    let stderr = String::from_utf8_lossy(&corrupt.stderr);
    assert!(
        corrupt.status.success() && stderr.contains("ignoring the saved update channel"),
        "a corrupt config.toml must not block dscode update, and must be named\nstdout:\n{}\nstderr:\n{stderr}",
        String::from_utf8_lossy(&corrupt.stdout),
    );
}
