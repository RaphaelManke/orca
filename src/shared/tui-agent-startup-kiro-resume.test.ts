import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { dropAgentResumeArgvFromCommand } from './agent-resume-argv-drop'
import { getAgentResumeArgv, isResumableTuiAgent } from './agent-session-resume'

const SESSION = { key: 'session_id' as const, id: 'sess_fb23f185-e144-4fdb-b729-bd5f8da28feb' }

describe('Kiro resume startup plan', () => {
  it('is resumable and resumes by --resume-id', () => {
    expect(isResumableTuiAgent('kiro')).toBe(true)
    expect(getAgentResumeArgv('kiro', SESSION)).toEqual(['kiro-cli', '--resume-id', SESSION.id])
    expect(getAgentResumeArgv('kiro', { key: 'conversation_id', id: 'x' })).toBeNull()
  })

  it('appends only the tail to the V3 base, with YOLO args preserved', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--trust-all-tools',
      platform: 'darwin'
    })
    const command = plan?.launchCommand ?? ''
    expect(command).toMatch(/^kiro-cli chat --tui --v3 /)
    expect(command).toContain('--trust-all-tools')
    expect(command.endsWith(`'--resume-id' '${SESSION.id}'`)).toBe(true)
    expect(command.match(/--v3/g)).toHaveLength(1)
  })

  it('does not add a second engine flag to a user-chosen one', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: SESSION,
      cmdOverrides: { kiro: 'kiro-cli chat --tui --v2' },
      platform: 'linux'
    })
    const command = plan?.launchCommand ?? ''
    expect(command).toContain('--resume-id')
    expect(command.match(/--v[23]\b/g)).toHaveLength(1)
  })

  it.each(['powershell', 'cmd'] as const)('quotes for %s and still drops cleanly', (shell) => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: SESSION,
      cmdOverrides: {},
      platform: 'win32',
      shell
    })
    const command = plan?.launchCommand ?? ''
    expect(command).toContain(SESSION.id)
    const drop = dropAgentResumeArgvFromCommand({
      command,
      agent: 'kiro',
      providerSession: SESSION
    })
    expect(drop.status).toBe('dropped')
    expect(drop.status === 'dropped' && drop.command.includes(SESSION.id)).toBe(false)
  })

  it('drops the posix resume tail back to the plain launch', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--trust-all-tools',
      platform: 'darwin'
    })
    const drop = dropAgentResumeArgvFromCommand({
      command: plan?.launchCommand ?? '',
      agent: 'kiro',
      providerSession: SESSION
    })
    expect(drop).toEqual({
      status: 'dropped',
      command: expect.stringMatching(/^kiro-cli chat --tui --v3 .*--trust-all-tools'?$/)
    })
  })
})
