import { describe, expect, it } from 'vitest'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  applyManagedKiroHooks,
  KIRO_HOOK_EVENTS,
  KIRO_HOOK_FILE_VERSION,
  readManagedKiroHookEvents,
  removeManagedKiroHooks
} from './kiro-hook-config-json'

const isManaged = createManagedCommandMatcher('kiro-hook.sh')
const COMMAND =
  "if [ -x '/home/u/.orca/agent-hooks/kiro-hook.sh' ]; then /bin/sh '/home/u/.orca/agent-hooks/kiro-hook.sh'; fi"

// A user's own hook that happens to share Orca's file; Orca must never touch it.
const USER_COMMAND = 'npm run lint'
const USER_CONFIG = JSON.stringify({
  version: 'v1',
  hooks: [
    {
      name: 'lint-on-save',
      trigger: 'PostFileSave',
      matcher: '\\.ts$',
      action: { type: 'command', command: USER_COMMAND }
    }
  ]
})

type HookEntry = { name?: string; trigger?: string; action?: { type?: string; command?: string } }

function parse(text: string): { version?: string; hooks: HookEntry[] } {
  const parsed: { version?: string; hooks?: HookEntry[] } = JSON.parse(text)
  return { version: parsed.version, hooks: parsed.hooks ?? [] }
}

describe('applyManagedKiroHooks', () => {
  it('writes the v1 schema with one managed hook per event (PascalCase triggers)', () => {
    const text = applyManagedKiroHooks('', COMMAND, isManaged)
    expect(text).not.toBeNull()
    const { version, hooks } = parse(text!)
    expect(version).toBe(KIRO_HOOK_FILE_VERSION)
    expect(hooks.map((h) => h.trigger).sort()).toEqual([...KIRO_HOOK_EVENTS].sort())
    for (const h of hooks) {
      expect(h.action).toMatchObject({ type: 'command', command: COMMAND })
    }
    expect([...readManagedKiroHookEvents(text!, isManaged)].sort()).toEqual(
      [...KIRO_HOOK_EVENTS].sort()
    )
  })

  it('is idempotent — reapplying does not duplicate managed entries', () => {
    const once = applyManagedKiroHooks('{}', COMMAND, isManaged)!
    const twice = applyManagedKiroHooks(once, COMMAND, isManaged)!
    expect(parse(twice).hooks).toHaveLength(KIRO_HOOK_EVENTS.length)
  })

  it("preserves a user's own non-managed hook in the same file", () => {
    const text = applyManagedKiroHooks(USER_CONFIG, COMMAND, isManaged)!
    const { hooks } = parse(text)
    expect(hooks.some((h) => h.action?.command === USER_COMMAND)).toBe(true)
    expect(readManagedKiroHookEvents(text, isManaged).size).toBe(KIRO_HOOK_EVENTS.length)
    // user hook + managed events
    expect(hooks).toHaveLength(KIRO_HOOK_EVENTS.length + 1)
  })

  it('returns null for non-JSON so the caller can fail closed', () => {
    expect(applyManagedKiroHooks('not json {', COMMAND, isManaged)).toBeNull()
  })
})

describe('removeManagedKiroHooks', () => {
  it('strips only the managed entries, keeping a user hook', () => {
    const installed = applyManagedKiroHooks(USER_CONFIG, COMMAND, isManaged)!
    const result = removeManagedKiroHooks(installed, isManaged)!
    expect(result.changed).toBe(true)
    const { hooks } = parse(result.text)
    expect(hooks).toHaveLength(1)
    expect(hooks[0].action?.command).toBe(USER_COMMAND)
    expect(readManagedKiroHookEvents(result.text, isManaged).size).toBe(0)
  })

  it('leaves an empty hooks array when only managed entries existed', () => {
    const installed = applyManagedKiroHooks('', COMMAND, isManaged)!
    const result = removeManagedKiroHooks(installed, isManaged)!
    expect(result.changed).toBe(true)
    expect(parse(result.text).hooks).toEqual([])
  })

  it('reports no change when there are no managed entries', () => {
    const result = removeManagedKiroHooks(USER_CONFIG, isManaged)!
    expect(result.changed).toBe(false)
    expect(result.text).toBe(USER_CONFIG)
  })

  it('returns null for non-JSON', () => {
    expect(removeManagedKiroHooks('nope', isManaged)).toBeNull()
  })
})
