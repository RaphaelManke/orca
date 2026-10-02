// Kiro V3 keeps one directory per session: <sessions>/<cwdHash>/sess_<id>/{session.json,messages.jsonl}.
// Pure string predicates so local, WSL and SSH discovery share one shape.

export const KIRO_SESSION_MESSAGES_FILE = 'messages.jsonl'
export const KIRO_SESSION_METADATA_FILE = 'session.json'
export const KIRO_SESSION_DIR_PREFIX = 'sess_'
// Why: `cli/`, `_global/` and `.index/` share the root; only cwd-hash buckets hold workspace sessions.
export const KIRO_CWD_BUCKET_PATTERN = /^[0-9a-f]{16}$/

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter(Boolean)
}

export function isKiroSessionMessagesPath(filePath: string): boolean {
  const segments = pathSegments(filePath)
  return (
    segments.at(-1) === KIRO_SESSION_MESSAGES_FILE &&
    (segments.at(-2)?.startsWith(KIRO_SESSION_DIR_PREFIX) ?? false)
  )
}

/** Depth 0 is the cwd bucket, depth 1 the session dir; anything deeper (sub-executions) is pruned. */
export function isKiroSessionDirectory(name: string, depth: number): boolean {
  if (depth === 0) {
    return KIRO_CWD_BUCKET_PATTERN.test(name)
  }
  return depth === 1 && name.startsWith(KIRO_SESSION_DIR_PREFIX)
}

/** The sibling session.json, spelled with the transcript path's own separator. */
export function kiroSessionMetadataPath(messagesPath: string): string {
  const cut = Math.max(messagesPath.lastIndexOf('/'), messagesPath.lastIndexOf('\\'))
  return cut < 0
    ? KIRO_SESSION_METADATA_FILE
    : `${messagesPath.slice(0, cut + 1)}${KIRO_SESSION_METADATA_FILE}`
}

export function kiroSessionIdFromMessagesPath(messagesPath: string): string {
  return pathSegments(messagesPath).at(-2) ?? ''
}
