# Terminal capability handling: Codex CLI, Claude Code, and grok-build

## Scope and source snapshots

This report uses only official repositories/docs, official dependency source, and first-party distributed artifacts.

- **OpenAI Codex CLI:** official `openai/codex` commit [`df6a54ee851129447290b5684b8c2d2df10a5cd5`](https://github.com/openai/codex/tree/df6a54ee851129447290b5684b8c2d2df10a5cd5).
- **Anthropic Claude Code:** official [terminal configuration](https://code.claude.com/docs/en/terminal-config) and [fullscreen](https://code.claude.com/docs/en/fullscreen) docs; installed first-party Linux x64 artifact `2.1.221` at `/home/hanqing/.local/share/claude/versions/2.1.221`, SHA-256 `60db8e88d42c24b5199c92cfd56ec88370c510c3789c6f364af748354f087ada`. Official package metadata: [`@anthropic-ai/claude-code-linux-x64@2.1.221`](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/2.1.221), integrity `sha512-N6PpT3rojCsv2abuA+p7QgNq8HvnMHORt5lI17K3fD6rakzYVjIBLsOmPSNhfl5QA7+b0WjNPWHzbswgZ/9QUQ==`.
- **grok-build:** local git object `600c54b0`, cited as `600c54b0:<path>`. Current dscode fork state is commit `df12232326fa8adedea9ced4c869ece96081fa87` plus uncommitted changes; it is separated from the baseline below.

**Local citation expansion.** Every `600c54b0:...` citation below means the same commit plus the literal prefix `third_party/grok-build/crates/codegen/`. Thus `600c54b0:.../terminal/mod.rs` expands to `600c54b0:third_party/grok-build/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs`; `.../terminal/<file>.rs` uses that same renderer directory; `.../theme/osc11.rs` is `xai-grok-pager-render/src/theme/osc11.rs`; and `.../xai-grok-pager/src/app/<file>.rs` is literal beneath `third_party/grok-build/crates/codegen/`. Bare app references such as `app init_terminal` mean `600c54b0:third_party/grok-build/crates/codegen/xai-grok-pager/src/app/mod.rs`. These expansions are stated so compact matrix cells still resolve to exact git-object paths.

Here, “fail closed” means an uncertain optional capability is not enabled or relied upon. “Fail open” means the base UI continues without the optional result.

## Compact matrix

| Concern | Codex CLI (`df6a54e`) | Claude Code docs / artifact `2.1.221` | grok-build baseline (`600c54b0`) |
|---|---|---|---|
| Identity | Cached `TerminalInfo`: 14 named terminal families plus `Dumb`/`Unknown`; tmux/Zellij recorded separately. Uses `TERM_PROGRAM`, terminal-specific variables, `TERM`, and tmux client queries. [source](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/terminal-detection/src/lib.rs#L16-L64) [detection](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/terminal-detection/src/lib.rs#L290-L472) | Docs expose behavioral terminal tables. The native artifact has env/host helpers for JetBrains, Windows Terminal, Ghostty, mintty, VS Code/xterm.js, SSH, tmux, and screen, but no reviewable typed capability model (artifact offsets `264,235,900–264,237,700`, `265,871,200–265,873,200`). | Cached `TerminalContext` explicitly centralizes terminal, multiplexer, Byobu, editor, SSH, tmux, VTE, and version evidence. Terminal brands cover Apple Terminal, Ghostty, iTerm2, Warp, VS Code-family, WezTerm, Kitty, Alacritty, Rio, foot, JetBrains, Grok Desktop, VTE/Terminator, Windows Terminal, Otty, Unknown; muxes cover tmux, screen, Zellij, cmux, Herdr. (`600c54b0:third_party/grok-build/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs`.) |
| Kitty keyboard | Unless disabled by `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT` or WSL/VS Code gating, Codex optimistically pushes KKP. It later probes whether enhanced keys are supported. Ghostty/iTerm2 and tmux xterm format omit release reporting. [source](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui/keyboard_modes.rs#L20-L201) | Docs guarantee `Ctrl+J` and `\`+Enter fallbacks, list native versus `/terminal-setup` Shift+Enter support, and require tmux extended keys. [docs](https://code.claude.com/docs/en/terminal-config#enter-multiline-prompts) Artifact uses a positive KKP allowlist and emits `CSI < u`, `CSI > 1 u`, plus modifyOtherKeys; no live KKP query was found during minified-artifact inspection, which is not proof of absence. | `kitty_skip_reason` denies known-incompatible terminals, screen, old/misconfigured tmux, and unknown-without-mux. Other cases call crossterm's live support query; only success enables flags. (`600c54b0:.../terminal/mod.rs`, `TerminalContext::kitty_skip_reason`; `600c54b0:.../xai-grok-pager/src/app/mod.rs`, `init_terminal`.) |
| Bracketed paste | Enabled before raw mode, disabled on restore. Startup-probe input is replayed through crossterm, preserving paste/typeahead. [modes](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L233-L253) [replay](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/terminal_probe.rs#L270-L408) | Artifact raw-mode entry enables DEC 2004, exit disables it, and the tokenizer converts `CSI 200~`/`CSI 201~` to paste events (offsets `265,343,700–265,344,100`, `265,874,000–265,877,000`, `266,086,400–266,087,000`). | Enabled with focus tracking in every screen mode; teardown resets paste/mouse/raw state. (`600c54b0:.../xai-grok-pager/src/app/mod.rs`, `init_terminal`, `emit_terminal_teardown_sequences`.) |
| Alternate screen | Inline-first. Full-screen surfaces enter/leave alternate screen; `--no-alt-screen` or setting `Never` disables entry. [lifecycle](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L812-L853) [policy](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/lib.rs#L1780-L1787) | Fullscreen uses alternate buffer and mouse; classic keeps native scrollback. Docs provide persisted choice, env overrides, and fallback to classic after failed starts. [docs](https://code.claude.com/docs/en/fullscreen) Artifact emits DEC 1049 and resets/reapplies mouse/focus/paste/cursor/theme modes (offsets `266,153,800–266,156,000`). | `Auto`: fullscreen except Zellij and tmux control mode. CLI/config can force always/never; minimal is native-scrollback mode. (`600c54b0:.../terminal/mod.rs`, `AltScreenMode`, `determine_alt_screen_policy`.) |
| Mouse / focus | Focus is best-effort enabled on non-Windows and disabled on Windows. No mouse-capture command appears in the pinned Rust TUI tree; alternate-scroll translates wheel behavior. [source](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L233-L253) | Fullscreen captures mouse. Docs expose `CLAUDE_CODE_DISABLE_MOUSE`, click-only disable, tmux `mouse on`, and native-selection modifiers. [docs](https://code.claude.com/docs/en/fullscreen#use-the-mouse) Artifact implements `full`, `scroll`, `off` mouse modes and focus DEC 1004. | Mouse enabled in fullscreen/inline, not minimal; focus enabled in all modes. JetBrains-on-Windows can auto-select minimal because mouse reports can leak as input. (`600c54b0:.../terminal/mod.rs`, `mouse_reporting_leaks_as_raw_text`; app `init_terminal`.) |
| Query latency / input safety | Unix cursor, OSC 10/11, KKP, and DA1 share one **100 ms** startup deadline. Consumed bytes are capped and replayed. No answer becomes conservative defaults. [source](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/terminal_probe.rs#L1-L27) [probe](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/terminal_probe.rs#L321-L408) | Artifact XTVERSION/DECRQM probes are queued asynchronously after raw-mode entry and use DA1 as a sentinel; a silent terminal does not block first render. tmux outer-terminal lookup has a 1 s timeout; multiplexed OSC 11 has a 2 s fallback timeout. Exact direct-query timeout policy is not public. | crossterm KKP can wait 2 s; Alacritty DA2 500 ms; OSC 11 500 ms plus optional 80 ms wrapped retry; each tmux subprocess 2 s. XTVERSION is fire-and-forget and nonblocking. (`600c54b0:.../terminal/{da2,xtversion,tmux_probe,probe}.rs`; `.../theme/osc11.rs`.) |
| Knowledge layout | Identity centralized; capability policy split among detection, probe, keyboard modes, TUI lifecycle, palette, notifications, images, and resize policy. | Public behavior is strong; distributed implementation is minified. Several independent terminal sets/helpers are visible, so maintainership-level policy is scattered/opaque. | Most centralized: `TerminalContext` plus focused `terminal/*` modules. Some decisions remain in app init, appearance, diagnostics, and feature modules. |

## OpenAI Codex CLI evidence

### Identity and startup latency

`codex-terminal-detection` caches `TerminalInfo` in a `OnceLock`. Detection prefers `TERM_PROGRAM`, then terminal-specific markers, then `TERM`, while recording tmux/Zellij independently. Inside tmux it asks for `#{client_termtype}` and `#{client_termname}` so it can recover the outer terminal. [Implementation](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/terminal-detection/src/lib.rs#L290-L472)

Those tmux and Zellij lookups use `Command::output()` with no explicit deadline. Thus the 100 ms terminal-response budget is excellent but does not bound every identity-related startup subprocess.

### KKP has two failure postures

`set_modes` enables bracketed paste and raw mode, then calls `enable_keyboard_enhancement` **before** the support probe. Keyboard writes ignore errors. Activation is therefore optimistic/fail-open: except for explicit disable/WSL-VS Code gating, Codex pushes KKP and continues. [Mode setup](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L233-L253)

The later Unix probe is conservative when declaring support. Cursor, OSC 10/11, KKP status, and DA1 fallback share one 100 ms deadline. DA1 without KKP flags means unsupported immediately; timeout/error yields `None`, and `enhanced_keys_supported` defaults false. Crucially, bytes consumed while probing are replayed through crossterm, so typeahead and incomplete bracketed paste survive. [Probe](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/terminal_probe.rs#L270-L408) [fallback](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L425-L517)

Teardown pops the KKP stack; process exit additionally sends a hard reset, protecting the shell if normal stack restoration was missed. [source](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui/keyboard_modes.rs#L203-L239)

### Screen lifecycle

Codex initializes an inline viewport. Alternate screen is a reversible transition for full-screen surfaces, not a global assumption. Entry/exit save and restore the viewport; external interactive programs pause events, restore modes, and later restore the prior screen. [initialization](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L425-L517) [handoff](https://github.com/openai/codex/blob/df6a54ee851129447290b5684b8c2d2df10a5cd5/codex-rs/tui/src/tui.rs#L724-L765)

Identity is centralized, but resolved capabilities are not: keyboard flags, probing, palette, notifications, image protocol, and screen behavior consume identity separately.

## Anthropic Claude Code evidence

### Official behavioral contract

Anthropic documents `Ctrl+J` and `\`+Enter as universal newline fallbacks, a terminal matrix for native Shift+Enter versus `/terminal-setup`, and tmux requirements (`allow-passthrough`, `extended-keys`, `extkeys`). [Official terminal guide](https://code.claude.com/docs/en/terminal-config)

The fullscreen guide documents alternate-screen rendering as optional/research-preview behavior, mouse capture, tmux caveats including `tmux -CC`, independent mouse/alternate-screen escape hatches, and classic-renderer fallback after failed fullscreen starts. [Official fullscreen guide](https://code.claude.com/docs/en/fullscreen)

These docs are current and can describe features newer than artifact `2.1.221`; they are not used as proof that every current behavior exists in that older binary.

### Limited first-party artifact observations

The ELF embeds a minified, source-like JavaScript bundle. These observations are tied only to the exact path/hash above:

- A helper class detects JetBrains (`TERMINAL_EMULATOR`), Windows Terminal (`WT_SESSION`), Ghostty (`TERM`/`TERM_PROGRAM`), mintty, and VS Code/Windows VT behavior (byte offsets `264,235,900–264,237,100`). Other modules consume `TERM_PROGRAM`, host terminal snapshots, XTVERSION, tmux/screen, SSH, and VS Code markers (`265,871,200–265,873,200`).
- KKP constants are `CSI > 1 u` and `CSI < u`. An allowlist—`iTerm.app`, Kitty, WezTerm, Ghostty, tmux, Windows Terminal, Warp—gates KKP plus modifyOtherKeys mode 2 (`265,343,700–265,344,100`, `266,063,600–266,064,900`). Raw-mode entry writes it and exit resets it (`266,086,400–266,087,000`). No live KKP query was found during inspection, but minification/dynamic construction prevents treating that as proof of absence.
- Raw-mode entry enables bracketed paste, focus, and theme notification. The tokenizer recognizes bracketed paste, SGR mouse, CSI-u keys, DA1/DA2, DECRPM, cursor, OSC, and XTVERSION responses (`265,874,000–265,883,500`).
- A query queue sends XTVERSION and DA1 sentinel asynchronously via `setImmediate`, not awaited by raw-mode entry. tmux outer-terminal lookup uses a 1,000 ms timeout. Synchronized-output probing is conservative and skipped after no XTVERSION answer or on Apple Terminal (`265,829,700–265,832,500`, `266,078,250–266,080,000`).
- Fullscreen mode encodes DEC 1049, DEC 1000/1002/1003/1006 mouse policies, focus, paste, cursor, and theme restoration (`266,062,100–266,063,200`, `266,153,800–266,156,000`).

The artifact does **not** provide stable symbols, types, source files, comments, or line history. Exact ownership, every cancellation path, and full terminal-snapshot precedence are unavailable from readable public first-party source. The offsets above support literals/control flow only and must not be generalized to newer versions.

Claude's public design is fail-open toward usability: portable keys remain, fullscreen and mouse can be disabled, and failed fullscreen startup selects classic mode. Artifact `2.1.221` is optimistic for allowlisted KKP and conservative for synchronized output. Its direct queries are asynchronous, avoiding synchronous startup delay, though no wall-clock cleanup for the direct queue was visible.

## grok-build baseline evidence (`600c54b0`)

### Centralized matrix and conservative KKP

`TerminalContext` combines effective/raw brand, multiplexer, Byobu, embedded editor, SSH/VS Code remote state, `TERM`, tmux metadata/version/options, VTE, and terminal version. It is cached and documented as the source for downstream policy. Detection is deterministic and exposed through pure env-map helpers. (`600c54b0:third_party/grok-build/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs`.)

`kitty_skip_reason` denies VS Code-family, Apple Terminal, VTE, Windows Terminal, JetBrains, GNU screen, tmux before 3.3, tmux with `extended-keys=off`, and unclassified/no-mux terminals. Other environments call crossterm's live support query. Failure or negative response means no push. Success pushes disambiguation and event types, except positively identified broken Alacritty versions omit event types. Actual pushed flags are recorded for feature gates and teardown. (`600c54b0:.../terminal/mod.rs`; `.../terminal/kitty_keyboard.rs`; `600c54b0:.../xai-grok-pager/src/app/mod.rs`, `init_terminal`.)

The lockfile pins crossterm 0.28.1. Its official helper sends KKP status plus DA1 and polls for **2,000 ms**; timeout is an error. [crossterm source](https://github.com/crossterm-rs/crossterm/blob/0.28.1/src/terminal/sys/unix.rs#L181-L255) Baseline maps error to unsupported: capability interpretation is fail-closed, but a classified probe-eligible silent terminal can cost two seconds.

### Probe models and latency

1. **KKP:** synchronous crossterm, up to 2 s.
2. **Alacritty DA2:** synchronous 500 ms, only Alacritty outside CSI-intercepting muxes. (`600c54b0:.../terminal/da2.rs`.)
3. **OSC 11:** synchronous 500 ms bare query, optional 80 ms tmux-wrapped retry. (`600c54b0:.../theme/osc11.rs`.)
4. **tmux evidence:** every subprocess query has a 2 s bound and bounded process-group cleanup. Failure becomes absent evidence. (`600c54b0:.../terminal/tmux_probe.rs`.)
5. **XTVERSION:** fire-and-forget; event loop swallows replies during a five-second arm window, so no answer never blocks startup. (`600c54b0:.../terminal/xtversion.rs`.)

The shared raw-fd reader caps replies and drains partial escape sequences, but explicitly drops keystrokes typed during its read window because it has no reinjection path. (`600c54b0:.../terminal/probe.rs`.) This is the clearest architectural advantage of Codex's replay approach.

### Screen modes and failures

CLI `--no-alt-screen` wins; config can force always/never; auto chooses inline for Zellij and tmux control mode, fullscreen otherwise. Minimal is a third, native-scrollback mode. (`600c54b0:.../terminal/mod.rs`, `AltScreenMode`, `determine_alt_screen_policy`; app `screen_mode_relaunch.rs`.)

`init_terminal` enables raw mode, optional alternate screen, mouse outside minimal, and focus plus bracketed paste everywhere. Required mode-write failures propagate and trigger cleanup. Optional KKP push errors are ignored, while recorded flags govern teardown. Thus ownership setup is fail-closed; optional enhancement is fail-open; reliance on ambiguous enhanced keys is fail-closed.

Knowledge is mostly centralized in `TerminalContext` and `terminal/*`, but app initialization still composes KKP/DA2, appearance owns OSC 11, diagnostics owns more tmux evidence, and features consume brand-specific policy. A single resolved capability snapshot is still missing.

## Baseline versus current dscode fork

At committed fork `df12232326fa8adedea9ced4c869ece96081fa87`, renderer terminal files and the KKP init path remain baseline-equivalent; committed pager changes concern leader startup/fallback and branding. Verified via `git diff 600c54b0..df122323 --` over terminal renderer and pager app paths.

The **uncommitted working tree** now implements the first bounded-probe slice:

- `KittyKeyboardSupport::{Supported, Unsupported, Probe}` and `TerminalContext::kitty_keyboard_support` centralize the KKP policy;
- the workspace pins OpenAI's crossterm fork at `45fecb9508105988f42fe6ff0441783ed3717f92` for replaying bytes consumed by a query;
- `terminal/startup_probe.rs` groups cursor position, KKP status, and DA1 under one 100 ms Unix deadline, then replays interleaved keys, paste, and partial control sequences;
- inline/minimal initialization consumes the probed cursor position (origin on timeout) instead of issuing ratatui/crossterm's separate blocking cursor query;
- deterministic parser, capability-matrix, and PTY tests cover silent WezTerm, Kitty, Ghostty, WezTerm, Zellij, Herdr, Apple Terminal, VTE, VS Code, modern/old tmux policy, and partial input.

This is fork behavior, **not** behavior at `600c54b0`.

## Recommendation for dscode

Adopt grok-build's explicit context, Codex's bounded/replayed probe, and Claude's portable user fallbacks.

1. **Create one immutable `TerminalCapabilities` snapshot.** Separate evidence from decision: terminal/version, mux/version/options, SSH/editor, probe replies. Represent each capability as `Supported`, `Unsupported(reason)`, or `Unknown`, with evidence source. Keyboard, mouse, focus, screen, OSC, notifications, and hints consume only this snapshot.
2. **Replace crossterm's two-second KKP helper with one 100 ms Unix probe group.** Send cursor, KKP status + DA1, and essential color queries under a shared deadline. Replay every consumed byte through the input parser. Keep XTVERSION asynchronous.
3. **Bound, parallelize, and cache mux subprocesses.** tmux version/features/control/extended-key queries should not each receive serial two-second waits. Failure is `Unknown`, never a startup blocker.
4. **Use positive KKP evidence plus narrow deny overrides.** Keep explicit denials for broken xterm.js/VTE/old tmux paths. Never make UI behavior depend on ambiguous modified keys after unknown/timeout. Always retain and advertise classic fallbacks (`Ctrl+J`, `Alt+Enter`, `Ctrl+X`) and exact tmux remediation.
5. **Fail open for usability, closed for interpretation.** Optional capability failure continues in a safe base UI without claiming support. Raw/renderer ownership setup must transactionally restore already-changed modes before returning error. Track what was actually enabled.
6. **Keep screen and mouse independently degradable.** Preserve fullscreen, inline, and native-scrollback/minimal modes; provide separate alternate-screen and mouse opt-outs. Auto-disable/warn for tmux integration/control mode, Zellij conflicts, JediTerm mouse leakage, and remote identity uncertainty.
7. **Expose decisions through `/doctor`.** Show terminal/mux evidence, KKP reply or skip reason, mouse/focus/screen policy, elapsed probe time, and fallback keys.

The current slice removes the two-second KKP and inline-cursor waits. Remaining recommendation work is to fold the separately gated OSC 11/Alacritty DA2 evidence into the same capability snapshot where doing so preserves their narrower applicability, and to expose the resolved evidence through `/doctor`.

## Limitations and unknowns

- Codex findings are pinned to one official `main` commit, not a release binary.
- Claude implementation is not publicly available as stable readable source. Official docs are authoritative for supported behavior; artifact findings are limited to readable literals/control flow in the exact first-party binary. Minified names are not architectural contracts.
- Claude's current docs include behavior introduced after artifact `2.1.221`; this report does not project later docs into the older binary.
- grok-build baseline claims come from exact local git object `600c54b0`; committed and uncommitted fork behavior is separately labeled.
- Codex “no mouse capture” is a pinned-source-tree observation, not a promise about other Codex frontends.
- Focused parser, capability, cursor-constructor, application-decision, and nine-environment PTY tests passed after implementation; a silent Zellij full TUI reached `startup complete` in 817 ms.
