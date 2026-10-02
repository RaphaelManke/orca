import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  createKiroSessionLogState,
  readKiroSessionLog,
  type KiroPaneState,
  type KiroPendingInteraction
} from '../../kiro-session-log'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { summarizeApprovalInput } from '../interactive-tool'
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

function getKiroPaneState(state: HookListenerState, paneKey: string): KiroPaneState {
  let pane = state.kiroPaneStateByPaneKey.get(paneKey)
  if (!pane) {
    pane = { inTool: false }
    state.kiroPaneStateByPaneKey.set(paneKey, pane)
  }
  return pane
}

/** True while a Kiro pane has a transcript the poll can read (session id and cwd seen). */
export function hasKiroSessionLog(state: HookListenerState, paneKey: string): boolean {
  return state.kiroPaneStateByPaneKey.get(paneKey)?.log !== undefined
}

export function isKiroPaneInTool(state: HookListenerState, paneKey: string): boolean {
  return state.kiroPaneStateByPaneKey.get(paneKey)?.inTool === true
}

// Why: the `{ approval }` envelope plus Kiro's own option labels; parsers that predate `options` ignore it.
function kiroApprovalPrompt(pending: KiroPendingInteraction, toolName: string | undefined): string {
  return JSON.stringify({
    approval: {
      tool: toolName ?? 'tool',
      summary: summarizeApprovalInput({ command: pending.question }),
      options: pending.options.map((option) => ({ id: option.optionId, label: option.name }))
    }
  })
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
// Approval waits and Ctrl+C cancels come from the session transcript, re-read by the poll.
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
  let stateName = readKiroState(eventName, hookPayload)
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

  const pane = getKiroPaneState(state, paneKey)
  const cwd = readString(hookPayload, 'cwd')
  if (sessionId && cwd && pane.log?.sessionId !== sessionId) {
    // Why: /chat new switches the id with no hook of its own (R4.8); the next prompt's hooks carry it.
    pane.log = createKiroSessionLogState(sessionId, cwd)
  }
  pane.inTool = eventName === 'PreToolUse'

  let pending: KiroPendingInteraction | undefined
  let interrupted: true | undefined
  if (stateName !== 'done' && pane.log) {
    // Why: V3 fires no hook for its approval dialog or a Ctrl+C cancel; only the transcript shows them.
    const read = readKiroSessionLog(pane.log)
    if (read.turnEnd?.stopReason === 'cancelled') {
      stateName = 'done'
      interrupted = true
      pane.inTool = false
    } else if (read.pending && stateName === 'working') {
      stateName = 'waiting'
      pending = read.pending
    }
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
    interactivePrompt:
      pending?.interactionType === 'tool_approval'
        ? kiroApprovalPrompt(pending, snapshot.toolName)
        : snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted,
    // Why: SessionStart fires on the first prompt submit, just before UserPromptSubmit; it is a
    // session landing, not a completed turn, so notifications and unread must ignore it.
    ...(eventName === 'SessionStart' ? { sessionBoundary: true } : {})
  })
}
