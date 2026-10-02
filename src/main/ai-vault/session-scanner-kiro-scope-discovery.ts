import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { kiroCwdHash } from '../../shared/kiro-session-log'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import { observeSessionSidecar } from './session-scanner-discovery'
import {
  KIRO_CWD_BUCKET_PATTERN,
  KIRO_SESSION_DIR_PREFIX,
  KIRO_SESSION_MESSAGES_FILE,
  KIRO_SESSION_METADATA_FILE,
  kiroSessionMetadataPath
} from './session-scanner-kiro-paths'
import { addBoundedFile, isCwdInsideScopePath } from './session-scanner-scope-discovery'
import type { FileWithMtime } from './session-scanner-types'
import {
  arrayValue,
  asRecord,
  errorMessage,
  readJsonObjectIfExists
} from './session-scanner-values'

const KIRO_BUCKET_INDEX_PATH = ['.index', 'index.json'] as const
const KIRO_BUCKET_ROOTS_PROBE_LIMIT = 3
// Why permanent: the bucket name is a hash of its roots, so a resolved entry can never go stale.
const KIRO_BUCKET_ROOTS_CACHE_MAX = 4096
const kiroBucketRootsCache = new Map<string, readonly string[]>()

export function resetKiroBucketRootsCacheForTests(): void {
  kiroBucketRootsCache.clear()
}

type KiroInScopeDiscoveryArgs = {
  rootDirs: readonly string[]
  scopePaths: readonly string[]
  limit: number
  excludedFilePaths: ReadonlySet<string>
  issues: AiVaultScanIssue[]
}

/**
 * Kiro's bucket is sha256(workspace root), so a scope's own hash is only a fast path:
 * sessions started in a subfolder hash differently. Membership comes from the bucket's
 * recorded workspacePaths, resolved once per bucket and cached.
 */
export async function discoverInScopeKiroSessionFiles(
  args: KiroInScopeDiscoveryArgs
): Promise<FileWithMtime[]> {
  if (args.scopePaths.length === 0 || args.limit <= 0) {
    return []
  }
  const scopeHashes = kiroScopeHashes(args.scopePaths)
  const collected = new Map<string, FileWithMtime>()
  for (const rootDir of args.rootDirs) {
    for (const bucket of await readDirNames(rootDir, args.issues)) {
      if (!KIRO_CWD_BUCKET_PATTERN.test(bucket)) {
        continue
      }
      const bucketDir = join(rootDir, bucket)
      if (!scopeHashes.has(bucket) && !(await bucketIsInScope(bucketDir, args))) {
        continue
      }
      await collectKiroBucketFiles(bucketDir, collected, args)
    }
  }
  return [...collected.values()].sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function kiroScopeHashes(scopePaths: readonly string[]): Set<string> {
  const hashes = new Set<string>()
  for (const scopePath of scopePaths) {
    const wsl = parseWslUncPath(scopePath)
    hashes.add(wsl ? kiroCwdHash(wsl.linuxPath, 'linux') : kiroCwdHash(scopePath, process.platform))
  }
  return hashes
}

async function bucketIsInScope(
  bucketDir: string,
  args: KiroInScopeDiscoveryArgs
): Promise<boolean> {
  const roots = await cachedBucketRoots(bucketDir, args.issues)
  return roots.some((root) =>
    args.scopePaths.some((scopePath) => isCwdInsideScopePath(scopePath, root))
  )
}

async function cachedBucketRoots(
  bucketDir: string,
  issues: AiVaultScanIssue[]
): Promise<readonly string[]> {
  const cached = kiroBucketRootsCache.get(bucketDir)
  if (cached) {
    return cached
  }
  const roots = await readBucketRoots(bucketDir, issues)
  if (roots.length > 0) {
    if (kiroBucketRootsCache.size >= KIRO_BUCKET_ROOTS_CACHE_MAX) {
      const oldest = kiroBucketRootsCache.keys().next()
      if (!oldest.done) {
        kiroBucketRootsCache.delete(oldest.value)
      }
    }
    kiroBucketRootsCache.set(bucketDir, roots)
  }
  return roots
}

function workspacePathsOf(record: Record<string, unknown> | null | undefined): string[] {
  return arrayValue(record?.workspacePaths).filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
}

async function readBucketRoots(bucketDir: string, issues: AiVaultScanIssue[]): Promise<string[]> {
  try {
    const index = await readJsonObjectIfExists(join(bucketDir, ...KIRO_BUCKET_INDEX_PATH))
    const fromIndex = workspacePathsOf(asRecord(arrayValue(index?.entries)[0]))
    if (fromIndex.length > 0) {
      return fromIndex
    }
    const sessionDirs = (await readDirNames(bucketDir, issues)).filter((name) =>
      name.startsWith(KIRO_SESSION_DIR_PREFIX)
    )
    for (const sessionDir of sessionDirs.slice(0, KIRO_BUCKET_ROOTS_PROBE_LIMIT)) {
      const roots = workspacePathsOf(
        await readJsonObjectIfExists(join(bucketDir, sessionDir, KIRO_SESSION_METADATA_FILE))
      )
      if (roots.length > 0) {
        return roots
      }
    }
  } catch (error) {
    recordRefusal(issues, bucketDir, error)
  }
  return []
}

async function collectKiroBucketFiles(
  bucketDir: string,
  collected: Map<string, FileWithMtime>,
  args: KiroInScopeDiscoveryArgs
): Promise<void> {
  for (const sessionDir of await readDirNames(bucketDir, args.issues)) {
    if (!sessionDir.startsWith(KIRO_SESSION_DIR_PREFIX)) {
      continue
    }
    const path = join(bucketDir, sessionDir, KIRO_SESSION_MESSAGES_FILE)
    if (collected.has(path) || args.excludedFilePaths.has(path)) {
      continue
    }
    try {
      const fileStat = await wslGatedStat(path, 'scan')
      addBoundedFile(collected, args.limit, {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size,
        sidecar: await observeSessionSidecar(kiroSessionMetadataPath(path))
      })
    } catch (error) {
      // A never-prompted session has no transcript yet; that is not a scan problem.
      if (!isMissingPathError(error)) {
        recordSessionScanIssue(args.issues, { agent: 'kiro', path, message: errorMessage(error) })
      }
    }
  }
}

async function readDirNames(dirPath: string, issues: AiVaultScanIssue[]): Promise<string[]> {
  try {
    return (await wslGatedReaddir(dirPath, 'scan'))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    recordRefusal(issues, dirPath, error)
    return []
  }
}

function recordRefusal(issues: AiVaultScanIssue[], path: string, error: unknown): void {
  if (error instanceof WslTranscriptFsError) {
    recordSessionScanIssue(issues, { agent: 'kiro', path, message: error.message })
  }
}

function isMissingPathError(error: unknown): boolean {
  if (error instanceof WslTranscriptFsError) {
    return false
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}
