import { describe, expect, it, vi } from 'vitest'
import { noCodexResumeLaunch, stripSequencedStartupResumeArgv } from './codex-resume'
import { applyKiroResumeLockCheck } from './kiro-resume'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'

const SID = 'sess_fb23f185-e144-4fdb-b729-bd5f8da28feb'
const PLAIN = "kiro-cli chat --tui --v3 '--trust-all-tools'"
const RESUME = `${PLAIN} '--resume-id' '${SID}'`

const base = { launchAgent: 'kiro' as const, cwd: '/w', isWsl: false }

describe('applyKiroResumeLockCheck', () => {
  it('drops --resume-id and asks for the notice when a live process holds the lock', () => {
    const readVerdict = vi.fn(() => 'live' as const)
    const launch = applyKiroResumeLockCheck(noCodexResumeLaunch(RESUME), { ...base, readVerdict })
    expect(readVerdict).toHaveBeenCalledWith(SID, '/w')
    expect(launch).toMatchObject({
      command: PLAIN,
      notifyResumeUnavailable: true,
      droppedResumeArgv: true,
      providerSession: { key: 'session_id', id: SID },
      resumeAgent: 'kiro'
    })
  })

  it.each(['stale', 'absent', 'unverifiable'] as const)('resumes on a %s lock', (verdict) => {
    const launch = noCodexResumeLaunch(RESUME)
    expect(applyKiroResumeLockCheck(launch, { ...base, readVerdict: () => verdict })).toBe(launch)
  })

  it('never reads the lock for SSH, WSL, other agents or a plain launch', () => {
    const readVerdict = vi.fn(() => 'live' as const)
    applyKiroResumeLockCheck(noCodexResumeLaunch(RESUME), {
      ...base,
      connectionId: 'ssh-1',
      readVerdict
    })
    applyKiroResumeLockCheck(noCodexResumeLaunch(RESUME), { ...base, isWsl: true, readVerdict })
    applyKiroResumeLockCheck(noCodexResumeLaunch(RESUME), {
      ...base,
      launchAgent: 'claude',
      readVerdict
    })
    applyKiroResumeLockCheck(noCodexResumeLaunch(PLAIN), { ...base, readVerdict })
    applyKiroResumeLockCheck(noCodexResumeLaunch(undefined), { ...base, readVerdict })
    expect(readVerdict).not.toHaveBeenCalled()
  })

  it('strips the same resume tail from the sequenced startup command', () => {
    const launch = applyKiroResumeLockCheck(noCodexResumeLaunch(RESUME), {
      ...base,
      readVerdict: () => 'live'
    })
    const env = stripSequencedStartupResumeArgv(
      { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: RESUME, KEEP: '1' },
      launch
    )
    expect(env).toEqual({ [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: PLAIN, KEEP: '1' })
  })
})
