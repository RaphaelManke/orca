import { KIRO_COMPOSER_PLACEHOLDER as KIRO_READY_PLACEHOLDER } from '../../shared/draft-paste-ready-scanner'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

// Rows that, painted after the placeholder, mean the composer is no longer idle or a dialog owns
// input: a running turn, the boot queue, the trust-all-tools confirm, an approval or picker.
const KIRO_NOT_READY_ROWS = [
  'kiro is working',
  'initializing · type to queue',
  'trust all tools mode',
  'yes, i accept',
  "let's get you signed in",
  'requires approval',
  '↵ to select'
] as const

function isKiroComposerReadyText(normalized: string): boolean {
  const readyIndex = normalized.lastIndexOf(KIRO_READY_PLACEHOLDER)
  return (
    readyIndex !== -1 &&
    KIRO_NOT_READY_ROWS.every((row) => normalized.lastIndexOf(row) < readyIndex)
  )
}

/**
 * Kiro V3's idle, empty composer. Why the body: Kiro paints no OSC title by default, and its
 * "Trust all tools mode" confirm is as quiet as a ready composer, so silence proves nothing --
 * and Enter there picks the default "No, exit". The screen grid wins; the line tail is the
 * fallback for a pane without one, where the last-painted row decides.
 */
export function isKiroComposerReady(
  screenLines: readonly string[] | null,
  waitText: string
): boolean {
  const text = screenLines ? screenLines.join('\n') : waitText
  return isKiroComposerReadyText(text.toLowerCase())
}

/** Where a Kiro composer (idle or busy) was last painted: a later one dismissed any dialog. */
export function findKiroComposerIndex(normalized: string): number | null {
  const index = Math.max(
    normalized.lastIndexOf(KIRO_READY_PLACEHOLDER),
    normalized.lastIndexOf('kiro is working'),
    normalized.lastIndexOf('initializing · type to queue')
  )
  return index === -1 ? null : index
}

/**
 * Kiro screens that own Enter before (or instead of) the composer. Reasons reuse existing union
 * members, so mixed-version clients need no new vocabulary.
 */
export function findKiroDialogBlockedSignals(
  normalized: string
): { reason: RuntimeTerminalWaitBlockedReason; index: number }[] {
  const candidates: { reason: RuntimeTerminalWaitBlockedReason; index: number }[] = []
  // Why the heading plus the default row: Kiro parks the cursor on the highlighted option, so the
  // line tail ends there and never holds the rows below it (`yes, i accept`, the key footer).
  const trustIndex = normalized.lastIndexOf('trust all tools mode')
  const noExitIndex = normalized.lastIndexOf('no, exit')
  if (trustIndex !== -1 && noExitIndex > trustIndex) {
    candidates.push({ reason: 'agent-interactive-prompt', index: trustIndex })
  } else if (noExitIndex !== -1 && normalized.includes('yes, i accept', noExitIndex)) {
    // Why the option rows alone: on the rendered screen the heading sits 13 rows up, outside the
    // 12-line live window, while the stream tail is blank because Kiro repaints by cursor moves.
    candidates.push({ reason: 'agent-interactive-prompt', index: noExitIndex })
  }
  // Pre-TUI sign-in screen; Enter opens a browser.
  const loginIndex = normalized.lastIndexOf("let's get you signed in")
  if (loginIndex !== -1) {
    candidates.push({ reason: 'agent-interactive-prompt', index: loginIndex })
  }
  const approvalIndex = normalized.lastIndexOf('requires approval')
  // Why the caret: same cursor parking, so the tail stops at `❯ allow`.
  if (approvalIndex !== -1 && normalized.includes('❯', approvalIndex)) {
    candidates.push({ reason: 'agent-approval-prompt', index: approvalIndex })
  }
  return candidates
}
