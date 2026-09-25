//! dscode leader bootstrap: resolve and spawn the OFFICIAL dsh CLI as the
//! leader server. This is the Rust replacement for the removed
//! scripts/dscode.sh glue - the TUI binary itself resolves dsh, waits for its
//! socket, and hands off to the normal --leader startup path.
//!
//! Resolution order: DSH_BIN env, then "dsh" on PATH. Release installs always
//! provide DSH_BIN from the managed launcher; the PATH fallback is for
//! developer setups with an already-installed compatible CLI. Starting dsh
//! through npx here is unsafe: the TUI has already entered its alternate
//! screen, and a PATH shim named dsh can recursively invoke itself.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use xai_grok_shell::leader::ConnectionError;

/// Env override naming the dsh executable (first resolution candidate).
pub const DSH_BIN_ENV: &str = "DSH_BIN";
/// Socket path env for the dsh leader (the bridge binds it via
/// cordis.patch.yml: socketPath: process.env.DSCODE_SOCKET).
pub const DSCODE_SOCKET_ENV: &str = "DSCODE_SOCKET";
/// Leader log path env; defaults to the leader socket sibling .log file.
pub const DSCODE_LOG_ENV: &str = "DSCODE_LOG";
/// Explicit socket override, otherwise a profile- and build-specific leader.
pub fn default_leader_socket() -> PathBuf {
    if let Some(socket) = std::env::var_os(DSCODE_SOCKET_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(socket);
    }
    profile_leader_socket(
        &dsh_profile_dir().unwrap_or_else(|| PathBuf::from(".dsh/profiles/dscode")),
        xai_grok_version::full_version(),
    )
}

fn profile_leader_socket(profile: &Path, version: &str) -> PathBuf {
    let canonical = dunce::canonicalize(profile)
        .or_else(|_| std::path::absolute(profile))
        .unwrap_or_else(|_| profile.to_path_buf());
    let mut identity = blake3::Hasher::new();
    identity.update(canonical.as_os_str().as_encoded_bytes());
    identity.update(b"\0");
    identity.update(version.as_bytes());
    let digest = identity.finalize().to_hex();
    PathBuf::from(format!("/tmp/dscode-{}-{}.sock", uid(), &digest[..24]))
}

/// The leader log path: DSCODE_LOG verbatim, else the resolved leader
/// socket sibling .log so the log inherits the socket uid/profile/build
/// segregation instead of sharing one predictable /tmp/dscode.log across
/// every user and profile on a host.
pub fn leader_log_path() -> PathBuf {
    leader_log_path_for(&resolved_leader_socket())
}

/// The log paired with the given socket: DSCODE_LOG wins verbatim,
/// otherwise the sibling .log (/tmp/dscode-UID-DIGEST.sock becomes .log).
fn leader_log_path_for(socket: &Path) -> PathBuf {
    std::env::var_os(DSCODE_LOG_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| socket.with_extension("log"))
}

/// The socket the leader binds: the already-resolved GROK_LEADER_SOCKET
/// override (main sets it from --leader-socket or default_leader_socket),
/// else the profile-derived default.
fn resolved_leader_socket() -> PathBuf {
    std::env::var_os(xai_grok_shell::leader::LEADER_SOCKET_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_leader_socket)
}

/// The recovery hint closing a failed leader start: a plugin bundle or the
/// profile patch is the usual cause, and the launcher's safe mode resets
/// both without removing installed packages.
pub const RESET_PLUGINS_HINT: &str =
    "If a plugin broke startup, run `dscode doctor --reset-plugins`.";

/// The context the TUI adds when the leader did not start or accept the
/// connection: the terminal failure and the leader log tail.
pub fn leader_failure_context(log_path: &Path, tail: &str) -> String {
    format!(
        "The dsh leader failed to start or accept the connection; \
         dscode has no embedded fallback agent.\n\
         Leader log tail ({}):\n{}",
        log_path.display(),
        tail
    )
}

