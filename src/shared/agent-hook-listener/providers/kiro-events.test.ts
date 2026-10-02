import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept, PANE_KEY } from '../../agent-hook-listener-test-harness'

// Real STDIN payloads captured live from kiro-cli 2.25.0 --v3 (standalone .kiro/hooks/*.json).
// Event names are Claude-compatible PascalCase and tool fields are Claude-shaped.
const CWD = '/tmp/ws'
const SESSION_ID = 'sess_kiro-1'
const base = { cwd: CWD, session_id: SESSION_ID }

describe('Kiro hook events (V3)', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('SessionStart lands an idle session boundary', () => {
    const event = normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'SessionStart' })
    expect(event?.payload).toMatchObject({
      agentType: 'kiro',
      state: 'done',
      sessionBoundary: true
    })
  })

  it('ignores legacy AgentSpawn', () => {
    expect(normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'AgentSpawn' })).toBeNull()
  })

  it('SessionEnd reports done', () => {
    normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    const event = normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'SessionEnd' })
    expect(event?.payload).toMatchObject({ agentType: 'kiro', state: 'done' })
  })

  it('a PostToolUse after SessionEnd does not revive the pane (kill with pending approval)', () => {
    normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'shell'
    })
    normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'SessionEnd' })
    const late = normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'shell'
    })
    expect(late).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')
    // A new session id (e.g. /chat new) still drives the pane.
    const next = normalizeAndAccept(state, 'kiro', {
      ...base,
      session_id: 'sess_kiro-2',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'y'
    })
    expect(next?.payload.state).toBe('working')
  })

  it('UserPromptSubmit reports working and carries the prompt', () => {
    const event = normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run ls to list files'
    })
    expect(event?.payload).toMatchObject({
      agentType: 'kiro',
      state: 'working',
      prompt: 'run ls to list files'
    })
  })

  it('PreToolUse reports working with the tool name captured', () => {
    normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run a command'
    })
    const event = normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'execute_bash',
      tool_input: { command: 'ls', description: 'List files' }
    })
    expect(event?.payload).toMatchObject({
      agentType: 'kiro',
      state: 'working',
      prompt: 'run a command',
      toolName: 'execute_bash'
    })
  })

  it('PostToolUse stays working and surfaces the tool response string as tool output', () => {
    normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run a command'
    })
    const event = normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'execute_bash',
      tool_input: { command: 'ls' },
      tool_response: 'Output:\nindex.ts\n\nExit Code: 0'
    })
    expect(event?.payload).toMatchObject({
      agentType: 'kiro',
      state: 'working',
      toolName: 'execute_bash',
      lastAssistantMessage: 'Output:\nindex.ts\n\nExit Code: 0',
      lastAssistantMessageIsToolOutput: true
    })
  })

  it('Stop reports done', () => {
    normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'summarize'
    })
    const event = normalizeAndAccept(state, 'kiro', { ...base, hook_event_name: 'Stop' })
    expect(event?.payload).toMatchObject({ agentType: 'kiro', state: 'done' })
    expect(event?.payload.sessionBoundary).toBeUndefined()
  })

  it('treats an AskUserQuestion PreToolUse as waiting on the user', () => {
    normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask me something'
    })
    const event = normalizeAndAccept(state, 'kiro', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'Which one?' }
    })
    expect(event?.payload.state).toBe('waiting')
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('waiting')
  })
})
