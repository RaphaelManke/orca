import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Why bounded: /chat new mints a fresh id per use, and every id gets its own SessionEnd at quit.
const MAX_ENDED_SESSION_IDS_PER_PANE = 8

type KiroState = 'working' | 'waiting' | 'done'

function readKiroState(eventName: unknown, hookPayload: Record<string, unknown>): KiroState | null {
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working'
    case 'PreToolUse':
      return isAskUserQuestionTool(readString(hookPayload, 'tool_name')) ? 'waiting' : 'working'
    case 'Stop':
    case 'SessionStart':
    case 'SessionEnd':
      return 'done'
    default:
      // AgentSpawn (pre-V3 Orca installs) and unknown events carry no status.
      return null
  }
}

function hasSessionEnded(state: HookListenerState, paneKey: string, sessionId: string): boolean {
  return state.kiroEndedSessionIdsByPaneKey.get(paneKey)?.includes(sessionId) ?? false
}

function recordSessionEnded(state: HookListenerState, paneKey: string, sessionId: string): void {
  const ended = state.kiroEndedSessionIdsByPaneKey.get(paneKey) ?? []
  if (ended.includes(sessionId)) {
    return
  }
  state.kiroEndedSessionIdsByPaneKey.set(
    paneKey,
    [...ended, sessionId].slice(-MAX_ENDED_SESSION_IDS_PER_PANE)
  )
}

// Kiro CLI V3 fires Claude-compatible PascalCase hooks with Claude-shaped tool fields. It has no
// permission or subagent event (subagent tool hooks carry the lead's session_id), so rows move
// working ⇄ done from hooks; an AskUserQuestion PreToolUse is the only hook-level waiting signal.
export function normalizeKiroEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }
  const stateName = readKiroState(eventName, hookPayload)
  if (!stateName) {
    return null
  }

  const sessionId = readString(hookPayload, 'session_id')
  if (sessionId && hasSessionEnded(state, paneKey, sessionId)) {
    // Why: a kill with a pending approval posts PostToolUse after SessionEnd; an ended session can't revive the pane.
    return null
  }
  if (eventName === 'SessionEnd' && sessionId) {
    recordSessionEnded(state, paneKey, sessionId)
  }

  const resetOnNewTurn = isNewTurnEvent('kiro', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('kiro', eventName, hookPayload),
    { resetOnNewTurn }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'kiro',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // Why: SessionStart fires on the first prompt submit, just before UserPromptSubmit; it is a
    // session landing, not a completed turn, so notifications and unread must ignore it.
    ...(eventName === 'SessionStart' ? { sessionBoundary: true } : {})
  })
}
