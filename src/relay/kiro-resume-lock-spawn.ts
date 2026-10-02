import type { TuiAgent } from '../shared/tui-agent'
import { dropAgentResumeArgvFromCommand } from '../shared/agent-resume-argv-drop'
import {
  parseKiroResumeId,
  readKiroSessionLockVerdict,
  type KiroSessionLockVerdict
} from '../shared/kiro-session-lock'

/** SSH twin of main's applyKiroResumeLockCheck: the lock and its pid live on this host, so only
 *  the relay can tell a live holder. No notice crosses the wire; the pane just starts fresh. */
export function dropRelayKiroLockedResume(
  command: string | undefined,
  args: {
    launchAgent: TuiAgent | undefined
    cwd: string
    providerDelivered: boolean
    wslShell: boolean
    readVerdict?: (sessionId: string, cwd: string) => KiroSessionLockVerdict
  }
): string | undefined {
  if (!command || args.launchAgent !== 'kiro' || !args.providerDelivered || args.wslShell) {
    return command
  }
  const id = parseKiroResumeId(command)
  if (!id) {
    return command
  }
  const verdict = args.readVerdict
    ? args.readVerdict(id, args.cwd)
    : readKiroSessionLockVerdict({ sessionId: id, cwd: args.cwd })
  if (verdict !== 'live') {
    return command
  }
  const drop = dropAgentResumeArgvFromCommand({
    command,
    agent: 'kiro',
    providerSession: { key: 'session_id', id }
  })
  return drop.status === 'dropped' ? drop.command : command
}
