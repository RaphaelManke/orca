import { useEffect, useState } from 'react'
import { readKiroCliVersionStatus } from '@/components/terminal-pane/kiro-cli-too-old-notice'

/**
 * Whether the local `kiro-cli` is below Orca's floor. `detectionRevision` re-queries after
 * a re-detect, which also clears main's cached verdict.
 */
export function useKiroCliTooOld(enabled: boolean, detectionRevision: unknown): boolean {
  const [tooOld, setTooOld] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setTooOld(false)
      return
    }
    let cancelled = false
    void readKiroCliVersionStatus().then((status) => {
      if (!cancelled) {
        setTooOld(status.verdict === 'too-old')
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, detectionRevision])
  return tooOld
}
