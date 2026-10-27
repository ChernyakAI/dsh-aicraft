/**
 * FILE: plugin/src/work-materials/materials.ts
 * DESCRIPTION: List, read and version-save permitted project documents
 */
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem,FsVersion } from '@deepseek-ai/dsh-fs'
import { join } from 'node:path'
import { assertProjectWritable,readTaskState } from '../task-management/queries.ts'
import { stateSchema } from '../task-management/schemas.ts'
import type { MaterialDocument,MaterialFile,MaterialGroup } from '../types.ts'
import { createArtifactScanner,targetFor } from '../work-materials/artifact-files.ts'
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
        groups.push({ id, title, files, issue: null })
      } catch (error) {
        signal.throwIfAborted()
        groups.push({ id, title, files: [], issue: error instanceof Error ? error.message : String(error) })
      }
    }
    if (taskId !== null) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw diagnosticRejection(new Error('Invalid task identifier'))
      const base = `.aicraft/tasks/${taskId}`
      await targetFor(fs, cwd, base, signal)
      for (const name of ['state.json', 'request.md', 'process.json', 'runs.json']) await targetFor(fs, cwd, `${base}/${name}`, signal)
      const stateTarget = await targetFor(fs, cwd, `${base}/state.json`, signal)
      const state = stateSchema.parse(JSON.parse(await fs.readText(stateTarget, signal)))
      const savedProcess = await fs.stat(await targetFor(fs, cwd, `${base}/process.json`, signal), signal)
      if (!savedProcess) await targetFor(fs, cwd, `.aicraft/config/processes/${state.taskType}.jsonc`, signal)
      const task = await readTaskState(fs, cwd, taskId, signal)
      await group('request', 'Постановка', `${base}/request.md`, base)
      for (const step of task.process.steps) {
        const prefix = `${base}/${step.id}`
        await group(`step:${step.id}`, step.title, prefix, prefix)
      }
    }
    await group('knowledge', 'Знания проекта', '.aicraft/knowledge-base', '.aicraft/knowledge-base')
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
    if (info?.type !== 'file') throw diagnosticRejection(new Error('Artifact must be a regular file'))
    if (info.size !== undefined && info.size > MAX_BYTES) throw diagnosticRejection(new Error('Artifact is too large (limit: 2 MiB)'))
    const before = await fs.stat(target, signal)
    if (before?.type !== 'file') throw diagnosticRejection(new Error('Artifact must be a regular file'))
    const bytes = await fs.readBytes(target, signal, MAX_BYTES)
    const after = await fs.stat(target, signal)
    if (after?.version !== before.version) throw diagnosticRejection(new Error('The file changed while reading; reload it'))
    if (bytes.length > MAX_BYTES) throw diagnosticRejection(new Error('Artifact is too large (limit: 2 MiB)'))
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw diagnosticRejection(new Error('This file cannot be displayed as UTF-8 text')) }
    if (text.includes('\0')) throw diagnosticRejection(new Error('Binary files are not supported by this viewer'))
    return { path, text, version: before.version, format: /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text' }

  })
}
// END_METHOD_readMaterial

/**
 * START_METHOD_saveMaterial
 * Save existing Markdown only, using the version originally read by the editor.
 */
export async function saveMaterial(
  fs: FileSystem,
  cwd: string,
  path: string,
  text: string,
  version: string,
  lockWaitMs: number,
  signal: AbortSignal,
): Promise<MaterialDocument> {
  return diagnosticOperation({ path: 'src/work-materials/materials.ts', method: 'saveMaterial' }, { projectPath: cwd }, async () => {
    if (!/\.md$/i.test(path)) throw diagnosticRejection(new Error('Only .md files can be edited'))
    if (!version) throw diagnosticRejection(new Error('The original file version is required'))
    if (text.includes('\0')) throw diagnosticRejection(new Error('Markdown must not contain NUL bytes'))
    if (new TextEncoder().encode(text).length > MAX_BYTES) throw diagnosticRejection(new Error('Artifact is too large (limit: 2 MiB)'))
    return withFileLock(join(cwd, '.aicraft'), async () => {
      const target = await targetFor(fs, cwd, path, signal)
      await assertProjectWritable(fs, cwd, signal)
      const current = await fs.lstat(path, { cwd }, signal)
      if (current?.type !== 'file') throw diagnosticRejection(new Error('Artifact must be an existing regular file'))
      if (current.version !== version) throw diagnosticRejection(new Error('The file changed outside the editor. Your changes have not been saved; reload the file to continue.'))
      diagnosticAccepted({ path, text, version })
      const outcome = await diagnosticPublication(() => fs.writeText(target, text, { kind: 'replaceIfVersion', version: version as FsVersion }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
      return { path, text: outcome.after, version: outcome.version, format: 'markdown' }
    }, { waitMs: lockWaitMs })

  })
}
// END_METHOD_saveMaterial
