import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

const DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS = 8000

export function resolveDraftPasteReadyTimeoutMs(agent?: TuiAgent, overrideMs?: number): number {
  return (
    overrideMs ??
    (agent ? TUI_AGENT_CONFIG[agent].draftPasteReadyTimeoutMs : undefined) ??
    DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS
  )
}

// Why: a composer-gated startup prompt is never typed blind, so it outwaits a startup dialog only
// the user may answer (Kiro's trust-all-tools confirm) instead of being dropped.
const STARTUP_COMPOSER_HOLD_MS = 10 * 60_000

/** How long a startup prompt waits for the composer; longer than the paste budget for gated agents. */
export function resolveStartupComposerWaitMs(agent: TuiAgent): number {
  return TUI_AGENT_CONFIG[agent].startupInputNeedsComposer
    ? STARTUP_COMPOSER_HOLD_MS
    : resolveDraftPasteReadyTimeoutMs(agent)
}
