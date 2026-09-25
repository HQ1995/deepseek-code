//! DIVERGENCE(dscode): the quit guard.
//!
//! When a quit double-press arms, the TUI asks the leader
//! `x.ai/client/activity` what quitting now would affect, and the shortcuts
//! bar shows it after "press again to quit": "stops 1 turn, 2 jobs; 1
//! reminder waits for the next open". The leader names every kind with its
//! singular and plural nouns and sorts it into work the quit stops and work
//! that waits for its session to open again; this module only counts,
//! pluralizes and joins. No kind is named here. A slow, failing or old leader
//! leaves today's text, and the second press quits without waiting.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::app::actions::{Action, Effect};
use crate::app::app_view::AppView;

/// How long a quit arm waits for the leader's answer.
pub(crate) const FETCH_TIMEOUT: Duration = Duration::from_millis(500);
/// A quit arm the leader reports work for stays armed at least this long
/// after the answer, so the text can be read and the quit confirmed.
pub(crate) const QUIT_ACTIVITY_TTL: Duration = Duration::from_secs(3);
/// Labels shown per kind; more end in "…".
const SHOWN_LABELS: usize = 2;
/// Characters one label keeps.
const LABEL_CHARS: usize = 48;

/// One kind of work and how many items of it there are, as the leader names it.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default)]
pub struct ActivityCount {
    pub kind: String,
    pub count: u64,
    /// The noun for one item ("job").
    pub one: String,
    /// The noun for several ("jobs").
    pub other: String,
    /// Short labels of some items.
    pub labels: Vec<String>,
}

/// `x.ai/client/activity`: the work quitting would stop, and the work that
/// stays and resumes when its session next opens.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default)]
pub struct ClientActivity {
    pub stops: Vec<ActivityCount>,
    pub waits: Vec<ActivityCount>,
}

/// One line, without control characters, at most [`LABEL_CHARS`] long.
fn one_line(text: &str) -> String {
    let line = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    if line.chars().count() <= LABEL_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(LABEL_CHARS - 1).collect();
    cut.push('\u{2026}');
    cut
}

/// "2 jobs (build, test, …)": the count, the noun for it, and some labels.
fn entry(item: &ActivityCount) -> Option<String> {
    if item.count == 0 {
        return None;
    }
    let noun = one_line(if item.count == 1 {
        &item.one
    } else {
        &item.other
    });
    let noun = if noun.is_empty() {
        one_line(&item.kind)
    } else {
        noun
    };
    let mut text = format!("{} {noun}", item.count);
    let labels: Vec<String> = item
        .labels
        .iter()
        .map(|label| one_line(label))
        .filter(|label| !label.is_empty())
        .collect();
    if !labels.is_empty() {
        let mut shown = labels[..labels.len().min(SHOWN_LABELS)].join(", ");
        if labels.len() > SHOWN_LABELS {
            shown.push_str(", \u{2026}");
        }
        text.push_str(&format!(" ({shown})"));
    }
    Some(text)
}

/// What the quit arm says after its label, or `None` when nothing would be
/// affected.
pub(crate) fn quit_detail(activity: &ClientActivity) -> Option<String> {
    let stops: Vec<String> = activity.stops.iter().filter_map(entry).collect();
    let waits: Vec<String> = activity.waits.iter().filter_map(entry).collect();
    let mut parts = vec![];
    if !stops.is_empty() {
        parts.push(format!("stops {}", stops.join(", ")));
    }
    if !waits.is_empty() {
        let total: u64 = activity.waits.iter().map(|item| item.count).sum();
        let verb = if total == 1 { "waits" } else { "wait" };
        parts.push(format!("{} {verb} for the next open", waits.join(", ")));
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// Keys that tie a reply to the quit arm that asked.
static NEXT_KEY: AtomicU64 = AtomicU64::new(1);

/// After each input event: a quit arm the event installed asks the leader
/// once. The arm itself is unchanged, so a second press still quits at once.
pub(crate) fn arm(app: &mut AppView) {
    let Some(pending) = app.pending_action.as_mut() else {
        return;
    };
    if !matches!(pending.action, Action::Quit)
        || pending.label.is_none()
        || pending.activity_key.is_some()
    {
        return;
    }
    let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
    pending.activity_key = Some(key);
    app.pending_effects
        .push(Effect::FetchClientActivity { key });
}

/// The leader's answer for the quit arm that asked under `key`. Only that arm,
/// still pending, takes it; work to report keeps the arm up long enough to
/// read. A failure or nothing to report leaves the arm as it was.
pub(super) fn loaded(
    app: &mut AppView,
    key: u64,
    result: Result<ClientActivity, String>,
) -> Vec<Effect> {
    let detail = match result {
        Ok(activity) => quit_detail(&activity),
        Err(error) => {
            tracing::debug!("quit guard: client activity unavailable: {error}");
            None
        }
    };
    let Some(detail) = detail else {
        return vec![];
    };
    let Some(pending) = app.pending_action.as_mut() else {
        return vec![];
    };
    if !matches!(pending.action, Action::Quit)
        || pending.activity_key != Some(key)
        || pending.expired()
    {
        return vec![];
    }
    pending.detail = Some(detail);
    pending.expires_at = pending.expires_at.max(Instant::now() + QUIT_ACTIVITY_TTL);
    vec![]
}
