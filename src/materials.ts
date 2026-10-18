import { createArtifactScanner, targetFor } from './artifact-files.ts'
export { targetFor } from './artifact-files.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { join } from 'node:path'
import type { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs'
import { stateSchema } from './schemas.ts'
import { readTaskState, assertProjectWritable } from './task-state.ts'
import type { MaterialDocument, MaterialFile, MaterialGroup } from './types.ts'

const MAX_BYTES = 2 * 1024 * 1024

/** List task and project documents without reading their contents or requiring a chat. */
export async function listMaterials(fs: FileSystem, cwd: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]> {
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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw new Error('Invalid task identifier')
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
}

/** Read bounded UTF-8 content; unsupported or binary files never render as HTML. */
export async function readMaterial(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<MaterialDocument> {
  const target = await targetFor(fs, cwd, path, signal)
  const info = await fs.lstat(path, { cwd }, signal)
  if (info?.type !== 'file') throw new Error('Artifact must be a regular file')
  if (info.size !== undefined && info.size > MAX_BYTES) throw new Error('Artifact is too large (limit: 2 MiB)')
  const before = await fs.stat(target, signal)
  if (before?.type !== 'file') throw new Error('Artifact must be a regular file')
  const bytes = await fs.readBytes(target, signal, MAX_BYTES)
  const after = await fs.stat(target, signal)
  if (after?.version !== before.version) throw new Error('The file changed while reading; reload it')
  if (bytes.length > MAX_BYTES) throw new Error('Artifact is too large (limit: 2 MiB)')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('This file cannot be displayed as UTF-8 text') }
  if (text.includes('\0')) throw new Error('Binary files are not supported by this viewer')
  return { path, text, version: before.version, format: /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text' }
}

/** Save existing Markdown only, using the version originally read by the editor. */
export async function saveMaterial(fs: FileSystem, cwd: string, path: string, text: string, version: string, lockWaitMs: number, signal: AbortSignal): Promise<MaterialDocument> {
  if (!/\.md$/i.test(path)) throw new Error('Only .md files can be edited')
  if (!version) throw new Error('The original file version is required')
  if (text.includes('\0')) throw new Error('Markdown must not contain NUL bytes')
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Artifact is too large (limit: 2 MiB)')
  return withFileLock(join(cwd, '.aicraft'), async () => {
    const target = await targetFor(fs, cwd, path, signal)
    await assertProjectWritable(fs, cwd, signal)
    const current = await fs.lstat(path, { cwd }, signal)
    if (current?.type !== 'file') throw new Error('Artifact must be an existing regular file')
    if (current.version !== version) throw new Error('The file changed outside the editor. Your changes have not been saved; reload the file to continue.')
    const outcome = await fs.writeText(target, text, { kind: 'replaceIfVersion', version: version as FsVersion }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    return { path, text: outcome.after, version: outcome.version, format: 'markdown' }
  }, { waitMs: lockWaitMs })
}
