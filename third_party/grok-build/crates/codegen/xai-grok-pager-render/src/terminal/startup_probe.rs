//! Bounded startup probes whose consumed input is replayed into crossterm.
//!
//! Optional terminal capabilities must never put seconds on first paint. Unix
//! queries share one deadline; unsupported or silent terminals return unknown
//! evidence. Bytes read while waiting are fed through crossterm's parser, which
//! retains user keys and partial paste/control sequences while dropping the
//! terminal response events already consumed here.

use std::io;
use std::time::Duration;

/// Maximum wall-clock cost of the complete startup query group.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(100);

/// Optional evidence needed before terminal ownership is finalized.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StartupProbeRequest {
    pub cursor_position: bool,
    pub keyboard_enhancement: bool,
}

/// Zero-indexed cursor coordinates, independent of any ratatui version.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CursorPosition {
    pub x: u16,
    pub y: u16,
}

impl CursorPosition {
    pub const ORIGIN: Self = Self { x: 0, y: 0 };

    pub const fn new(x: u16, y: u16) -> Self {
        Self { x, y }
    }
}

/// Evidence returned by the bounded query group. `None` means no conclusive
/// response arrived before the shared deadline.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StartupProbe {
    pub cursor_position: Option<CursorPosition>,
    pub keyboard_enhancement: Option<bool>,
}

/// Probe the requested capabilities under one deadline. On Unix, consumed
/// bytes are replayed into crossterm before returning.
pub fn startup(request: StartupProbeRequest, timeout: Duration) -> io::Result<StartupProbe> {
    #[cfg(unix)]
    {
        let query = query_bytes(request);
        if query.is_empty() || !super::probe::write_query(query) {
            return Ok(StartupProbe::default());
        }
        let Some(response) = super::probe::read_tty_reply(timeout, |buf, _| {
            probe_from_response(buf, request).is_complete(request)
        }) else {
            return Ok(StartupProbe::default());
        };
        replay_and_parse(&response, request, crossterm::event::buffer_input)
    }

    #[cfg(not(unix))]
    {
        let _ = timeout;
        Ok(StartupProbe {
            cursor_position: None,
            keyboard_enhancement: request
                .keyboard_enhancement
                .then(crossterm::terminal::supports_keyboard_enhancement)
                .transpose()?,
        })
    }
}

impl StartupProbe {
    fn is_complete(self, request: StartupProbeRequest) -> bool {
        (!request.cursor_position || self.cursor_position.is_some())
            && (!request.keyboard_enhancement || self.keyboard_enhancement.is_some())
    }
}

#[cfg(unix)]
fn query_bytes(request: StartupProbeRequest) -> &'static [u8] {
    match (request.cursor_position, request.keyboard_enhancement) {
        // KKP status followed by DA1: DA1 without a KKP reply means unsupported.
        (true, true) => b"\x1b[6n\x1b[?u\x1b[c",
        (true, false) => b"\x1b[6n",
        (false, true) => b"\x1b[?u\x1b[c",
        (false, false) => b"",
    }
}

#[cfg(unix)]
fn replay_and_parse(
    response: &[u8],
    request: StartupProbeRequest,
    replay: impl FnOnce(&[u8]) -> io::Result<()>,
) -> io::Result<StartupProbe> {
    let result = probe_from_response(response, request);
    replay(response)?;
    Ok(result)
}

fn probe_from_response(input: &[u8], request: StartupProbeRequest) -> StartupProbe {
    StartupProbe {
        cursor_position: request
            .cursor_position
            .then(|| cursor_position_from_response(input))
            .flatten(),
        keyboard_enhancement: request
            .keyboard_enhancement
            .then(|| keyboard_enhancement_from_response(input))
            .flatten(),
    }
}

/// Parse KKP status (`CSI ? ... u`) and DA1 (`CSI ? ... c`) anywhere in a
/// mixed terminal byte stream. A KKP response wins even if a multiplexer
/// reorders replies; DA1 alone proves that the query was understood but KKP is
/// unsupported.
fn keyboard_enhancement_from_response(input: &[u8]) -> Option<bool> {
    let mut saw_da1 = false;
    let mut index = 0;
    while index < input.len() {
        let params_start = if input.get(index..index + 3) == Some(b"\x1b[?") {
            Some(index + 3)
        } else if input.get(index..index + 2) == Some(b"\x9b?") {
            Some(index + 2)
        } else {
            None
        };
        let Some(mut cursor) = params_start else {
            index += 1;
            continue;
        };
        let first_param = cursor;
        while input
            .get(cursor)
            .is_some_and(|byte| byte.is_ascii_digit() || *byte == b';')
        {
            cursor += 1;
        }
        if cursor == first_param {
            index += 1;
            continue;
        }
        match input.get(cursor).copied() {
            Some(b'u') => return Some(true),
            Some(b'c') => saw_da1 = true,
            _ => {}
        }
        index = cursor.saturating_add(1);
    }
    saw_da1.then_some(false)
}

