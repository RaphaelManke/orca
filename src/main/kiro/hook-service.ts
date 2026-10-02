import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix as pathPosix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookCurlPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { peekKiroCliVersionStatus, readKiroCliVersionStatus } from './kiro-cli-version-probe'
import { KIRO_CLI_MIN_VERSION } from '../../shared/kiro-cli-version'
import {
  applyManagedKiroHooks,
  KIRO_HOOK_EVENTS,
  readManagedKiroHookEvents,
  removeManagedKiroHooks
} from './kiro-hook-config-json'

// Why: Kiro CLI 3.0 reads standalone hook files from `~/.kiro/hooks/*.json` (project and global);
// the interactive CLI loads the global ones. Orca owns a dedicated file so it never touches the
// user's agent configs or their own hooks in other files.
function getConfigPath(): string {
  return join(homedir(), '.kiro', 'hooks', 'orca-status.json')
}

// Why .cmd on win32: Kiro runs hook commands through cmd.exe there, so a `/bin/sh` wrapper is invalid.
const MANAGED_SCRIPT_BASE = 'kiro-hook'
const POSIX_MANAGED_SCRIPT_FILE_NAME = `${MANAGED_SCRIPT_BASE}.sh`

function getManagedScriptFileName(): string {
  return process.platform === 'win32'
    ? `${MANAGED_SCRIPT_BASE}.cmd`
    : POSIX_MANAGED_SCRIPT_FILE_NAME
}

// Ownership test shared by status/install/remove; the matcher accepts .sh/.cmd/.ps1 alike.
const isManagedKiroCommand = createManagedCommandMatcher(POSIX_MANAGED_SCRIPT_FILE_NAME)

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

export function getKiroManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsCmdHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getKiroRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function getKiroManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('kiro'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }
  // Why capture-first on POSIX (#8110): exiting before draining stdin surfaces EPIPE to Kiro. Outside
  // Orca (no ORCA_* env) spool_hook_event returns before any mkdir/write, so the no-env path is disk- and network-free.
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('kiro'),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/kiro" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

// Returns file text, '' when the config does not exist yet, or null on an unreadable file so
// callers can report a structured error.
function readConfigJson(configPath: string): string | null {
  if (!existsSync(configPath)) {
    return ''
  }
  try {
    return readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
}

function buildStatus(present: Set<string>, configPath: string): AgentHookInstallStatus {
  const missing = KIRO_HOOK_EVENTS.filter((event) => !present.has(event))
  let state: AgentHookInstallState
  let detail: string | null
  const version = peekKiroCliVersionStatus()
  if (missing.length === 0 && version.verdict === 'too-old') {
    // Why (D11): kiro-cli < 2.13 never loads global hooks, so a complete file is not a working install.
    state = 'not_installed'
    detail = `kiro-cli ${version.version ?? ''} is older than ${KIRO_CLI_MIN_VERSION} and does not load global hooks; upgrade kiro-cli`
  } else if (missing.length === 0) {
    state = 'installed'
    detail = null
  } else if (present.size === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.join(', ')}`
  }
  return { agent: 'kiro', state, configPath, managedHooksPresent: present.size > 0, detail }
}

function errorStatus(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'kiro', state: 'error', configPath, managedHooksPresent: false, detail }
}

export class KiroHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getKiroManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigJson(configPath)
    if (text === null) {
      return errorStatus(configPath, 'Could not read Kiro hooks file')
    }
    return buildStatus(readManagedKiroHookEvents(text, isManagedKiroCommand), configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigJson(configPath)
    if (text === null) {
      return errorStatus(configPath, 'Could not read Kiro hooks file')
    }
    // Why: warm the version verdict so later status reads can apply the D11 gate.
    void readKiroCliVersionStatus()
    const scriptPath = getManagedScriptPath()
    const command = getKiroManagedCommand(scriptPath)
    const nextText = applyManagedKiroHooks(text, command, isManagedKiroCommand)
    if (nextText === null) {
      return errorStatus(configPath, 'Kiro hooks file is not valid JSON')
    }
    // Write the script first so the config never points at a missing script.
    writeManagedScript(scriptPath, getKiroManagedScript())
    writeHooksJson(configPath, {}, { serialized: nextText, preserveMode: true })
    return this.getStatus()
  }

  // Why: install Orca's managed Kiro hooks on a remote box over SFTP, mirroring the local install.
  // POSIX-only by design; the managed script body is platform-independent.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = pathPosix.join(remoteHome, '.kiro', 'hooks', 'orca-status.json')
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      POSIX_MANAGED_SCRIPT_FILE_NAME
    )
    try {
      const text = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      const command = getKiroRemoteManagedCommand(remoteScriptPath)
      const nextText = applyManagedKiroHooks(text, command, isManagedKiroCommand)
      if (nextText === null) {
        return errorStatus(remoteConfigPath, 'Kiro hooks file is not valid JSON')
      }
      // Write the script first so the config never points at a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getKiroManagedScript('posix'))
      await writeTextFileRemoteAtomic(sftp, remoteConfigPath, nextText)
      return {
        agent: 'kiro',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return errorStatus(remoteConfigPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigJson(configPath)
    if (text === null) {
      return errorStatus(configPath, 'Could not read Kiro hooks file')
    }
    const result = removeManagedKiroHooks(text, isManagedKiroCommand)
    if (result === null) {
      return errorStatus(configPath, 'Kiro hooks file is not valid JSON')
    }
    if (result.changed) {
      writeHooksJson(configPath, {}, { serialized: result.text, preserveMode: true })
    }
    return this.getStatus()
  }
}

export const kiroHookService = new KiroHookService()
