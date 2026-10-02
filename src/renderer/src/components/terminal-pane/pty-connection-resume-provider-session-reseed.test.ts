import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { UUID_RE } from './pty-connection-test-constants'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const { scheduleRuntimeGraphSync, toastInfo } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  toastInfo: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false)
}))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const paneKey = makePaneKey('tab-1', LEAF_2)

function seedSleepingRecord(agent: 'kiro' | 'codex', sessionId: string): void {
  Object.assign(mockStoreState, {
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
    ptyIdsByTabId: { 'tab-1': [] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    },
    settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent,
        providerSession: { key: 'session_id', id: sessionId },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1
      }
    }
  })
}

async function connect(paneId: number, deps: Record<string, unknown>): Promise<void> {
  const { connectPanePty } = await import('./pty-connection')
  const args = [createPane(paneId), createManager(paneId), deps]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the doubles cover every member connectPanePty reads on the resume path.
  connectPanePty(...(args as unknown as Parameters<typeof connectPanePty>))
}

async function resumeSleepingPane(spawnResult: string | Record<string, unknown>): Promise<void> {
  const spawn = createDeferred<string | Record<string, unknown>>()
  const transport = createMockTransport()
  transport.connect.mockImplementation(() => spawn.promise)
  transportFactoryQueue.push(transport)
  await connect(
    2,
    buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: {}
    })
  )
  await flushAsyncTicks(4)
  spawn.resolve(spawnResult)
  await flushAsyncTicks(10)
}

describe('resume spawn re-records the provider session', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.recordAgentProviderSession = vi.fn()
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('keeps a Kiro session resumable after the resume consumed its record', async () => {
    seedSleepingRecord('kiro', 'sess_kiro_1')
    await resumeSleepingPane('fresh-pty')

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.recordAgentProviderSession).toHaveBeenCalledWith(
      paneKey,
      'kiro',
      { key: 'session_id', id: 'sess_kiro_1' },
      undefined,
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)) }
    )
  })

  it('does not re-record when main declined the resume', async () => {
    seedSleepingRecord('kiro', 'sess_kiro_1')
    await resumeSleepingPane({ id: 'fresh-pty', agentResumeUnavailable: true })

    expect(mockStoreState.recordAgentProviderSession).not.toHaveBeenCalled()
  })

  it('re-records the session a wake tab resumed from its startup', async () => {
    seedSleepingRecord('kiro', 'unrelated')
    mockStoreState.sleepingAgentSessionsByPaneKey = {}
    const spawn = createDeferred<string>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(() => spawn.promise)
    transportFactoryQueue.push(transport)
    await connect(
      1,
      buildPaneConnectionDeps(() => mockStoreState, {
        startup: {
          command: "kiro-cli 'chat' '--tui' '--v3' '--resume-id' 'sess_wake'",
          launchConfig: { agentArgs: '', agentEnv: {} },
          launchToken: 'wake-token',
          launchAgent: 'kiro',
          resumeProviderSession: { key: 'session_id', id: 'sess_wake' }
        }
      })
    )
    await flushAsyncTicks(4)
    spawn.resolve('fresh-pty')
    await flushAsyncTicks(30)

    expect(mockStoreState.recordAgentProviderSession).toHaveBeenCalledWith(
      expect.stringMatching(/^tab-1:/),
      'kiro',
      { key: 'session_id', id: 'sess_wake' },
      undefined,
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { launchToken: 'wake-token' }
    )
  })

  it('leaves agents that report their own session on resume to their hooks', async () => {
    seedSleepingRecord('codex', 'codex-session-1')
    await resumeSleepingPane('fresh-pty')

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.recordAgentProviderSession).not.toHaveBeenCalled()
  })
})
