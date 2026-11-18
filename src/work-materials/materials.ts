/**
 * FILE: plugin/src/work-materials/materials.ts
 * DESCRIPTION: List, read and version-save permitted project documents
 */
import { validate } from '../validation.ts'
import { ownMessage, withUiMessage, messageOf, externalMessage } from '../ui-message.ts'
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem,FsVersion } from '@deepseek-ai/dsh-fs'
import { join } from 'node:path'
import { assertProjectWritable,readTaskState } from '../task-management/queries.ts'
import { stateSchema } from '../task-management/schemas.ts'
import type { MaterialDocument,MaterialFile,MaterialGroup } from '../types.ts'
import type { MutationProgress } from '../step-execution/types.ts'
import { OperationRefusal } from '../step-execution/application/observe-run.ts'
import { createArtifactScanner,KNOWLEDGE_ROOT,targetFor } from '../work-materials/artifact-files.ts'
export { targetFor } from '../work-materials/artifact-files.ts'

const MAX_BYTES = 2 * 1024 * 1024

/**
 * START_METHOD_listMaterials
 * List task and project documents without reading their contents or requiring a chat.
 */
export async function listMaterials(fs: FileSystem, cwd: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]> {
  return diagnosticOperation({ path: 'src/work-materials/materials.ts', method: 'listMaterials' }, { projectPath: cwd, taskId: taskId }, async () => {
    const groups: MaterialGroup[] = []
    const scan = createArtifactScanner(fs, cwd, signal)
    const group = async (id: string, title: string, path: string, base: string) => {
      try {
        const files: MaterialFile[] = (await scan(path)).map(path => ({ path, name: path.slice(base.length + 1) }))
        groups.push({ id, title, files, issue: null, ...(id === 'request' ? { titleMessage: { key: 'requestGroup' as const } } : id === 'knowledge' ? { titleMessage: { key: 'knowledgeGroup' as const } } : {}) })
      } catch (error) {
        signal.throwIfAborted()
        groups.push({ id, title, files: [], issue: error instanceof Error ? error.message : String(error), issueMessage: messageOf(error) ?? externalMessage('materialsReadFailed', error), ...(id === 'request' ? { titleMessage: { key: 'requestGroup' as const } } : id === 'knowledge' ? { titleMessage: { key: 'knowledgeGroup' as const } } : {}) })
      }
    }
    if (taskId !== null) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw diagnosticRejection(withUiMessage(new Error('Invalid task identifier'), ownMessage({ key: 'reasonInvalidTaskIdentifier' })))
      const base = `.aicraft/tasks/${taskId}`
      await targetFor(fs, cwd, base, signal)
      for (const name of ['state.json', 'request.md', 'process.json', 'runs.json']) await targetFor(fs, cwd, `${base}/${name}`, signal)
      const stateTarget = await targetFor(fs, cwd, `${base}/state.json`, signal)
      const state = validate(stateSchema, JSON.parse(await fs.readText(stateTarget, signal)))
      const savedProcess = await fs.stat(await targetFor(fs, cwd, `${base}/process.json`, signal), signal)
      if (!savedProcess) await targetFor(fs, cwd, `.aicraft/config/processes/${state.taskType}.jsonc`, signal)
      const task = await readTaskState(fs, cwd, taskId, signal)
      await group('request', 'Постановка', `${base}/request.md`, base)
      for (const step of task.process.steps) {
        const prefix = `${base}/${step.id}`
        await group(`step:${step.id}`, step.title, prefix, prefix)
      }
    }
    await group('knowledge', 'Знания проекта', KNOWLEDGE_ROOT, KNOWLEDGE_ROOT)
    return groups

  })
}
// END_METHOD_listMaterials

/**
 * START_METHOD_readMaterial
 * Read bounded UTF-8 content; unsupported or binary files never render as HTML.
 */
export async function readMaterial(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<MaterialDocument> {
  return diagnosticOperation({ path: 'src/work-materials/materials.ts', method: 'readMaterial' }, { projectPath: cwd }, async () => {
    const target = await targetFor(fs, cwd, path, signal)
    const info = await fs.lstat(path, { cwd }, signal)
    if (info?.type !== 'file') throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Artifact must be a regular file'), ownMessage({ key: 'reasonArtifactMustBeARegularFile' })))
    if (info.size !== undefined && info.size > MAX_BYTES) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Artifact is too large (limit: 2 MiB)'), ownMessage({ key: 'reasonArtifactIsTooLargeLimit2MiB' })))
    const before = await fs.stat(target, signal)
    if (before?.type !== 'file') throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Artifact must be a regular file'), ownMessage({ key: 'reasonArtifactMustBeARegularFile' })))
    const bytes = await fs.readBytes(target, signal, MAX_BYTES)
    const after = await fs.stat(target, signal)
    if (after?.version !== before.version) throw diagnosticRejection(withUiMessage(new OperationRefusal('version-conflict', 'The file changed while reading; reload it'), ownMessage({ key: 'reasonTheFileChangedWhileReadingReloadIt' })))
    if (bytes.length > MAX_BYTES) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Artifact is too large (limit: 2 MiB)'), ownMessage({ key: 'reasonArtifactIsTooLargeLimit2MiB' })))
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'This file cannot be displayed as UTF-8 text'), ownMessage({ key: 'reasonThisFileCannotBeDisplayedAsUTF8Text' }))) }
    if (text.includes('\0')) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Binary files are not supported by this viewer'), ownMessage({ key: 'reasonBinaryFilesAreNotSupportedByThisViewer' })))
    return { path, text, version: before.version, format: /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text' }

  })
}
// END_METHOD_readMaterial

