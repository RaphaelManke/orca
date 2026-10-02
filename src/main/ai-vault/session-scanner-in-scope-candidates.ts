import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  CLAUDE_CWD_BUCKET_LAYOUT,
  CODEBUDDY_CWD_BUCKET_LAYOUT,
  PI_CWD_BUCKET_LAYOUT
} from './session-cwd-bucket-layouts'
import { discoverInScopeKiroSessionFiles } from './session-scanner-kiro-scope-discovery'
import { discoverInScopeCwdBucketFiles } from './session-scanner-scope-discovery'
import type { SessionFileCandidate, SessionFileDiscovery } from './session-scanner-types'

// Agents whose on-disk layout names a directory per cwd, so a scope's older
// sessions can be found without reading every transcript's header.
const CWD_BUCKET_LAYOUTS = [
  CLAUDE_CWD_BUCKET_LAYOUT,
  PI_CWD_BUCKET_LAYOUT,
  CODEBUDDY_CWD_BUCKET_LAYOUT
]

/** Every in-scope transcript the recency cap may have dropped, from the per-cwd stores. */
export async function discoverInScopeSessionCandidates(args: {
  discoveries: SessionFileDiscovery[]
  scopePaths: readonly string[]
  limit: number
  alreadyParsedFilePaths: ReadonlySet<string>
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]> {
  const rootDirsOf = (agent: AiVaultAgent) =>
    args.discoveries
      .filter((discovery) => discovery.agent === agent)
      .map((discovery) => discovery.rootDir)
  const discoveryArgs = {
    scopePaths: args.scopePaths,
    limit: args.limit,
    excludedFilePaths: args.alreadyParsedFilePaths,
    issues: args.issues
  }
  const candidates: SessionFileCandidate[] = []
  for (const layout of CWD_BUCKET_LAYOUTS) {
    const files = await discoverInScopeCwdBucketFiles(layout, {
      rootDirs: rootDirsOf(layout.agent),
      ...discoveryArgs
    })
    candidates.push(...files.map((file) => ({ agent: layout.agent, file, codexHome: null })))
  }
  // Kiro buckets are hashes, not path encodings, so it has its own membership rule.
  const kiroFiles = await discoverInScopeKiroSessionFiles({
    rootDirs: rootDirsOf('kiro'),
    ...discoveryArgs
  })
  for (const file of kiroFiles) {
    candidates.push({ agent: 'kiro', file, codexHome: null })
  }
  return candidates
}
