# Kiro CLI integration

How Orca drives Kiro (`kiro-cli`), what it depends on in Kiro's V3 engine, and what to re-check
when Kiro ships a new release. Evidence was recorded against kiro-cli 2.26.1 on macOS.

## V3 engine only

- Launch command: `kiro-cli chat --tui --v3` (`tui-agent-config.ts`). V2 is still Kiro's default
  engine, but only V3 has global hooks and the session store Orca reads.
- `normalizeKiroEngineFlag` (`kiro-launch-command.ts`) skips `--v3` when the argv already has
  `--v3`, `--v2` or `--agent-engine`: Kiro exits 2 on two engine flags. This covers custom
  commands and engine session options.
- Version floor 2.13.0 (`KIRO_CLI_MIN_VERSION`, `kiro-cli-version.ts`): the first release whose
  global `~/.kiro/hooks/` fire in every workspace. `--v3` exists from 2.8; older binaries exit 2.
- The gate is warn-only. `kiro/kiro-cli-version-probe.ts` runs `kiro-cli --version` through
  `runProcess` (6 s timeout, cached per run). A too-old verdict shows a reason in Settings →
  Agents, a toast on launch, and makes the hooks status `not_installed` with an upgrade detail.
  The probe is local only; SSH, WSL and web clients fail open.

## Identity

Process-based. `kiro-cli` is the process-group leader and owns the tty foreground
(`expectedProcess`). `kiro-cli-chat` and `bun …/kiro-cli/tui.js` are recognised as aliases (`bun`
is a static interpreter in `agent-command-line-entrypoint.ts`). A bare `kiro` token is never
matched (#24178). Kiro's `kiro: …` title only appears with the opt-in `chat.terminalTitle`, and is
a hint only, never status. `kiro-cli chat --no-interactive …` is a headless one-shot
(`HEADLESS_ONE_SHOT_MATCHERS`).

## Status: hooks plus transcript poll

```
pane ─ kiro-cli ─ bun tui.js ─ KAS ─► hook cmd ─► kiro-hook.sh / kiro-hook.cmd ─► POST /hook/kiro
                                └──► ~/.kiro/sessions/<cwdHash>/<sid>/messages.jsonl ◄─ poll
shared listener: source-routing → provider-dispatch → providers/kiro-events.ts (+ kiro-session-log.ts)
```

- Hook file: `~/.kiro/hooks/orca-status.json`, Orca's own file (`kiro/hook-service.ts`,
  `kiro-hook-config-json.ts`). User hook and agent files are never touched. Older Orca entries
  for `AgentSpawn` are migrated. Win32 uses `kiro-hook.cmd` (hooks run under `cmd.exe`); remote
  installs over SFTP stay POSIX.
- The script is a no-op without the pane env (`ORCA_PANE_KEY`, `ORCA_AGENT_LAUNCH_TOKEN`,
  `ORCA_AGENT_HOOK_ENDPOINT`), which reaches hooks unchanged through KAS. POSIX reads stdin first
  (#8110). curl is bounded (`--connect-timeout 0.5 --max-time 1.5`): Kiro writes the approval
  prompt only after every `PreToolUse` hook returns.
- Event mapping (`kiro-events.ts`):

| Source                                            | Orca state                                          |
| ------------------------------------------------- | --------------------------------------------------- |
| `SessionStart` (first prompt only)                | done + session boundary                             |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | working, with tool fields                           |
| `Stop`                                            | done                                                |
| `SessionEnd`                                      | done; later hooks for that session are ignored      |
| transcript `pending_interaction` (unresolved)     | waiting + interactive prompt (question and options) |
| transcript `interaction_resolved`                 | working                                             |
| transcript `turn_end {stopReason: "cancelled"}`   | done (Ctrl+C sends no `Stop`)                       |
| process exit (`/quit`)                            | row removed by the generic presence path            |

- `SessionStart` never fires after `--resume-id` or `/chat new`, so the session id is taken from
  any hook's `session_id`. A kill during an approval posts `PostToolUse` after `SessionEnd`;
  `kiroEndedSessionIdsByPaneKey` (last 8 per pane) drops those.
- Transcript path: `sha256(normalize(payload.cwd))[0:16]`; win32 `normalize` lowercases and uses
  `/`. V3 ignores `KIRO_HOME`; the store is under the execution host's `os.homedir()` (the relay's
  on SSH, so no wire change).
