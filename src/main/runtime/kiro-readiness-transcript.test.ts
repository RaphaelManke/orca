import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { getTuiAgentRestSignal } from '../../shared/tui-agent-rest-signal'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { isKiroComposerReady } from './kiro-terminal-readiness'
import {
  sendWorktreeStartupFollowupWhenReady,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'
import {
  detectExplicitIdleStatusFromTitle,
  detectTerminalWaitBlockedReason
} from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// kiro-cli 2.26.1 captures; see each `.meta.json` and docs/reference/agent-pty-transcript-capture.md.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

function stripAnsi(data: string): string {
  const esc = String.fromCharCode(27)
  const bel = String.fromCharCode(7)
  return data
    .replace(new RegExp(`${esc}\\][^${bel}]*${bel}`, 'g'), '')
    .replace(new RegExp(`${esc}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '')
}

function draftReadyOffset(data: string, chunkSize: number): number | null {
  const scanner = createDraftPasteReadyScanner('kiro-composer-prompt')
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.slice(offset, offset + chunkSize)
    if (scanner.observe(chunk).ready) {
      return offset + chunk.length
    }
  }
  return null
}

async function tuiIdle(name: string, timeoutMs = 2_000) {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'kiro-cli',
    launchAgent: 'kiro',
    data: fixture(name),
    size: { cols: 120, rows: 40 }
  })
  return runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs })
}

describe('Kiro readiness from captured terminal bytes', () => {
  afterEach(() => vi.useRealTimers())

  it('has a ready-body rest signal, so a quiet foreground cannot settle it', () => {
    expect(getTuiAgentRestSignal('kiro')).toBe('ready-body')
  })

  it.each(['kiro-v3-ready', 'kiro-v3-ready-mcp-failed', 'kiro-v3-trust-all-tools-accepted'])(
    'settles tui-idle on the idle composer in %s',
    async (name) => {
      await expect(tuiIdle(name, 10_000)).resolves.toMatchObject({ satisfied: true })
    },
    15_000
  )

  it('reports the trust-all-tools confirm as blocked and never settles on it', async () => {
    const wait = await tuiIdle('kiro-v3-trust-all-tools-dialog')
    expect(wait).toMatchObject({ satisfied: false, blockedReason: 'agent-interactive-prompt' })
  })

  it('reports the pre-TUI login screen as blocked', async () => {
    const wait = await tuiIdle('kiro-v3-login-required')
    expect(wait).toMatchObject({ satisfied: false, blockedReason: 'agent-interactive-prompt' })
  })

  it('reports a pending tool approval as blocked', async () => {
    const wait = await tuiIdle('kiro-v3-approval-pending')
    expect(wait).toMatchObject({ satisfied: false, blockedReason: 'agent-approval-prompt' })
  })

  it('never settles on a resume that stays on Initializing (locked session)', async () => {
    await expect(tuiIdle('kiro-v3-resume-locked', 1_000)).rejects.toThrow(/timeout/)
  })

  it('reports the trust confirm as blocked on the rendered screen, heading outside the live window', () => {
    // Rendered rows from an in-product `--trust-all-tools` pane: the heading is 13 rows up.
    const rule = '─'.repeat(118)
    const screen = [
      ' Warning: Kiro is running in trust all tools mode',
      ` ${rule}`,
      ' In this mode, Kiro will execute all tool calls — including shell commands, file operations, and MCP tools — without',
      ' asking for your approval.',
      ' This mode is intended for sandboxed or disposable environments only. Do not use it on a machine with access to',
      ' sensitive data or production systems.',
      ' By proceeding, you confirm that you understand the risks and accept responsibility for all actions taken during this',
      ' session.',
      ' ❯ No, exit',
      '   Yes, I accept',
      "   Yes, and don't ask again",
      ` ${rule}`,
      '  esc to cancel · ↑↓ to navigate · ↵ to select'
    ].join('\n')
    expect(detectTerminalWaitBlockedReason(screen)).toBe('agent-interactive-prompt')
    expect(isKiroComposerReady(screen.split('\n'), screen)).toBe(false)
  })

  it('accepts the trust confirm as dismissed once the composer follows it', () => {
    const tail = stripAnsi(fixture('kiro-v3-trust-all-tools-accepted'))
    expect(detectTerminalWaitBlockedReason(tail)).toBeNull()
    expect(isKiroComposerReady(null, tail)).toBe(true)
  })

  it('reads the line tail by its last-painted row when no screen is available', () => {
    expect(isKiroComposerReady(null, stripAnsi(fixture('kiro-v3-ready')))).toBe(true)
    // The placeholder was painted before the turn; the working row and dialog came later.
    expect(isKiroComposerReady(null, stripAnsi(fixture('kiro-v3-approval-pending')))).toBe(false)
    expect(isKiroComposerReady(null, stripAnsi(fixture('kiro-v3-resume-locked')))).toBe(false)
  })

  it.each([1, 7, 64, 4096])(
    'fires the draft signal at the placeholder in %i-byte chunks',
    (size) => {
      const data = fixture('kiro-v3-ready')
      const placeholderEnd = data.indexOf('ask a question or describe a task') + 33
      const readyAt = draftReadyOffset(data, size)
      expect(readyAt).not.toBeNull()
      expect(readyAt!).toBeGreaterThanOrEqual(placeholderEnd)
      expect(readyAt!).toBeLessThan(placeholderEnd + size)
    }
  )

  it.each(['kiro-v3-trust-all-tools-dialog', 'kiro-v3-login-required', 'kiro-v3-resume-locked'])(
    'never fires the draft signal or its quiet window on %s',
    (name) => {
      const scanner = createDraftPasteReadyScanner('kiro-composer-prompt')
      expect(scanner.observe(fixture(name))).toEqual({ ready: false, armQuietTimer: false })
    }
  )
})

describe('Kiro opt-in chat.terminalTitle', () => {
  // Formats from kiro-cli 2.26.1 tui.js: resting `kiro: <title>`, working `<frame> kiro: <title>`
  // with quarterSpinner frames ◐◓◑◒ (ASCII - \ | / on limited terminals); resting during approvals.
  it('reads the spinner as working and never reads the resting title as idle', () => {
    for (const frame of ['◐', '◓', '◑', '◒']) {
      expect(detectAgentStatusFromTitle(`${frame} kiro: fix the build`)).toBe('working')
    }
    for (const title of ['kiro: fix the build', '- kiro: ws', '| kiro: ws']) {
      expect(detectAgentStatusFromTitle(title)).toBeNull()
      expect(detectExplicitIdleStatusFromTitle(title)).toBeNull()
    }
  })
})

describe('Kiro typed startup prompt', () => {
  afterEach(() => vi.useRealTimers())

  function host(replay: string) {
    let listener = (_data: string): void => {}
    let onExit = (): void => {}
    let foreground = 'kiro-cli'
    const write = vi.fn()
    const readinessHost: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => foreground,
      subscribeToData: (_ptyId, onData) => {
        listener = onData
        return () => {}
      },
      readRecentOutput: () => replay,
      subscribeToExit: (_ptyId, listener) => {
        onExit = listener
        return () => {}
      },
      write
    }
    return {
      readinessHost,
      write,
      emit: (data: string) => listener(data),
      exitPty: () => onExit(),
      returnToShell: () => {
        foreground = 'zsh'
      }
    }
  }

  function sendFixIt(h: ReturnType<typeof host>): void {
    sendWorktreeStartupFollowupWhenReady(h.readinessHost, 'term-1', {
      expectedProcess: 'kiro-cli',
      prompt: 'fix it',
      agent: 'kiro'
    })
  }

  it('waits out the trust-all-tools confirm and types only into the composer', async () => {
    vi.useFakeTimers()
    const accepted = fixture('kiro-v3-trust-all-tools-accepted')
    const splitAt = accepted.indexOf('ask a question or describe a task')
    const h = host(accepted.slice(0, splitAt))
    sendFixIt(h)
    await vi.advanceTimersByTimeAsync(5_000)
    // Why: the replay holds the whole dialog; a write here would pick "No, exit".
    expect(h.write).not.toHaveBeenCalled()
    h.emit(accepted.slice(splitAt))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.write).toHaveBeenCalledWith('pty-1', 'fix it\r', 'launch')
  })

  it('holds the prompt past the paste budget until the dialog is accepted', async () => {
    vi.useFakeTimers()
    const accepted = fixture('kiro-v3-trust-all-tools-accepted')
    const splitAt = accepted.indexOf('ask a question or describe a task')
    const h = host(accepted.slice(0, splitAt))
    sendFixIt(h)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.write).not.toHaveBeenCalled()
    h.emit(accepted.slice(splitAt))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.write).toHaveBeenCalledWith('pty-1', 'fix it\r', 'launch')
  })

  it('drops the prompt with a warning when the hold expires', async () => {
    vi.useFakeTimers()
    const h = host(fixture('kiro-v3-trust-all-tools-dialog'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sendFixIt(h)
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5_000)
    expect(h.write).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('startup prompt hold expired'))
    expect(warn).toHaveBeenCalledWith(
      '[worktree-create] agent did not become ready for follow-up prompt'
    )
    warn.mockRestore()
  })

  it.each([
    ['the PTY exits', (h: ReturnType<typeof host>) => h.exitPty()],
    ['the agent returns the pane to its shell', (h: ReturnType<typeof host>) => h.returnToShell()]
  ])('stops holding when %s', async (_case, end) => {
    vi.useFakeTimers()
    const accepted = fixture('kiro-v3-trust-all-tools-accepted')
    const splitAt = accepted.indexOf('ask a question or describe a task')
    const h = host(accepted.slice(0, splitAt))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sendFixIt(h)
    await vi.advanceTimersByTimeAsync(5_000)
    end(h)
    await vi.advanceTimersByTimeAsync(5_000)
    h.emit(accepted.slice(splitAt))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.write).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[worktree-create] agent did not become ready for follow-up prompt'
    )
    warn.mockRestore()
  })
})
