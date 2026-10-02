import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { hasCodexTranscriptSubagents } from './providers/codex-state'
import { hasKiroSessionLog, isKiroPaneInTool } from './providers/kiro-events'
import { hasMuseSessionLog } from './providers/muse-events'

// Why: D10 — `pending_interaction` lands 28–65 ms after PreToolUse; outside a tool only a cancel can appear.
const KIRO_IN_TOOL_POLL_MS = 250

/** Sources whose transcript poll the schedulers run; a nested CLI of another kind must not clear it. */
export function isTranscriptPollSource(source: AgentHookSource): boolean {
  return source === 'codex' || source === 'muse' || source === 'kiro'
}

/** Per-pane poll delay override; undefined keeps the scheduler default. */
export function transcriptPollDelayMs(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string
): number | undefined {
  return source === 'kiro' && isKiroPaneInTool(state, paneKey) ? KIRO_IN_TOOL_POLL_MS : undefined
}

/** Whether a pane's last hook body should be re-normalized on a timer to pick up transcript-only state. */
export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (source === 'codex') {
    return hasCodexTranscriptSubagents(state, event.paneKey)
  }
  if (source === 'muse') {
    // Why: Muse's question tool fires no hook, so only its session log shows the wait and its answer.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  if (source === 'kiro') {
    // Why: Kiro's approval dialog and Ctrl+C cancel fire no hook; the whole working period needs the poll.
    return event.payload.state !== 'done' && hasKiroSessionLog(state, event.paneKey)
  }
  return false
}

/** Returns the poll result to publish, or undefined when it carries nothing new. */
export function transcriptPollUpdate<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  original: T,
  polled: T
): T | undefined {
  if (source === 'muse' || source === 'kiro') {
    const changed =
      polled.payload.state !== original.payload.state ||
      polled.payload.interactivePrompt !== original.payload.interactivePrompt
    // Why: a replayed UserPromptSubmit body is neither a newly sent prompt nor a turn boundary.
    return changed
      ? { ...polled, hasExplicitPrompt: undefined, hookEventName: undefined }
      : undefined
  }
  const subagentsChanged =
    JSON.stringify(polled.payload.subagents) !== JSON.stringify(original.payload.subagents)
  return subagentsChanged ? polled : undefined
}