- Poll (`transcript-poll-policy.ts`): 250 ms from `PreToolUse` to `PostToolUse`/`Stop`, 1 s
  otherwise while working, off when done. Reads from a byte cursor; a session-id change resets it.
  Measured: `pending_interaction` lands 28–65 ms after `PreToolUse`, `turn_end` ~20 ms after Ctrl+C.
- `session.json` `schemaVersion` guard: an unknown major (today `1`) turns the reader off and
  hides the Vault row. Everything fails soft to hook-only status.

## Readiness and prompt delivery

`kiro-terminal-readiness.ts`, `terminal-wait-detection.ts`, `tui-idle-evidence.ts`, fixtures
`src/main/runtime/__fixtures__/kiro-v3-*.txt`.

- Ready = the empty composer placeholder `› ask a question or describe a task` with nothing busy
  after it (`draftPasteReadySignal: 'kiro-composer-prompt'`). Before that it reads
  `Initializing · type to queue a message`.
- Login is a pre-TUI screen. 2.26.1 has no workspace-trust dialog and no MCP error banner.
- A launch with `--trust-all-tools` (skip-permissions) first shows "Trust all tools mode" with the
  default "No, exit". It is a blocked screen and is never auto-answered. `startupInputNeedsComposer`
  holds the startup prompt up to 10 min for the composer, and drops it if the PTY exits or the
  pane returns to a shell. Orchestration `worker-start` still fails fast on that dialog.

## Resume

- `kiro` is in `RESUMABLE_TUI_AGENTS`; argv `kiro-cli chat --tui --v3 --resume-id <sess_…>`.
  Remote hosts advertise `agent-session.kiro-resume.v1`; older hosts get a plain launch.
- Lock check: `--resume-id` on a session another live process holds hangs on "Session is open in
  another terminal". Before resuming, `<sid>/.lock` `{pid}` is checked on the execution host
  (`host-env/kiro-resume.ts`, relay `kiro-resume-lock-spawn.ts`, `kiro-session-lock.ts`). Only a
  `live` PID blocks: Orca does a plain launch and shows the "started fresh" banner. A stale lock
  is taken over by Kiro; `unverifiable` is not treated as dead.
- Kiro posts no hook on resume, so the resume spawn re-records the session itself
  (`SILENT_RESUME_TUI_AGENTS`), or a second sleep would lose it.

## AI Vault

`session-scanner-kiro-*.ts`, remote source `remote-session-scanner-kiro-source.ts`.

- Discovers `~/.kiro/sessions/<16-hex cwdHash>/sess_*/messages.jsonl`. Skips `cli/` (V2
  `.history`), `_global/` and `.index/`, and never infers V2 sessions.
- `session.json` owns metadata and membership: cloud-sandbox targets and unknown schemas are
  hidden (and kept out of the search index). Scope is by `workspacePaths`/`rootPaths`, with the
  cwd hash as a prefilter. A store with 332 sessions scanned in ~0.3 s cold, 41 ms warm.

## Known limits

- One-click approvals: the sidebar card shows "Needs permission" + tool name, not the question;
  answer in the terminal (Allow = Enter, Deny = Down Down Enter, Esc cancels the turn). No desktop
  surface renders an approval card for agents outside native chat.
- A too-old `kiro-cli` still launches (warn-only gate). The offline `orca agent hooks status` and
  SSH installs don't run the version probe.
- A long foreground `kiro-cli chat --no-interactive` run gets the Kiro icon and can post status.
- The foreground tracker can miss a `kiro-cli` typed after a wake.
- An old remote host rejects a `kiro` Vault search filter with `invalid_argument`.
- Verified in product on macOS only. Linux, Windows, SSH, WSL and folder workspaces have unit
  coverage only.

## Re-check on every Kiro upgrade

1. Re-record the fixtures (`agent-pty-transcript-capture.md`, scrubbed): PTY screens
   (`src/main/runtime/__fixtures__/kiro-v3-*`), hook payloads and transcripts
   (`src/shared/__fixtures__/kiro-*`). Confirm the composer placeholder, the trust-all-tools
   dialog options and the login screen text.
2. Hooks: event names, `session_id`/`cwd` fields, that the pane env still reaches hooks, and that
   no workspace-trust gate disables hooks (KAS already skips hooks in untrusted workspaces).
3. Transcript: record kinds (`pending_interaction`, `interaction_resolved`, `turn_end`), the
   `cwdHash` rule, `.lock` layout, and `session.json` `schemaVersion`. Bump the known major only
   after the reader and Vault parser pass on the new fixtures.
4. Version floor and engine default: whether `--v3` is still needed or V3 became the default,
   and whether `KIRO_CLI_MIN_VERSION` should move.
