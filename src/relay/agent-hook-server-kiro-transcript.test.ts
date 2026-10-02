import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { kiroSessionDir } from '../shared/kiro-session-log'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION_ID = 'sess_kiro-relay-1'
const CWD = '/tmp/kiro-relay-ws'

function record(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ payload })}\n`
}

describe('RelayAgentHookServer Kiro transcript polling', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  // Why: R4.7 — on SSH the relay reads the transcript under the remote user's ~/.kiro.
  it('forwards a Ctrl+C cancel discovered only in the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-kiro-'))
    dirs.push(dir)
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    const sessionDir = kiroSessionDir(SESSION_ID, CWD, { homeDir: dir })
    mkdirSync(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'messages.jsonl')
    writeFileSync(logPath, record({ type: 'turn_start', executionId: 'e1' }))
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/kiro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'sleep 20',
            session_id: SESSION_ID,
            cwd: CWD
          }
        })
      })
      expect(response.status).toBe(204)
      expect(forward.mock.calls[0]?.[0].payload.state).toBe('working')

      appendFileSync(
        logPath,
        record({ type: 'turn_end', stopReason: 'cancelled', executionId: 'e1' })
      )
      await vi.waitFor(
        () => {
          expect(forward.mock.calls.at(-1)?.[0].payload).toMatchObject({
            state: 'done',
            interrupted: true
          })
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })
})
