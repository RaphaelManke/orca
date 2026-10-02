import { describe, expect, it, vi } from 'vitest'
import { dropRelayKiroLockedResume } from './kiro-resume-lock-spawn'

const SID = 'sess_fb23f185-e144-4fdb-b729-bd5f8da28feb'
const PLAIN = 'kiro-cli chat --tui --v3'
const RESUME = `${PLAIN} '--resume-id' '${SID}'`
const base = { launchAgent: 'kiro' as const, cwd: '/w', providerDelivered: true, wslShell: false }

describe('dropRelayKiroLockedResume', () => {
  it('rewrites a locked resume to the plain launch', () => {
    expect(dropRelayKiroLockedResume(RESUME, { ...base, readVerdict: () => 'live' })).toBe(PLAIN)
  })

  it('keeps the resume for any non-live verdict', () => {
    for (const verdict of ['stale', 'absent', 'unverifiable'] as const) {
      expect(dropRelayKiroLockedResume(RESUME, { ...base, readVerdict: () => verdict })).toBe(
        RESUME
      )
    }
  })

  it('leaves renderer-delivered, WSL and non-Kiro commands alone', () => {
    const readVerdict = vi.fn(() => 'live' as const)
    expect(
      dropRelayKiroLockedResume(RESUME, { ...base, providerDelivered: false, readVerdict })
    ).toBe(RESUME)
    expect(dropRelayKiroLockedResume(RESUME, { ...base, wslShell: true, readVerdict })).toBe(RESUME)
    expect(dropRelayKiroLockedResume(RESUME, { ...base, launchAgent: 'codex', readVerdict })).toBe(
      RESUME
    )
    expect(readVerdict).not.toHaveBeenCalled()
  })
})