/// A leader start that failed outright (a timeout renders its own report):
/// the context, the cause, then the safe-mode hint as the last line. As an
/// `anyhow` context the hint would print before the cause.
pub fn leader_start_failure(error: &anyhow::Error, log_path: &Path, tail: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "{}\n{error:#}\n{RESET_PLUGINS_HINT}",
        leader_failure_context(log_path, tail)
    )
}

/// Open options for the predictable /tmp leader files: owner-only on create
/// and no symlink following, so a link planted on a shared host cannot
/// redirect leader output or the pid record into another file.
fn tmp_file_options() -> std::fs::OpenOptions {
    #[allow(unused_mut)] // unix-only options below
    let mut options = std::fs::OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options
}

/// Whether this build is running against the dsh backend (the managed dscode
/// launcher sets `DSH_BIN` to the profile-owned dsh CLI). The grok-shell MCP
/// runtime is absent in that backend — the bridge advertises
/// `mcpCapabilities { http: false, sse: false }` and serves no MCP tools — so
/// the standalone `mcp` CLI must not read grok-shell config files the bridge
/// ignores, nor spawn servers the bridge never exposes.
pub fn is_dsh_backend() -> bool {
    std::env::var_os(DSH_BIN_ENV).is_some_and(|v| !v.is_empty())
}

/// The dscode profile directory (`$DSH_HOME/profiles/dscode`, or the
/// public-knob overrides). Mirrors the launcher's `tui_home` resolution in
/// `xai-grok-pager-bin/main.rs`: `DSH_PROFILE_DIR` > `DSCODE_HOME` > `DSC_HOME`
/// > `$DSH_HOME/profiles/dscode` > `~/.dsh/profiles/dscode`.
pub fn dsh_profile_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DSH_PROFILE_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("DSCODE_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("DSC_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    if let Some(home) = std::env::var_os("DSH_HOME").filter(|v| !v.is_empty()) {
        return Some(Path::new(&home).join("profiles").join("dscode"));
    }
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(|h| Path::new(&h).join(".dsh").join("profiles").join("dscode"))
}

/// The profile's user patch layer — the file `/mcp` composes into.
pub fn cordis_patch_path() -> Option<PathBuf> {
    dsh_profile_dir().map(|dir| dir.join("cordis.patch.yml"))
}

#[cfg(unix)]
fn uid() -> u32 {
    // SAFETY: getuid has no failure mode.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn uid() -> u32 {
    0
}

/// Resolve the dsh command: DSH_BIN env, then "dsh" on PATH. The env override
/// is authoritative (taken verbatim); spawn failures point at the leader log.
pub fn resolve_dsh_command() -> Result<Vec<OsString>, ConnectionError> {
    if let Some(bin) = std::env::var_os(DSH_BIN_ENV).filter(|v| !v.is_empty()) {
        return Ok(vec![bin]);
    }
    if let Some(dsh) = find_in_path("dsh") {
        return Ok(vec![dsh.into_os_string()]);
    }
    Err(ConnectionError::SpawnFailed(
        "no dsh CLI found; run dscode through its managed launcher or set DSH_BIN".into(),
    ))
}

