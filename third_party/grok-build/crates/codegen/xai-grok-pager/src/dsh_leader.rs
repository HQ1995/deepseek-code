//! dscode leader bootstrap: resolve and spawn the OFFICIAL dsh CLI as the
//! leader server. This is the Rust replacement for the removed
//! scripts/dscode.sh glue - the TUI binary itself resolves dsh, waits for its
//! socket, and hands off to the normal --leader startup path.
//!
//! Resolution order (mirrors the old shell):
//!   DSH_BIN env -> "dsh" on PATH -> npx on demand.
//! The spawned leader logs to /tmp/dscode.log (DSCODE_LOG
//! overrides); on this host it is wrapped in numactl node-1 pinning when
//! numactl is on PATH (conditional, host policy).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use xai_grok_shell::leader::ConnectionError;

/// Env override naming the dsh executable (first resolution candidate).
pub const DSH_BIN_ENV: &str = "DSH_BIN";
/// Socket path env for the dsh leader (the bridge binds it via
/// cordis.patch.yml: socketPath: process.env.DSCODE_SOCKET).
pub const DSCODE_SOCKET_ENV: &str = "DSCODE_SOCKET";
/// Leader log path env; defaults to /tmp/dscode.log.
pub const DSCODE_LOG_ENV: &str = "DSCODE_LOG";
/// The leader socket path: DSCODE_SOCKET or /tmp/dscode-UID.sock.
pub fn default_leader_socket() -> PathBuf {
    if let Some(socket) = std::env::var_os(DSCODE_SOCKET_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(socket);
    }
    PathBuf::from(format!("/tmp/dscode-{}.sock", uid()))
}

/// The leader log path: DSCODE_LOG or /tmp/dscode.log.
pub fn leader_log_path() -> PathBuf {
    std::env::var_os(DSCODE_LOG_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/dscode.log"))
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

/// The exact dsh npm version this release is tested against.
pub const DSH_NPM_SPEC: &str = "@deepseek-ai/dsh@0.1.0-rc.8";

/// Resolve the dsh argv prefix: DSH_BIN env, "dsh" on PATH, then
/// ["npx", "--yes", DSH_NPM_SPEC]. The env override is authoritative
/// (taken verbatim); spawn failures point at the leader log.
pub fn resolve_dsh_command() -> Result<Vec<OsString>, ConnectionError> {
    if let Some(bin) = std::env::var_os(DSH_BIN_ENV).filter(|v| !v.is_empty()) {
        return Ok(vec![bin]);
    }
    if let Some(dsh) = find_in_path("dsh") {
        return Ok(vec![dsh.into_os_string()]);
    }
    if find_in_path("npx").is_some() {
        return Ok(vec![
            "npx".into(),
            "--yes".into(),
            DSH_NPM_SPEC.into(),
        ]);
    }
    Err(ConnectionError::SpawnFailed(
        "no dsh CLI found: set DSH_BIN, put dsh on PATH, or install npm/npx".into(),
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
    let log_path = leader_log_path();
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| {
            ConnectionError::SpawnFailed(format!(
                "cannot open leader log {}: {e}",
                log_path.display()
            ))
        })?;
    let mut cmd = match find_in_path("numactl") {
        // Host policy (see /home/hanqing/.herdr AGENTS note): keep non-SORT
        // work on NUMA node 1; conditional so other machines drop it cleanly.
        Some(numactl) => {
            let mut c = Command::new(numactl);
            c.arg("--cpunodebind=1").arg("--membind=1").arg(&argv[0]);
            c
        }
        None => Command::new(&argv[0]),
    };
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
    // stores the leader PID for diagnostics and sibling-adoption checks).
    let _ = std::fs::write(sock_path.with_extension("lock"), pid.to_string());
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

    /// Spawn smoke test: a fake DSH_BIN child starts, its stderr lands in the
    /// leader log, and the sibling lock file records the child PID.
    #[serial_test::serial(dsh_leader_env)]
    #[test]
    fn spawn_records_pid_and_log() {
        let _env = crate::test_util::EnvVarGuard::set(DSH_BIN_ENV, "/bin/sh");
        let log = std::env::temp_dir().join(format!("dsh-leader-test-{}.log", std::process::id()));
        let _log_env =
            crate::test_util::EnvVarGuard::set(DSCODE_LOG_ENV, log.to_str().unwrap());
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
}
