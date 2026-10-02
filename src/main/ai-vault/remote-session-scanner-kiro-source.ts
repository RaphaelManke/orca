import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import type { RemoteSessionContent } from './remote-session-content-lines'
import { isMissingRemoteSessionPathError } from './remote-session-file-stat'
import type { RemoteScannerContext, RemoteSessionSource } from './remote-session-scanner-types'
import { parseKiroSessionContent } from './session-scanner-kiro-parser'
import {
  isKiroSessionDirectory,
  isKiroSessionMessagesPath,
  kiroSessionMetadataPath
} from './session-scanner-kiro-paths'
import type { FileWithMtime } from './session-scanner-types'

async function readRemoteKiroMetadata(
  messagesPath: string,
  context: RemoteScannerContext
): Promise<string | null> {
  try {
    throwIfAiVaultScanCancelled(context.signal)
    const read = await context.provider.readFile(kiroSessionMetadataPath(messagesPath))
    throwIfAiVaultScanCancelled(context.signal)
    return read.isBinary ? null : read.content
  } catch (error) {
    throwIfAiVaultScanCancelled(context.signal)
    if (!isMissingRemoteSessionPathError(error)) {
      throw error
    }
    return null
  }
}

export function remoteKiroSource(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RemoteSessionSource {
  const parse = async (
    file: FileWithMtime,
    content: RemoteSessionContent,
    context: RemoteScannerContext
  ) =>
    parseKiroSessionContent(
      file,
      content,
      await readRemoteKiroMetadata(file.path, context),
      context.hostPlatform.os,
      { executionHostId: context.executionHostId, executionHostPlatform: context.hostPlatform.os },
      context.signal
    )
  return {
    agent: 'kiro',
    rootDir: joinRemotePath(hostPlatform, remoteHome, '.kiro', 'sessions'),
    extensions: ['.jsonl'],
    filePredicate: isKiroSessionMessagesPath,
    contentDependencyPath: kiroSessionMetadataPath,
    directoryPredicate: isKiroSessionDirectory,
    parse,
    parseLines: parse
  }
}
