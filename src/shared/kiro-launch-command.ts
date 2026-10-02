import { optionName } from './print-mode-headless-command'

/** Kiro's V3 opt-in flag; `chat` and top-level `kiro-cli` both accept it since 2.8. */
export const KIRO_V3_FLAG = '--v3'

// Why all three: Kiro rejects any combination of them with exit code 2 (clap conflict),
// even `--v3 --agent-engine v3`, so one present means Orca must not add another.
const KIRO_ENGINE_FLAGS = new Set(['--agent-engine', '--v2', KIRO_V3_FLAG])

function hasKiroEngineFlag(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (token === '--') {
      return false
    }
    if (KIRO_ENGINE_FLAGS.has(optionName(token))) {
      return true
    }
  }
  return false
}

/**
 * Make a Kiro launch command select exactly one engine, defaulting to V3.
 *
 * `commandTokens` is the base command (default or user override); `trailingTokens` are
 * agent args and session-option args appended after it. The default base already ends
 * in `--v3`, so it is dropped when a trailing token picks the engine instead.
 */
export function normalizeKiroEngineFlag(args: {
  command: string
  commandTokens: readonly string[]
  trailingTokens: readonly string[]
  isDefaultCommand: boolean
}): string {
  const trailingPicksEngine = hasKiroEngineFlag(args.trailingTokens)
  if (hasKiroEngineFlag(args.commandTokens)) {
    if (trailingPicksEngine && args.isDefaultCommand) {
      return args.command.replace(/\s+--v3(?=\s|$)/, '')
    }
    return args.command
  }
  // Why skip after `--`: anything appended there would be read as a prompt, not a flag.
  if (trailingPicksEngine || args.commandTokens.includes('--')) {
    return args.command
  }
  return `${args.command} ${KIRO_V3_FLAG}`
}

const KIRO_NON_INTERACTIVE_FLAGS = new Set([
  '--no-interactive',
  '--output-format',
  '--list-sessions',
  '--list-models',
  '--delete-session',
  '--sessions'
])

// Why only `acp`: it is a JSON-RPC stdio server. Other subcommands are not enumerated
// from a measured CLI, and misreading a live pane as one-shot would drop its status.
const KIRO_NON_INTERACTIVE_SUBCOMMANDS = new Set(['acp'])

/** True for a Kiro argv that cannot host an interactive TUI (one-shot, listing, ACP). */
export function isKiroNonInteractiveCommand(tokens: readonly string[]): boolean {
  let sawSubcommand = false
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    // Why: `--` ends option parsing, so a prompt that reads like a flag is still a prompt.
    if (token === '--') {
      return false
    }
    if (token.startsWith('-')) {
      if (KIRO_NON_INTERACTIVE_FLAGS.has(optionName(token))) {
        return true
      }
      continue
    }
    // Why skip paths: the `bun …/kiro-cli/tui.js chat` leaf puts the script path first.
    if (!sawSubcommand && !token.includes('/') && !token.includes('\\')) {
      sawSubcommand = true
      if (KIRO_NON_INTERACTIVE_SUBCOMMANDS.has(token.toLowerCase())) {
        return true
      }
    }
  }
  return false
}
