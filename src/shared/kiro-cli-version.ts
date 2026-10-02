/**
 * Whether the installed `kiro-cli` is new enough for Orca's V3 integration.
 *
 * Floor 2.13: `--v3` exists since 2.8, but global `~/.kiro/hooks/` (where Orca's status
 * hook lives) only fire in every workspace from 2.13 (Kiro changelog).
 */
export const KIRO_CLI_MIN_VERSION = '2.13.0'

/** `unknown` means the probe could not answer; callers must fail open on it. */
export type KiroCliVersionVerdict = 'supported' | 'too-old' | 'unknown'

export type KiroCliVersionStatus = {
  verdict: KiroCliVersionVerdict
  version: string | null
}

// Why anchored: `kiro-cli --version` prints a single `kiro-cli <semver>` line.
const KIRO_CLI_VERSION_RE = /^kiro-cli (\d+)\.(\d+)\.(\d+)/m

type SemverTriple = [number, number, number]

function parseTriple(value: string): SemverTriple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareTriples(left: SemverTriple, right: SemverTriple): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index]
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export function parseKiroCliVersion(output: string): string | null {
  const match = KIRO_CLI_VERSION_RE.exec(output.trim())
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

export function evaluateKiroCliVersionOutput(output: string): KiroCliVersionStatus {
  const version = parseKiroCliVersion(output)
  const parsed = version ? parseTriple(version) : null
  const floor = parseTriple(KIRO_CLI_MIN_VERSION)
  if (!version || !parsed || !floor) {
    return { verdict: 'unknown', version }
  }
  return {
    verdict: compareTriples(parsed, floor) >= 0 ? 'supported' : 'too-old',
    version
  }
}
