import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { dropAgentResumeArgvFromCommand } from '../../../../shared/agent-resume-argv-drop'
import {
  parseKiroResumeId,
  readKiroSessionLockVerdict,
  type KiroSessionLockVerdict
} from '../../../../shared/kiro-session-lock'
import type { CodexResumeLaunch } from './codex-resume'

export type KiroResumeLockCheckArgs = {
  connectionId?: string | null
  launchAgent?: TuiAgent
  cwd: string | undefined
  /** The lock lives in the guest's ~/.kiro and its pid in the guest's table; main can see neither. */
  isWsl: boolean
  readVerdict?: (sessionId: string, cwd: string | undefined) => KiroSessionLockVerdict
}

/** Why: `--resume-id` on a session another live kiro-cli holds hangs on "Session is open in
 *  another terminal" (Stage 0 row 9), so a provably live holder turns the resume into a plain
 *  launch with the existing started-fresh notice. Synchronous so the spawn adds no tick. */
export function applyKiroResumeLockCheck(
  launch: CodexResumeLaunch,
  args: KiroResumeLockCheckArgs
): CodexResumeLaunch {
  const command = launch.command
  if (args.connectionId || args.launchAgent !== 'kiro' || args.isWsl || !command) {
    return launch
  }
  const commandId = parseKiroResumeId(command)
  if (!commandId) {
    return launch
  }
  // Why: the command, not the renderer's metadata, is what will actually run.
  const providerSession: AgentProviderSessionMetadata = { key: 'session_id', id: commandId }
  const readVerdict =
    args.readVerdict ??
    ((sessionId: string, cwd: string | undefined) => readKiroSessionLockVerdict({ sessionId, cwd }))
  if (readVerdict(commandId, args.cwd) !== 'live') {
    return launch
  }
  const drop = dropAgentResumeArgvFromCommand({ command, agent: 'kiro', providerSession })
  if (drop.status !== 'dropped') {
    return launch
  }
  return {
    ...launch,
    command: drop.command,
    notifyResumeUnavailable: true,
    droppedResumeArgv: true,
    providerSession,
    resumeAgent: 'kiro'
  }
}
