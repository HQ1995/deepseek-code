//! Where the leader's tools run. In a remote world (a dscode SSH profile),
//! session paths name files on another machine: nothing may link, open, read,
//! preview or complete them on this computer, and local project configuration
//! does not apply. The world is recorded once from the leader's `initialize`
//! response; one TUI process talks to one leader.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The execution world advertised by the leader.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ExecutionWorld {
    /// Tools run on this computer; session paths are host paths.
    #[default]
    Local,
    /// Tools run on `host`, in `workspace`; session paths are remote.
    Remote { host: String, workspace: String },
}

impl ExecutionWorld {
    /// Whether session paths are remote.
    pub fn is_remote(&self) -> bool {
        matches!(self, Self::Remote { .. })
    }

    /// The remote workspace, when session paths are remote.
    pub fn remote_workspace(&self) -> Option<&str> {
        match self {
            Self::Remote { workspace, .. } => Some(workspace),
            Self::Local => None,
        }
    }

    /// The cwd a session request carries: `requested` locally; in a remote
    /// world `requested` only when it lies in the workspace, else the
    /// workspace itself. A host path is never sent as a remote cwd.
    pub fn session_cwd(&self, requested: &Path) -> PathBuf {
        match self.remote_workspace() {
            None => requested.to_path_buf(),
            Some(workspace) if requested.starts_with(workspace) => requested.to_path_buf(),
            Some(workspace) => PathBuf::from(workspace),
        }
    }
}

static WORLD: OnceLock<ExecutionWorld> = OnceLock::new();

/// Record the leader's world. The first value wins: a process never moves
/// between worlds.
pub fn set_execution_world(world: ExecutionWorld) {
    let _ = WORLD.set(world);
}

/// The recorded world; local until a leader reports otherwise.
pub fn execution_world() -> ExecutionWorld {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(world) = TEST_WORLD.with(|cell| cell.borrow().clone()) {
        return world;
    }
    WORLD.get().cloned().unwrap_or_default()
}

/// Whether session paths are remote in this process.
pub fn is_remote() -> bool {
    execution_world().is_remote()
}

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static TEST_WORLD: std::cell::RefCell<Option<ExecutionWorld>> = const { std::cell::RefCell::new(None) };
}

/// Run `f` on this thread as if the leader had reported `world`.
#[cfg(any(test, feature = "test-support"))]
pub fn with_test_world<R>(world: ExecutionWorld, f: impl FnOnce() -> R) -> R {
    struct Reset(Option<ExecutionWorld>);
    impl Drop for Reset {
        fn drop(&mut self) {
            let previous = self.0.take();
            TEST_WORLD.with(|cell| *cell.borrow_mut() = previous);
        }
    }
    let _reset = Reset(TEST_WORLD.with(|cell| cell.replace(Some(world))));
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_local_and_scopes_the_test_world() {
        assert!(!is_remote());
        let remote = ExecutionWorld::Remote { host: "swoop".into(), workspace: "/srv/w".into() };
        with_test_world(remote.clone(), || {
            assert!(is_remote());
            assert_eq!(execution_world().remote_workspace(), Some("/srv/w"));
        });
        assert!(!is_remote());
    }

    #[test]
    fn session_cwd_keeps_host_paths_out_of_a_remote_world() {
        let local = ExecutionWorld::Local;
        assert_eq!(local.session_cwd(Path::new("/Users/me/p")), PathBuf::from("/Users/me/p"));
        let remote = ExecutionWorld::Remote { host: "swoop".into(), workspace: "/srv/w".into() };
        assert_eq!(remote.session_cwd(Path::new("/srv/w/pkg")), PathBuf::from("/srv/w/pkg"));
        assert_eq!(remote.session_cwd(Path::new("/srv/w")), PathBuf::from("/srv/w"));
        for host_path in ["/Users/me/p", "/srv/wx", "/srv"] {
            assert_eq!(remote.session_cwd(Path::new(host_path)), PathBuf::from("/srv/w"));
        }
    }
}
