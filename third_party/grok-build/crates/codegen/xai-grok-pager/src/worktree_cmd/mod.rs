mod display;

use std::io::Write;

use anyhow::{Result, bail};
use clap::Subcommand;
use xai_fast_worktree::WorktreeRecord;
use xai_grok_workspace::worktree as local;

/// Read the agent's own report types rather than copies, so a field added
/// there cannot go missing here.
pub use xai_fast_worktree::{DbStats, GcReport, KeptWorktree, RebuildReport};

#[derive(Debug, clap::Args, Clone)]
pub struct WorktreeArgs {
    #[command(subcommand)]
    command: WorktreeCommand,
}

#[derive(Debug, Subcommand, Clone)]
enum WorktreeCommand {
    /// List tracked worktrees
    #[command(visible_alias = "ls")]
    List {
        #[arg(long)]
        repo: Option<String>,
        #[arg(long, value_delimiter = ',')]
        r#type: Vec<String>,
        #[arg(long)]
        json: bool,
        #[arg(long)]
        all: bool,
    },
    /// Show details for a specific worktree
    Show { id_or_path: String },
    /// Remove worktrees
    Rm {
        #[arg(required = true)]
        ids: Vec<String>,
        #[arg(short, long)]
        force: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Remove expired worktrees, keeping any whose work would not survive.
    #[command(alias = "prune")]
    Gc {
        /// Report what would be removed without removing it.
        #[arg(long)]
        dry_run: bool,
        /// Expire worktrees idle longer than this, e.g. `7d`. Without it,
        /// nothing expires.
        #[arg(long)]
        max_age: Option<String>,
        /// Skip the live-process and protected-path guards. This does not
        /// override the safety check; use `grok worktree rm` for that.
        #[arg(short, long)]
        force: bool,
    },
    /// Database maintenance
    Db {
        #[command(subcommand)]
        command: WorktreeDbCommand,
    },
}

#[derive(Debug, Subcommand, Clone)]
enum WorktreeDbCommand {
    /// Rebuild DB from filesystem scan
    Rebuild,
    /// Show DB statistics
    Stats,
    /// Print DB file path
    Path,
}

pub async fn run(args: WorktreeArgs) -> Result<()> {
    xai_grok_telemetry::startup::mark_utility_process();
    dispatch(args.command).await
}

async fn run_blocking<T, F>(label: &'static str, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| anyhow::anyhow!("{label} task failed: {error}"))?
}

async fn dispatch(command: WorktreeCommand) -> Result<()> {
    match command {
        WorktreeCommand::List {
            repo,
            r#type,
            json,
            all,
        } => cmd_list(repo, r#type, json, all).await,
        WorktreeCommand::Show { id_or_path } => cmd_show(id_or_path).await,
        WorktreeCommand::Rm {
            ids,
            force,
            dry_run,
        } => cmd_rm(ids, force, dry_run).await,
        WorktreeCommand::Gc {
            dry_run,
            max_age,
            force,
        } => cmd_gc(dry_run, max_age, force).await,
        WorktreeCommand::Db { command } => cmd_db(command).await,
    }
}

fn parse_duration(value: &str) -> Result<i64> {
    let value = value.trim();
    let (number, multiplier) = if let Some(number) = value.strip_suffix('d') {
        (number, 86_400)
    } else if let Some(number) = value.strip_suffix('h') {
        (number, 3_600)
    } else if let Some(number) = value.strip_suffix('m') {
        (number, 60)
    } else if let Some(number) = value.strip_suffix('s') {
        (number, 1)
    } else {
        bail!("invalid duration: {value} (expected e.g. 7d, 24h, 30m, 60s)");
    };
    number
        .parse::<i64>()
        .ok()
        .filter(|number| *number >= 0)
        .and_then(|number| number.checked_mul(multiplier))
        .ok_or_else(|| anyhow::anyhow!("invalid number in duration: {value}"))
}

async fn cmd_list(
    repo: Option<String>,
    types: Vec<String>,
    json: bool,
    all: bool,
) -> Result<()> {
    let records = run_blocking("worktree list", move || {
        local::list_worktrees(repo.as_deref(), &types, all)
    })
    .await?;

    let mut out = std::io::stdout().lock();
    let written = if json {
        display::print_json(&records, &mut out)
    } else {
        display::print_table(&records, &mut out)
    };
    Ok(crate::util::ignore_broken_pipe(written)?)
}

async fn cmd_show(id_or_path: String) -> Result<()> {
    let query = id_or_path.clone();
    let record = run_blocking("worktree show", move || local::show_worktree(&query)).await?;

    match record {
        Some(record) => {
            let written = display::print_show(&record, &mut std::io::stdout().lock());
            Ok(crate::util::ignore_broken_pipe(written)?)
        }
        None => bail!("worktree not found: {id_or_path}"),
    }
}


async fn cmd_rm(ids: Vec<String>, force: bool, dry_run: bool) -> Result<()> {
    let copy_context = local::BackgroundCopyContext::default();
    let mut failures = 0usize;
    for id_or_path in ids {
        let response = local::remove_worktree(
            &local::RemoveWorktreeRequest {
                worktree_path: None,
                id_or_path: Some(id_or_path.clone()),
                force,
                dry_run,
            },
            &copy_context,
        )
        .await;

        match response {
            Ok(response) => {
                let path = response.resolved_path.as_deref().unwrap_or(&id_or_path);
                if dry_run {
                    println!("  would remove: {path}");
                } else if response.removed {
                    println!("  removed: {path}");
                }
            }
            Err(error) => {
                failures += 1;
                eprintln!("  error removing {id_or_path}: {error}");
            }
        }
    }
    if failures == 0 {
        Ok(())
    } else {
        bail!("{failures} worktree removal(s) failed")
    }
}

async fn cmd_gc(dry_run: bool, max_age: Option<String>, force: bool) -> Result<()> {
    let max_age_secs = max_age.as_deref().map(parse_duration).transpose()?;
    let report = run_blocking("worktree gc", move || {
        local::gc_worktrees_mgmt(dry_run, max_age_secs, force)
    })
    .await?;

    let mut out = std::io::stdout().lock();
    let written = (|| {
        if dry_run {
            writeln!(out, "Dry run \u{2014} no changes made.")?;
        }
        display::print_gc(&report, &mut out)
    })();
    Ok(crate::util::ignore_broken_pipe(written)?)
}

async fn cmd_db(command: WorktreeDbCommand) -> Result<()> {
    match command {
        WorktreeDbCommand::Stats => {
            let stats = run_blocking("worktree db stats", local::worktree_db_stats).await?;
            let written = display::print_stats(&stats, &mut std::io::stdout().lock());
            Ok(crate::util::ignore_broken_pipe(written)?)
        }
        WorktreeDbCommand::Path => {
            println!("{}", local::worktree_db_path()?.display());
            Ok(())
        }
        WorktreeDbCommand::Rebuild => {
            let report =
                run_blocking("worktree db rebuild", local::worktree_db_rebuild).await?;
            let written = display::print_rebuild(&report, &mut std::io::stdout().lock());
            Ok(crate::util::ignore_broken_pipe(written)?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_parser_accepts_supported_units() {
        assert_eq!(parse_duration("7d").unwrap(), 7 * 86_400);
        assert_eq!(parse_duration("24h").unwrap(), 24 * 3_600);
        assert_eq!(parse_duration("30m").unwrap(), 30 * 60);
        assert_eq!(parse_duration("60s").unwrap(), 60);
    }

    #[test]
    fn duration_parser_rejects_invalid_or_negative_values() {
        for value in ["", "7", "7x", "-1d", "overflow999999999999999999999d"] {
            assert!(parse_duration(value).is_err(), "{value:?} must fail");
        }
    }
    /// A worktree the gate kept is not one in use, and a path that was never a
    /// repository is not a worktree that was removed.
    #[test]
    fn kept_worktree_prints_apart_from_a_busy_one_and_from_a_removal() {
        let json = r#"{"result": {"dead_removed": 0, "expired_removed": 3, "skipped_alive": 0,
            "kept_unsafe": 2, "no_repo_paths": 1, "kept_reasons": {"dirty": 2},
            "kept": [{"path": "/wt", "reason": "dirty"}], "not_judged": 4, "unnamed": 5}}"#;
        let envelope: serde_json::Value = serde_json::from_str(json).unwrap();
        let report: GcReport = serde_json::from_value(envelope["result"].clone()).unwrap();
        let mut out = Vec::new();
        display::print_gc(&report, &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();

        assert_eq!(
            text.lines().collect::<Vec<_>>(),
            [
                "GC report:",
                "  Dead records removed:      0",
                "  Expired worktrees removed: 3",
                "  Non-repository paths:      1",
                "  Skipped (guarded):         0",
                "  Kept (not reclaimable):    2",
                "    dirty: 2",
                "      /wt  (dirty)",
                "      and 1 more, named in the log",
                "  Not judged this pass:      4",
                "  Naming failed (kept):      5",
            ]
        );
    }

    #[test]
    fn rm_parses_short_force_flag() {
        use clap::Parser;

        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: WorktreeCommand,
        }

        let cli = Cli::parse_from(["test", "rm", "-f", "wt-1"]);
        match cli.command {
            WorktreeCommand::Rm {
                ids,
                force,
                dry_run,
            } => {
                assert!(force);
                assert!(!dry_run);
                assert_eq!(ids, vec!["wt-1"]);
            }
            _ => panic!("expected Rm variant"),
        }
    }

    #[test]
    fn rm_parses_long_force_flag() {
        use clap::Parser;

        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: WorktreeCommand,
        }

        let cli = Cli::parse_from(["test", "rm", "--force", "a", "b"]);
        match cli.command {
            WorktreeCommand::Rm {
                ids,
                force,
                dry_run,
            } => {
                assert!(force);
                assert!(!dry_run);
                assert_eq!(ids, vec!["a", "b"]);
            }
            _ => panic!("expected Rm variant"),
        }
    }

    #[test]
    fn gc_parses_short_force_flag() {
        use clap::Parser;

        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: WorktreeCommand,
        }

        let cli = Cli::parse_from(["test", "gc", "-f"]);
        match cli.command {
            WorktreeCommand::Gc {
                force,
                dry_run,
                max_age,
            } => {
                assert!(force);
                assert!(!dry_run);
                assert!(max_age.is_none());
            }
            _ => panic!("expected Gc variant"),
        }
    }

    #[test]
    fn list_accepts_ls_alias() {
        use clap::Parser;

        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: WorktreeCommand,
        }

        let cli = Cli::parse_from(["test", "ls", "--json"]);
        match cli.command {
            WorktreeCommand::List {
                repo,
                r#type,
                json,
                all,
            } => {
                assert!(repo.is_none());
                assert!(r#type.is_empty());
                assert!(json);
                assert!(!all);
            }
            _ => panic!("expected List variant"),
        }
    }
}