/// Spawn "dsh --profile dscode" bound to sock_path, logging to the
/// leader log. Called under the leader flock: the caller owns the socket path,
/// so the stale file is removed here before the fresh leader binds.
/// Returns the child PID (also recorded in the sibling .lock file).
pub fn spawn_dsh_leader(sock_path: &Path) -> Result<u32, ConnectionError> {
    let argv = resolve_dsh_command()?;
    if let Err(e) = std::fs::remove_file(sock_path)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        return Err(ConnectionError::SpawnFailed(format!(
            "failed to remove stale leader socket {}: {e}",
            sock_path.display()
        )));
    }
    let log_path = leader_log_path_for(sock_path);
    let log_file = tmp_file_options()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| {
            ConnectionError::SpawnFailed(format!(
                "cannot open leader log {}: {e}",
                log_path.display()
            ))
        })?;
    let mut cmd = Command::new(&argv[0]);
    // Internal TUI aliases must not become shell-wide settings in dsh tools.
    for (name, _) in std::env::vars_os() {
        if name.as_encoded_bytes().starts_with(b"GROK_") {
            cmd.env_remove(name);
        }
    }
    cmd.args(&argv[1..])
        .arg("--profile")
        .arg("dscode")
        .env(DSCODE_SOCKET_ENV, sock_path)
        .env("DSH_TELEMETRY_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone().map_err(|e| {
            ConnectionError::SpawnFailed(format!("cannot duplicate leader log: {e}"))
        })?))
        .stderr(Stdio::from(log_file));
    #[cfg(unix)]
    {
        // New process group: the leader outlives the TUI (shared-leader model)
        // and must not receive the TUI's terminal signals.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| {
        ConnectionError::SpawnFailed(format!(
            "failed to spawn dsh leader ({}): {e}; log: {}",
            argv[0].to_string_lossy(),
            log_path.display()
        ))
    })?;
    let pid = child.id();
    // Reap without blocking; the leader is intentionally long-lived.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    // Record the leader PID in the sibling lock file (the grok lock contract
    // stores the leader PID for diagnostics and sibling-adoption checks). The
    // /tmp path is predictable, so a planted symlink must not redirect the
    // write into an unrelated file - fail closed and skip the record.
    if let Ok(mut file) = tmp_file_options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(sock_path.with_extension("lock"))
    {
        use std::io::Write as _;
        let _ = write!(file, "{pid}");
    }
    Ok(pid)
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn sockets_isolate_profiles_and_builds_but_preserve_path_aliases() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let alias = root.path().join("alias");
        std::os::unix::fs::symlink(&a, &alias).unwrap();
        let old = profile_leader_socket(&a, "0.0.14-alpha.11");
        assert_eq!(old, profile_leader_socket(&alias, "0.0.14-alpha.11"));
        assert_ne!(old, profile_leader_socket(&b, "0.0.14-alpha.11"));
        assert_ne!(old, profile_leader_socket(&a, "0.0.14-alpha.12"));
        // Both versions can serve clients concurrently without replacing a listener.
        let new = profile_leader_socket(&a, "0.0.14-alpha.12");
        let _old_listener = std::os::unix::net::UnixListener::bind(&old).unwrap();
        let _new_listener = std::os::unix::net::UnixListener::bind(&new).unwrap();
        std::fs::remove_file(old).unwrap();
        std::fs::remove_file(new).unwrap();
    }

    /// Resolution ladder: env override wins verbatim; otherwise the first
    /// executable "dsh" on PATH wins.
    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn resolve_prefers_env_then_path() {
        let _env = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "/explicit/dsh");
        assert_eq!(
            resolve_dsh_command().unwrap(),
            vec![OsString::from("/explicit/dsh")],
            "env override is authoritative"
        );
        let dir = std::env::temp_dir().join(format!("dsh-resolve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("dsh");
        std::fs::write(
            &fake,
            "#!/bin/sh
",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _path = crate::test_util::EnvVarGuard::set("PATH", dir.to_str().unwrap());
        let _env2 = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "");
        assert_eq!(
            resolve_dsh_command().unwrap(),
            vec![fake.into_os_string()],
            "PATH dsh wins when no env override is set"
        );
    }

    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn resolve_does_not_start_dsh_through_npx() {
        let dir = std::env::temp_dir().join(format!("dsh-npx-only-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let npx = dir.join("npx");
        std::fs::write(&npx, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _path = crate::test_util::EnvVarGuard::set("PATH", dir.to_str().unwrap());
        let _env = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "");

        let error = resolve_dsh_command().unwrap_err();
        assert!(
            error.to_string().contains("managed launcher"),
            "missing dsh must fail before the TUI delegates to npx"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Spawn smoke test: a fake DSH_BIN child starts, its stderr lands in the
    /// leader log, and the sibling lock file records the child PID.
    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn spawn_records_pid_and_log() {
        let _env = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "/bin/sh");
        let log = std::env::temp_dir().join(format!("dsh-leader-test-{}.log", std::process::id()));
        let _log_env = crate::test_util::EnvVarGuard::set(DSCODE_LOG_ENV, log.to_str().unwrap());
        let sock =
            std::env::temp_dir().join(format!("dsh-leader-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let pid = spawn_dsh_leader(&sock).unwrap();
        assert!(pid > 0);
        let lock = sock.with_extension("lock");
        assert_eq!(
            std::fs::read_to_string(&lock).unwrap().trim(),
            pid.to_string(),
            "lock file records the dsh leader PID"
        );
        assert!(log.exists(), "leader log was created");
        let _ = std::fs::remove_file(&sock);
        let _ = std::fs::remove_file(&lock);
        let _ = std::fs::remove_file(&log);
    }

    /// The default leader log rides on the resolved socket path so it keeps
    /// the uid/profile/build segregation instead of one shared /tmp file.
    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn leader_log_defaults_to_socket_sibling() {
        let _leader_socket = crate::test_util::EnvVarGuard::set(
            xai_grok_shell::leader::LEADER_SOCKET_ENV,
            "/tmp/dscode-resolved-test.sock",
        );
        let _log_env = crate::test_util::EnvVarGuard::set(DSCODE_LOG_ENV, "");
        assert_eq!(
            leader_log_path(),
            PathBuf::from("/tmp/dscode-resolved-test.log"),
            "default log is the resolved socket sibling"
        );
        let _explicit =
            crate::test_util::EnvVarGuard::set(DSCODE_LOG_ENV, "/tmp/explicit-dscode.log");
        assert_eq!(
            leader_log_path(),
            PathBuf::from("/tmp/explicit-dscode.log"),
            "DSCODE_LOG stays authoritative"
        );
    }

    /// A failed start names the log, shows its tail and the cause, and ends
    /// with exactly one generic safe-mode hint line.
    #[test]
    fn leader_failure_ends_with_the_reset_plugins_hint() {
        let cause = anyhow::anyhow!(
            "Failed to spawn leader: leader process 7 exited before its socket became connectable"
        );
        let report = format!(
            "{:#}",
            leader_start_failure(
                &cause,
                Path::new("/tmp/dscode-1-abc.log"),
                "dsh: skipping profile bundle \"x\"\nError: boom",
            )
        );
        assert!(report.contains("Leader log tail (/tmp/dscode-1-abc.log):\ndsh: skipping"));
        assert!(report.contains("Error: boom\nFailed to spawn leader: leader process 7 exited"));
        assert_eq!(
            report.lines().last().unwrap(),
            "If a plugin broke startup, run `dscode doctor --reset-plugins`."
        );
        assert_eq!(report.matches("--reset-plugins").count(), 1);
        assert!(!leader_failure_context(Path::new("/tmp/l.log"), "").contains("--reset-plugins"));
    }

    /// A symlink planted at the predictable log path must fail closed:
    /// spawn refuses instead of appending leader output into the target.
    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn spawn_refuses_a_symlinked_log() {
        let _env = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "/bin/sh");
        let _log_env = crate::test_util::EnvVarGuard::set(DSCODE_LOG_ENV, "");
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("leader.sock");
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "keep me").unwrap();
        std::os::unix::fs::symlink(&victim, sock.with_extension("log")).unwrap();
        let error = spawn_dsh_leader(&sock).unwrap_err();
        assert!(
            error.to_string().contains("cannot open leader log"),
            "symlinked log must fail closed: {error}"
        );
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me");
    }

    /// The pid record must not follow a planted lock symlink either; the
    /// write is skipped rather than redirected into the target file.
    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn spawn_skips_a_symlinked_lock() {
        let _env = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "/bin/sh");
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("leader.sock");
        let log = dir.path().join("leader.log");
        let _log_env = crate::test_util::EnvVarGuard::set(DSCODE_LOG_ENV, log.to_str().unwrap());
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "keep me").unwrap();
        std::os::unix::fs::symlink(&victim, sock.with_extension("lock")).unwrap();
        let pid = spawn_dsh_leader(&sock).unwrap();
        assert!(pid > 0);
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "keep me",
            "pid write must not follow the planted symlink"
        );
    }
}
