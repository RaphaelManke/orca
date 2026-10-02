import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { record } from '../../codex-rollout-jsonl-cursor'
import { kiroSessionDir } from '../../kiro-session-log'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept, PANE_KEY } from '../../agent-hook-listener-test-harness'
import {
  shouldPollHookTranscript,
  transcriptPollDelayMs,
  transcriptPollUpdate
} from '../transcript-poll-policy'

const FIXTURES = join(__dirname, '..', '..', '__fixtures__')

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Hook payloads in arrival order, keyed by `<event>` or `<event>#<n>` for repeats. */
function hookPayloads(name: string): Map<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const line of fixtureLines(name)) {
    const parsed: unknown = JSON.parse(line)
    const payload = record(record(parsed)?.payload)
    if (!payload) {
      continue
    }
    const event = String(payload.hook_event_name)
    let key = event
    for (let n = 2; byKey.has(key); n++) {
      key = `${event}#${n}`
    }
    byKey.set(key, payload)
  }
  return byKey
}

describe('Kiro transcript-driven waiting and cancel (fixture replay)', () => {
  let state: HookListenerState
  let homeDir: string
  let transcript: string[]
  let written = 0
  let logPath: string

  function useSession(payload: Record<string, unknown>, transcriptFixture: string): void {
    const dir = kiroSessionDir(String(payload.session_id), String(payload.cwd), { homeDir })
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'messages.jsonl')
    transcript = fixtureLines(transcriptFixture)
    written = 0
  }

  /** Writes transcript lines through the `occurrence`-th record of `type`. */
  function writeThrough(type: string, occurrence = 1): void {
    let seen = 0
    let end = transcript.length
    for (let i = 0; i < transcript.length; i++) {
      if (transcript[i].includes(`"type":"${type}"`) && ++seen === occurrence) {
        end = i + 1
        break
      }
    }
    if (seen < occurrence) {
      throw new Error(`transcript has no ${type} #${occurrence}`)
    }
    appendFileSync(
      logPath,
      transcript
        .slice(written, end)
        .map((l) => `${l}\n`)
        .join('')
    )
    written = Math.max(written, end)
  }

  const hook = (payload: Record<string, unknown> | undefined) => {
    if (!payload) {
      throw new Error('missing hook fixture')
    }
    return normalizeAndAccept(state, 'kiro', payload)
  }

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kiro-events-home-'))
    // Why: the reader resolves ~/.kiro through os.homedir(), which reads HOME / USERPROFILE.
    vi.stubEnv('HOME', homeDir)
    vi.stubEnv('USERPROFILE', homeDir)
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('approval: working → waiting with the question and options → working → done', () => {
    const hooks = hookPayloads('kiro-v3-approval-allow-quit-hooks.jsonl')
    useSession(hooks.get('SessionStart')!, 'kiro-transcript-approval-resolved.jsonl')
    writeThrough('turn_start')
    hook(hooks.get('SessionStart'))
    expect(hook(hooks.get('UserPromptSubmit'))?.payload.state).toBe('working')

    const preTool = hook(hooks.get('PreToolUse'))
    expect(preTool?.payload).toMatchObject({ state: 'working', toolName: 'execute_bash' })
    expect(transcriptPollDelayMs(state, 'kiro', PANE_KEY)).toBe(250)
    expect(shouldPollHookTranscript(state, 'kiro', preTool!)).toBe(true)

    // pending_interaction lands after every PreToolUse hook finished; the poll replays that body.
    writeThrough('pending_interaction')
    const polled = hook(hooks.get('PreToolUse'))
    expect(polled?.payload.state).toBe('waiting')
    expect(JSON.parse(polled?.payload.interactivePrompt ?? '')).toEqual({
      approval: {
        tool: 'execute_bash',
        summary: 'touch /tmp/kiro-s0-scratch/approve/a.txt',
        options: [
          { id: 'accept', label: 'Allow' },
          { id: 'always-accept', label: 'Always allow' },
          { id: 'reject', label: 'Deny' },
          { id: 'always-reject', label: 'Always deny' }
        ]
      }
    })
    expect(transcriptPollUpdate('kiro', preTool!, polled!)).toMatchObject({
      payload: { state: 'waiting' },
      hookEventName: undefined
    })
    // An unchanged re-read publishes nothing.
    expect(transcriptPollUpdate('kiro', polled!, hook(hooks.get('PreToolUse'))!)).toBeUndefined()

    writeThrough('interaction_resolved')
    const postTool = hook(hooks.get('PostToolUse'))
    expect(postTool?.payload.state).toBe('working')
    expect(postTool?.payload.interactivePrompt).toBeUndefined()
    expect(transcriptPollDelayMs(state, 'kiro', PANE_KEY)).toBeUndefined()

    const stop = hook(hooks.get('Stop'))
    expect(stop?.payload).toMatchObject({ state: 'done' })
    expect(stop?.payload.interrupted).toBeUndefined()
    expect(shouldPollHookTranscript(state, 'kiro', stop!)).toBe(false)
  })

  it('Ctrl+C in the approval dialog lands on done/interrupted, and the late PostToolUse keeps it', () => {
    const hooks = hookPayloads('kiro-v3-approval-deny-and-ctrlc-in-dialog-hooks.jsonl')
    useSession(
      hooks.get('SessionStart')!,
      'kiro-transcript-approval-denied-and-dialog-cancelled.jsonl'
    )
    // Turn 1: Deny is an ordinary end_turn.
    writeThrough('turn_start')
    hook(hooks.get('UserPromptSubmit'))
    hook(hooks.get('PreToolUse'))
    writeThrough('pending_interaction')
    expect(hook(hooks.get('PreToolUse'))?.payload.state).toBe('waiting')
    writeThrough('interaction_resolved')
    expect(hook(hooks.get('PostToolUse'))?.payload.state).toBe('working')
    expect(hook(hooks.get('Stop'))?.payload.interrupted).toBeUndefined()
    writeThrough('turn_end')

    // Turn 2: Ctrl+C while the dialog is open fires no Stop.
    writeThrough('turn_start', 2)
    expect(hook(hooks.get('UserPromptSubmit#2'))?.payload.state).toBe('working')
    hook(hooks.get('PreToolUse#2'))
    writeThrough('pending_interaction', 2)
    const waiting = hook(hooks.get('PreToolUse#2'))
    expect(waiting?.payload.state).toBe('waiting')
    writeThrough('turn_end', 2)
    const cancelled = hook(hooks.get('PreToolUse#2'))
    expect(cancelled?.payload).toMatchObject({ state: 'done', interrupted: true })
    expect(transcriptPollUpdate('kiro', waiting!, cancelled!)?.payload.state).toBe('done')
    expect(shouldPollHookTranscript(state, 'kiro', cancelled!)).toBe(false)

    const latePost = hook(hooks.get('PostToolUse#2'))
    expect(latePost?.payload).toMatchObject({ state: 'done', interrupted: true })
  })

  it('Ctrl+C mid-tool (no PostToolUse, no Stop) lands on done/interrupted from turn_end', () => {
    const hooks = hookPayloads('kiro-v3-ctrlc-midtool-then-pty-close-hooks.jsonl')
    useSession(hooks.get('SessionStart')!, 'kiro-transcript-cancelled-turn.jsonl')
    writeThrough('turn_start')
    hook(hooks.get('UserPromptSubmit'))
    expect(hook(hooks.get('PreToolUse'))?.payload.state).toBe('working')
    writeThrough('turn_end')
    expect(hook(hooks.get('PreToolUse'))?.payload).toMatchObject({
      state: 'done',
      interrupted: true
    })
  })

  it('a kill with a pending approval: SessionEnd → done, then the late PostToolUse is ignored', () => {
    const hooks = hookPayloads('kiro-v3-pending-then-killed-hooks.jsonl')
    useSession(hooks.get('SessionStart')!, 'kiro-transcript-approval-pending-killed.jsonl')
    writeThrough('turn_start')
    hook(hooks.get('UserPromptSubmit'))
    hook(hooks.get('PreToolUse'))
    writeThrough('pending_interaction')
    expect(hook(hooks.get('PreToolUse'))?.payload.state).toBe('waiting')
    expect(hook(hooks.get('SessionEnd'))?.payload.state).toBe('done')
    expect(hook(hooks.get('PostToolUse'))).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('done')
  })

  it('a new session id in the pane (/chat new) starts a fresh transcript', () => {
    const hooks = hookPayloads('kiro-v3-pending-then-killed-hooks.jsonl')
    const first = hooks.get('UserPromptSubmit')!
    useSession(first, 'kiro-transcript-approval-pending-killed.jsonl')
    writeThrough('pending_interaction')
    hook(first)
    expect(hook(hooks.get('PreToolUse'))?.payload.state).toBe('waiting')

    const next = { ...first, session_id: 'sess_next' }
    useSession(next, 'kiro-transcript-cancelled-turn.jsonl')
    writeThrough('turn_start')
    expect(hook(next)?.payload.state).toBe('working')
    expect(state.kiroPaneStateByPaneKey.get(PANE_KEY)?.log?.sessionId).toBe('sess_next')
  })
})