/**
 * START_METHOD_saveMaterial
 * Save versioned Markdown and reconcile a lost receipt once under the original lock.
 */
export async function saveMaterial(
  fs: FileSystem,
  cwd: string,
  path: string,
  text: string,
  version: string,
  lockWaitMs: number,
  signal: AbortSignal,
  progress?: MutationProgress<MaterialDocument>,
): Promise<MaterialDocument> {
  return diagnosticOperation({ path: 'src/work-materials/materials.ts', method: 'saveMaterial' }, { projectPath: cwd }, async () => {
    if (!/\.md$/i.test(path)) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Only .md files can be edited'), ownMessage({ key: 'reasonOnlyMdFilesCanBeEdited' })))
    if (!version) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'The original file version is required'), ownMessage({ key: 'reasonTheOriginalFileVersionIsRequired' })))
    if (text.includes('\0')) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Markdown must not contain NUL bytes'), ownMessage({ key: 'reasonMarkdownMustNotContainNULBytes' })))
    const prepared = new TextEncoder().encode(text)
    if (prepared.length > MAX_BYTES) throw diagnosticRejection(withUiMessage(new OperationRefusal('invalid-input', 'Artifact is too large (limit: 2 MiB)'), ownMessage({ key: 'reasonArtifactIsTooLargeLimit2MiB' })))
    return withFileLock(join(cwd, '.aicraft'), async () => {
      const target = await targetFor(fs, cwd, path, signal)
      await assertProjectWritable(fs, cwd, signal)
      const current = await fs.lstat(path, { cwd }, signal)
      if (current?.type !== 'file') throw diagnosticRejection(withUiMessage(new OperationRefusal(current ? 'invalid-input' : 'not-found', 'Artifact must be an existing regular file'), ownMessage({ key: 'reasonArtifactMustBeAnExistingRegularFile' })))
      if (current.version !== version) throw diagnosticRejection(withUiMessage(new OperationRefusal('version-conflict', 'The file changed outside the editor. Your changes have not been saved; reload the file to continue.'), ownMessage({ key: 'reasonTheFileChangedOutsideTheEditorYourChangesHaveNotBeenSavedReloa' })))
      diagnosticAccepted({ path, text, version })
      progress?.submitting()
      const document = await diagnosticPublication(async (): Promise<MaterialDocument> => {
        try {
          const outcome = await fs.writeText(target, text, { kind: 'replaceIfVersion', version: version as FsVersion }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
          // FsWriteOutcome.after normalizes line endings for diffs, not persisted bytes.
          return { path, text, version: outcome.version, format: 'markdown' }
        } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error
            && ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(String(error.code))) throw error
          try {
            signal.throwIfAborted()
            const resolved = await targetFor(fs, cwd, path, signal)
            if (resolved.targetKey !== target.targetKey) throw error
            const entry = await fs.lstat(path, { cwd }, signal)
            if (entry?.type !== 'file') throw error
            const before = await fs.stat(target, signal)
            if (before?.type !== 'file' || !before.version || (before.size !== undefined && before.size > MAX_BYTES)) throw error
            const bytes = await fs.readBytes(target, signal, MAX_BYTES)
            const after = await fs.stat(target, signal)
            const finalTarget = await targetFor(fs, cwd, path, signal)
            const finalEntry = await fs.lstat(path, { cwd }, signal)
            signal.throwIfAborted()
            if (after?.type !== 'file' || after.version !== before.version
              || finalTarget.targetKey !== target.targetKey || finalEntry?.type !== 'file' || finalEntry.version !== after.version
              || bytes.length !== prepared.length || !bytes.every((byte, index) => byte === prepared[index])) throw error
            return { path, text, version: after.version, format: 'markdown' }
          } catch {
            // A failed verification cannot reclassify the uncertain original write.
            throw error
          }
        }
      }, target, 'writeText')
      progress?.confirmed(document)
      return document
    }, { waitMs: lockWaitMs })

  })
}
// END_METHOD_saveMaterial
