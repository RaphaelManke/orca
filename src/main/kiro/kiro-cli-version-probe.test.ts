import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  _resetKiroCliVersionForTests,
  invalidateKiroCliVersionStatus,
  readKiroCliVersionStatus
} from './kiro-cli-version-probe'

function result(stdout: string, timedOut = false): unknown {
  return { code: 0, signal: null, stdout, stderr: '', timedOut }
}

describe('readKiroCliVersionStatus', () => {
  beforeEach(() => {
    _resetKiroCliVersionForTests()
    runProcessMock.mockReset()
  })

  it('runs kiro-cli --version and caches a definitive verdict', async () => {
    runProcessMock.mockResolvedValue(result('kiro-cli 2.12.0\n'))
    expect(await readKiroCliVersionStatus()).toEqual({ verdict: 'too-old', version: '2.12.0' })
    expect(await readKiroCliVersionStatus()).toEqual({ verdict: 'too-old', version: '2.12.0' })
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock.mock.calls[0]?.[0]).toMatchObject({
      program: 'kiro-cli',
      args: ['--version']
    })
  })

  it('re-probes after invalidation', async () => {
    runProcessMock.mockResolvedValueOnce(result('kiro-cli 2.12.0'))
    runProcessMock.mockResolvedValueOnce(result('kiro-cli 2.26.1'))
    expect((await readKiroCliVersionStatus()).verdict).toBe('too-old')
    invalidateKiroCliVersionStatus()
    expect((await readKiroCliVersionStatus()).verdict).toBe('supported')
  })

  it('fails open on timeouts and spawn errors without caching', async () => {
    runProcessMock.mockResolvedValueOnce(result('', true))
    runProcessMock.mockRejectedValueOnce(new Error('ENOENT'))
    runProcessMock.mockResolvedValueOnce(result('kiro-cli 2.26.1'))
    expect((await readKiroCliVersionStatus()).verdict).toBe('unknown')
    expect((await readKiroCliVersionStatus()).verdict).toBe('unknown')
    expect((await readKiroCliVersionStatus()).verdict).toBe('supported')
  })
})
