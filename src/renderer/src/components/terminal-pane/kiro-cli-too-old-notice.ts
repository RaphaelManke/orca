import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { KiroCliVersionStatus } from '../../../../shared/kiro-cli-version'

const UNKNOWN_STATUS: KiroCliVersionStatus = { verdict: 'unknown', version: null }

export function readKiroCliVersionStatus(): Promise<KiroCliVersionStatus> {
  // Why swallow: the verdict is advisory and fails open; a failed probe must not block a launch.
  return Promise.resolve()
    .then(() => window.api.preflight.kiroCliVersion())
    .catch(() => UNKNOWN_STATUS)
}

export function getKiroCliTooOldReason(): string {
  return translate(
    'auto.components.terminal.pane.kiro.cli.too.old.reason',
    'Kiro CLI too old (needs ≥ 2.13)'
  )
}

/** Tell the user their `kiro-cli` predates the V3 hooks Orca relies on. */
export async function warnIfKiroCliTooOld(): Promise<void> {
  const status = await readKiroCliVersionStatus()
  if (status.verdict !== 'too-old') {
    return
  }
  toast.error(getKiroCliTooOldReason(), {
    // Why a stable id: several Kiro launches must not stack the same notice.
    id: 'kiro-cli-too-old',
    description: translate(
      'auto.components.terminal.pane.kiro.cli.too.old.description',
      'The kiro-cli on your PATH is {{value0}}. Orca launches Kiro with --v3 and needs 2.13 or newer for status hooks. Run kiro-cli update, then try again.',
      { value0: status.version ?? '?' }
    ),
    duration: 20_000
  })
}
