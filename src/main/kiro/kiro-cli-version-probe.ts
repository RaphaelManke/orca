import { runProcess } from '../../shared/child-process/run-process'
import {
  evaluateKiroCliVersionOutput,
  type KiroCliVersionStatus
} from '../../shared/kiro-cli-version'

// Why bounded: `kiro-cli --version` answers instantly; a hang must not gate a launch.
const PROBE_TIMEOUT_MS = 6_000

const UNKNOWN: KiroCliVersionStatus = { verdict: 'unknown', version: null }

let cached: KiroCliVersionStatus | undefined
let inFlight: Promise<KiroCliVersionStatus> | undefined

export function _resetKiroCliVersionForTests(): void {
  cached = undefined
  inFlight = undefined
}

async function probe(command: string): Promise<KiroCliVersionStatus> {
  try {
    const result = await runProcess({
      program: command,
      args: ['--version'],
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (result.timedOut) {
      return UNKNOWN
    }
    return evaluateKiroCliVersionOutput(`${result.stdout}\n${result.stderr}`)
  } catch {
    // Why fail open: a spawn that never ran says nothing about the installed version.
    return UNKNOWN
  }
}

/** The local `kiro-cli` version verdict, probed once per Orca run. */
export function readKiroCliVersionStatus(command = 'kiro-cli'): Promise<KiroCliVersionStatus> {
  if (cached !== undefined) {
    return Promise.resolve(cached)
  }
  inFlight ??= probe(command).then((status) => {
    // Why only cache definitive answers: 'unknown' is usually transient (timeout, PATH not hydrated yet).
    if (status.verdict !== 'unknown') {
      cached = status
    }
    inFlight = undefined
    return status
  })
  return inFlight
}

/** The cached verdict without probing; `unknown` until a probe has answered in this process. */
export function peekKiroCliVersionStatus(): KiroCliVersionStatus {
  return cached ?? UNKNOWN
}

/** Forget the cached verdict so a re-detect after an upgrade re-probes. */
export function invalidateKiroCliVersionStatus(): void {
  cached = undefined
}
