import {
  inspectRuntimeTerminalProcess,
  isRemoteRuntimePtyId,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { subscribeToPtyExit } from '@/components/terminal-pane/pty-dispatcher'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveStartupComposerWaitMs } from '../../../shared/draft-paste-ready-timeout'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'

type RuntimeOwnerSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

const AGENT_EXIT_POLL_MS = 3000

// Why: a held startup prompt must not outlive its agent ("No, exit" leaves a live shell).
function watchAgentLeavingPane(
  ptyId: string,
  settings: RuntimeOwnerSettings,
  onLeft: () => void
): () => void {
  const unsubscribeExit = isRemoteRuntimePtyId(ptyId) ? null : subscribeToPtyExit(ptyId, onLeft)
  const poll = globalThis.setInterval(() => {
    void inspectRuntimeTerminalProcess(settings, ptyId)
      .then((process) => {
        if (process.foregroundProcess && isShellProcess(process.foregroundProcess)) {
          onLeft()
        }
      })
      .catch(() => {})
  }, AGENT_EXIT_POLL_MS)
  return () => {
    unsubscribeExit?.()
    globalThis.clearInterval(poll)
  }
}

export async function sendFollowupPromptWhenAgentReady(args: {
  ptyId: string
  expectedProcess: string
  prompt: string
  settings: RuntimeOwnerSettings
  agent?: TuiAgent
}): Promise<boolean> {
  const { ptyId, expectedProcess, prompt, settings, agent } = args
  const config = agent ? TUI_AGENT_CONFIG[agent] : null
  const holdEnded = new AbortController()
  // Why subscribe before the foreground poll: the composer can paint while that poll runs.
  const composerReady =
    agent && config?.startupInputNeedsComposer && config.draftPasteReadySignal
      ? waitForAgentDraftInputReady(
          ptyId,
          resolveStartupComposerWaitMs(agent),
          config.draftPasteReadySignal,
          settings,
          holdEnded.signal
        )
      : null
  if (!(await waitForAgentForeground(ptyId, expectedProcess, settings))) {
    holdEnded.abort()
    return false
  }
  if (composerReady) {
    const stopWatching = watchAgentLeavingPane(ptyId, settings, () => holdEnded.abort())
    const ready = await composerReady
    stopWatching()
    if (!ready) {
      if (!holdEnded.signal.aborted) {
        console.warn('[agent-followup] startup prompt hold expired without a ready composer')
      }
      return false
    }
  }
  try {
    return await sendRuntimePtyInputVerified(settings, ptyId, `${prompt}\r`, 'launch')
  } catch {
    return false
  }
}

// Why: delayed follow-ups must not type into an arbitrary shell. Require a
// positive readiness signal before writing user/task text to the PTY.
async function waitForAgentForeground(
  ptyId: string,
  expectedProcess: string,
  settings: RuntimeOwnerSettings
): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    try {
      const process = await inspectRuntimeTerminalProcess(settings, ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
      // Why: interpreter-wrapped agents (aider, mistral-vibe are pip console
      // scripts) surface a python/node foreground comm, so the exact-name check
      // never matches — locally when the ps-table resolver can't pin the child,
      // and over SSH when the relay falls back to the bare interpreter name. If
      // the foreground is a known agent wrapper (not a shell) with a live
      // non-shell child, the agent has taken over the PTY and can accept input.
      if (
        attempt >= 4 &&
        isAgentForegroundWrapperProcess(foreground) &&
        !isShellProcess(foreground) &&
        process.hasChildProcesses
      ) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return false
}
