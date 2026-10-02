import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { kiroSessionDir } from '../../shared/kiro-session-log'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION_ID = 'sess_kiro-poll-1'
const CWD = '/tmp/kiro-poll-ws'
const EXECUTION_ID = 'exec-1'

function record(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ id: `${String(payload.type)}-1`, payload })}\n`
}

describe('AgentHookServer Kiro transcript polling', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  // Why: Kiro V3 fires no hook for its approval dialog or a Ctrl+C cancel; only the poll sees them.
  it('flips to waiting on a pending approval and to done/interrupted on a cancelled turn', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-hook-kiro-poll-'))
    dirs.push(homeDir)
    vi.stubEnv('HOME', homeDir)
    vi.stubEnv('USERPROFILE', homeDir)
    const sessionDir = kiroSessionDir(SESSION_ID, CWD, { homeDir })
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ schemaVersion: '1.0.0' }))
    const logPath = join(sessionDir, 'messages.jsonl')
    writeFileSync(logPath, record({ type: 'turn_start', executionId: EXECUTION_ID }))

    const server = new AgentHookServer()
    const published: EnrichedAgentHookEventPayload[] = []
    server.setListener((event) => published.push(event))
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const post = (payload: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/kiro`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            payload: { session_id: SESSION_ID, cwd: CWD, ...payload }
          })
        })

      expect((await post({ hook_event_name: 'UserPromptSubmit', prompt: 'touch x' })).status).toBe(
        204
      )
      expect(
        (
          await post({
            hook_event_name: 'PreToolUse',
            tool_name: 'execute_bash',
            tool_input: { command: 'touch x' }
          })
        ).status
      ).toBe(204)
      expect(server.getStatusSnapshot()[0]?.state).toBe('working')

      const pendingAt = Date.now()
      appendFileSync(
        logPath,
        record({
          type: 'pending_interaction',
          interactionType: 'tool_approval',
          toolCallId: 'call-1',
          question: 'touch x',
          options: [{ optionId: 'accept', name: 'Allow', kind: 'allow_once' }],
          executionId: EXECUTION_ID
        })
      )
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')
        },
        { timeout: 3_000, interval: 20 }
      )
      // In-tool poll is 250 ms (D10); allow generous CI slack but catch a fall back to 1 s.
      expect(Date.now() - pendingAt).toBeLessThan(900)
      expect(JSON.parse(server.getStatusSnapshot()[0]?.interactivePrompt ?? '')).toMatchObject({
        approval: { tool: 'execute_bash', summary: 'touch x' }
      })
      expect(published.at(-1)?.hasExplicitPrompt).toBeUndefined()

      appendFileSync(
        logPath,
        record({
          type: 'interaction_resolved',
          toolCallId: 'call-1',
          outcome: 'cancelled',
          executionId: EXECUTION_ID
        }) + record({ type: 'turn_end', stopReason: 'cancelled', executionId: EXECUTION_ID })
      )
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', interrupted: true })
        },
        { timeout: 3_000, interval: 20 }
      )
      expect(server.getStatusSnapshot()[0]?.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('a dead Kiro process retires the row and its transcript cursor', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-hook-kiro-reconcile-'))
    dirs.push(homeDir)
    vi.stubEnv('HOME', homeDir)
    vi.stubEnv('USERPROFILE', homeDir)
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: homeDir })
    try {
      const env = server.buildPtyEnv()
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/kiro`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'x',
            session_id: SESSION_ID,
            cwd: CWD
          }
        })
      })
      expect(server.getStatusSnapshotForPane(PANE_KEY)[0]?.state).toBe('working')
      expect(server._getStateForTests().kiroPaneStateByPaneKey.has(PANE_KEY)).toBe(true)

      expect(server.reconcileEndedProcessForPaneKeys([PANE_KEY])).toBe(1)

      expect(server.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
      expect(server._getStateForTests().kiroPaneStateByPaneKey.has(PANE_KEY)).toBe(false)
    } finally {
      server.stop()
    }
  })
})
