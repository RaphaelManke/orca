// Orca's own V3 global hook file `~/.kiro/hooks/orca-status.json`: entries running the managed
// script are Orca's, any other entry is preserved. Schema: kiro.dev/docs/hooks (`version: "v1"`).

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import { isPlainObject } from '../agent-hooks/hooks-json-read'

// The V3 lifecycle events Orca normalizes for status (see normalizeKiroEvent). Older Orca builds
// wrote `AgentSpawn`; reinstall drops it because every managed entry is rebuilt from this list.
export const KIRO_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
] as const

const KIRO_HOOK_EVENT_SET: ReadonlySet<string> = new Set(KIRO_HOOK_EVENTS)

export const KIRO_HOOK_FILE_VERSION = 'v1' as const

export type ManagedCommandMatcher = (command: string | undefined) => boolean

type KiroHookEntry = {
  name?: string
  trigger?: string
  matcher?: string
  action?: { type?: string; command?: string; [key: string]: unknown }
  timeout?: number
  enabled?: boolean
  [key: string]: unknown
}

const MANAGED_HOOK_NAME_PREFIX = 'orca-status-'

function managedHookName(event: string): string {
  return `${MANAGED_HOOK_NAME_PREFIX}${event}`
}

function isManagedEntry(entry: KiroHookEntry, isManaged: ManagedCommandMatcher): boolean {
  return isManaged(entry.action?.command)
}

function collectEntries(config: Record<string, unknown> | null): KiroHookEntry[] {
  if (!config || !Array.isArray(config.hooks)) {
    return []
  }
  return config.hooks.filter((entry): entry is KiroHookEntry => isPlainObject(entry))
}

function buildManagedEntry(event: string, command: string): KiroHookEntry {
  return {
    name: managedHookName(event),
    trigger: event,
    action: { type: 'command', command },
    timeout: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}

function parseConfig(configJson: string): Record<string, unknown> | null {
  const content = configJson.charCodeAt(0) === 0xfeff ? configJson.slice(1) : configJson
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return {}
  }
  try {
    const parsed = JSON.parse(content)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function serialize(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

// Drop any existing managed entries and write one managed hook per event, preserving any
// non-managed hooks a user may have added to the same file. Returns null when the file is not
// parseable JSON so the caller can fail closed instead of clobbering hand-edited content.
export function applyManagedKiroHooks(
  configJson: string,
  command: string,
  isManaged: ManagedCommandMatcher
): string | null {
  const config = parseConfig(configJson)
  if (config === null) {
    return null
  }
  const preserved = collectEntries(config).filter((entry) => !isManagedEntry(entry, isManaged))
  const managed = KIRO_HOOK_EVENTS.map((event) => buildManagedEntry(event, command))
  return serialize({
    ...config,
    version: KIRO_HOOK_FILE_VERSION,
    hooks: [...preserved, ...managed]
  })
}

// Strip only Orca's managed entries; report whether anything changed.
export function removeManagedKiroHooks(
  configJson: string,
  isManaged: ManagedCommandMatcher
): { text: string; changed: boolean } | null {
  const config = parseConfig(configJson)
  if (config === null) {
    return null
  }
  if (config.hooks === undefined) {
    return { text: configJson, changed: false }
  }
  const entries = collectEntries(config)
  const preserved = entries.filter((entry) => !isManagedEntry(entry, isManaged))
  if (preserved.length === entries.length) {
    return { text: configJson, changed: false }
  }
  const next: Record<string, unknown> = { ...config }
  if (preserved.length > 0) {
    next.version = KIRO_HOOK_FILE_VERSION
    next.hooks = preserved
  } else {
    // Orca's file with nothing else in it: leave an empty valid hooks file.
    next.version = KIRO_HOOK_FILE_VERSION
    next.hooks = []
  }
  return { text: serialize(next), changed: true }
}

// The set of events whose managed hook is present, used to drive install status.
export function readManagedKiroHookEvents(
  configJson: string,
  isManaged: ManagedCommandMatcher
): Set<string> {
  const config = parseConfig(configJson)
  const events = new Set<string>()
  for (const entry of collectEntries(config)) {
    // Why: a legacy AgentSpawn entry must not count toward status, so an old file reads `partial`.
    if (
      isManagedEntry(entry, isManaged) &&
      typeof entry.trigger === 'string' &&
      KIRO_HOOK_EVENT_SET.has(entry.trigger)
    ) {
      events.add(entry.trigger)
    }
  }
  return events
}