/// Parse a one-indexed cursor-position report (`CSI row ; column R`) into
/// ratatui's zero-indexed position.
fn cursor_position_from_response(input: &[u8]) -> Option<CursorPosition> {
    let mut index = 0;
    while index < input.len() {
        let mut cursor = if input.get(index..index + 2) == Some(b"\x1b[") {
            index + 2
        } else if input.get(index) == Some(&0x9b) {
            index + 1
        } else {
            index += 1;
            continue;
        };
        if input.get(cursor) == Some(&b'?') {
            cursor += 1;
        }
        let row_start = cursor;
        while input.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == row_start || input.get(cursor) != Some(&b';') {
            index += 1;
            continue;
        }
        let row = std::str::from_utf8(&input[row_start..cursor])
            .ok()?
            .parse::<u16>()
            .ok()?;
        cursor += 1;
        let column_start = cursor;
        while input.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == column_start || input.get(cursor) != Some(&b'R') {
            index += 1;
            continue;
        }
        let column = std::str::from_utf8(&input[column_start..cursor])
            .ok()?
            .parse::<u16>()
            .ok()?;
        if row > 0 && column > 0 {
            return Some(CursorPosition::new(column - 1, row - 1));
        }
        index = cursor + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_unsupported_and_incomplete_replies() {
        assert_eq!(keyboard_enhancement_from_response(b"\x1b[?3u"), Some(true));
        assert_eq!(
            keyboard_enhancement_from_response(b"\x1b[?1;2c"),
            Some(false)
        );
        assert_eq!(keyboard_enhancement_from_response(b"\x1b[?"), None);
        assert_eq!(keyboard_enhancement_from_response(b"ordinary input"), None);
    }

    #[test]
    fn common_kkp_terminal_replies_are_supported() {
        for (terminal, response) in [
            ("Kitty", b"\x1b[?1u".as_slice()),
            ("Ghostty", b"\x1b[?3u".as_slice()),
            ("WezTerm", b"\x1b[?5u".as_slice()),
        ] {
            assert_eq!(
                keyboard_enhancement_from_response(response),
                Some(true),
                "{terminal} KKP reply"
            );
        }
        assert_eq!(DEFAULT_TIMEOUT, Duration::from_millis(100));
    }

    #[test]
    fn parses_cursor_position_among_interleaved_input() {
        assert_eq!(
            cursor_position_from_response(b"draft\x1b[12;34Rtail"),
            Some(CursorPosition::new(33, 11))
        );
        assert_eq!(
            cursor_position_from_response(b"\x9b1;1R"),
            Some(CursorPosition::ORIGIN)
        );
        assert_eq!(cursor_position_from_response(b"\x1b[0;4R"), None);
        assert_eq!(cursor_position_from_response(b"\x1b[12;"), None);
    }

    #[test]
    fn grouped_result_waits_for_every_requested_reply() {
        let both = StartupProbeRequest {
            cursor_position: true,
            keyboard_enhancement: true,
        };
        assert!(!probe_from_response(b"\x1b[4;8R", both).is_complete(both));
        assert!(probe_from_response(b"\x1b[4;8R\x1b[?3u", both).is_complete(both));
    }

    #[test]
    fn kkp_wins_when_responses_are_interleaved_or_reordered() {
        assert_eq!(
            keyboard_enhancement_from_response(b"typed\x1b[?1;2c more\x1b[?5u"),
            Some(true)
        );
        assert_eq!(
            keyboard_enhancement_from_response(b"typed\x9b?5u"),
            Some(true)
        );
    }

    #[cfg(unix)]
    #[test]
    fn replay_receives_every_consumed_byte_including_partial_input() {
        let request = StartupProbeRequest {
            cursor_position: true,
            keyboard_enhancement: true,
        };
        let bytes = b"draft\x1b[200~partial\x1b[9;7R\x1b[?3u";
        let mut replayed = Vec::new();
        let result = replay_and_parse(bytes, request, |input| {
            replayed.extend_from_slice(input);
            Ok(())
        })
        .unwrap();

        assert_eq!(result.cursor_position, Some(CursorPosition::new(6, 8)));
        assert_eq!(result.keyboard_enhancement, Some(true));
        assert_eq!(replayed, bytes);
    }

    #[cfg(unix)]
    #[test]
    fn late_partial_control_sequence_is_replayed_without_claiming_support() {
        let request = StartupProbeRequest {
            cursor_position: true,
            keyboard_enhancement: true,
        };
        let bytes = b"draft\x1b[200~partial\x1b[?";
        let mut replayed = Vec::new();
        let result = replay_and_parse(bytes, request, |input| {
            replayed.extend_from_slice(input);
            Ok(())
        })
        .unwrap();

        assert_eq!(result, StartupProbe::default());
        assert_eq!(replayed, bytes);
    }
}
