/**
 * FILE: plugin/src/project-settings/roles.ts
 * DESCRIPTION: Save and delete shared role instructions
 */
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProjectWritable } from '../task-management/queries.ts'
import { readMaterial,saveMaterial,targetFor } from '../work-materials/materials.ts'
import { definition,identifier,readProcess } from './processes.ts'
import { readSettings } from './settings.ts'
import type { ProcessDefinition,RoleDocument } from './types.ts'

/**
 * START_METHOD_saveRole
 * Save a shared role instruction, using the material editor's versioned writer for edits.
 */
export async function saveRole(
  fs: FileSystem,
  cwd: string,
  id: string,
  text: string,
  version: string | null,
  waitMs: number,
  signal: AbortSignal,
): Promise<RoleDocument> {
  return diagnosticOperation({ path: 'src/project-settings/roles.ts', method: 'saveRole' }, { projectPath: cwd }, async () => {
    identifier(id)
    if (!text.trim() || text.includes('\0') || new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw diagnosticRejection(new Error('Role instructions must be nonempty UTF-8 text, at most 2 MiB'))
    const path = `.aicraft/config/roles/${id}.md`
    if (version !== null) {
      const file = await saveMaterial(fs, cwd, path, text, version, waitMs, signal)
      return { id, text: file.text, version: file.version }
    }
    await targetFor(fs, cwd, path, signal)
    if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw diagnosticRejection(new Error('Initialize an AICraft project first'))
    return withFileLock(join(cwd, '.aicraft'), async () => {
      await assertProjectWritable(fs, cwd, signal)
      const target = await targetFor(fs, cwd, path, signal)
      if (await fs.lstat(path, { cwd }, signal)) throw diagnosticRejection(new Error('A role with this ID already exists'))
      diagnosticAccepted({ id, text, version })
      await diagnosticPublication(() => fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
      const file = await readMaterial(fs, cwd, path, signal)
      return { id, text: file.text, version: file.version }
    }, { waitMs })

  })
}
// END_METHOD_saveRole

/**
 * START_METHOD_deleteRole
 * Delete an unused role, preserving every task and process reference.
 */
export async function deleteRole(
  fs: FileSystem,
  cwd: string,
  id: string,
  version: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> {
  return diagnosticOperation({ path: 'src/project-settings/roles.ts', method: 'deleteRole' }, { projectPath: cwd }, async () => {
    identifier(id)
    const path = `.aicraft/config/roles/${id}.md`
    await targetFor(fs, cwd, path, signal)
    if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw diagnosticRejection(new Error('Initialize an AICraft project first'))
    await withFileLock(join(cwd, '.aicraft'), async () => {
      await assertProjectWritable(fs, cwd, signal)
      const target = await targetFor(fs, cwd, path, signal)
      const current = await fs.lstat(path, { cwd }, signal)
      if (!current || current.type !== 'file' || current.version !== version) throw diagnosticRejection(new Error('Role changed outside the editor. Reload settings before deleting.'))
      const settings = await readSettings(fs, cwd, signal)
      const used = settings.processes.find(process => process.definition.steps.some(step => step.role === id))
      if (used) throw diagnosticRejection(new Error(`Role is used by process "${used.definition.name}". Change its steps before deleting.`))
      const tasks = await targetFor(fs, cwd, '.aicraft/tasks', signal)
      if (await fs.stat(tasks, signal)) for (const entry of await fs.listDir(tasks, signal)) {
        if (entry.name.startsWith('.')) continue
        const base = `.aicraft/tasks/${entry.name}`
        const statePath = await targetFor(fs, cwd, `${base}/state.json`, signal)
        if (!await fs.stat(statePath, signal)) continue
        const state = JSON.parse((await readMaterial(fs, cwd, `${base}/state.json`, signal)).text) as { taskType: string }
        const snapshot = await targetFor(fs, cwd, `${base}/process.json`, signal)
        let process: ProcessDefinition
        if (await fs.stat(snapshot, signal)) process = definition((await readMaterial(fs, cwd, `${base}/process.json`, signal)).text)
        else { identifier(state.taskType); process = (await readProcess(fs, cwd, state.taskType, signal)).definition }
        if (process.steps.some(step => step.role === id)) throw diagnosticRejection(new Error(`Role is used by task "${entry.name}". Its saved process must retain the role.`))
      }
      // shortcut: DSH has no file-delete service; only explicitly host-mapped files are supported.
      const hostPath = fileURLToPath(fs.fileUrl(target))
      if (fs.processPathFromHostPath(hostPath) !== fs.processPath(target)) throw diagnosticRejection(new Error('This filesystem does not support local role deletion'))
      const latest = await fs.lstat(path, { cwd }, signal)
      if (!latest || latest.type !== 'file' || latest.version !== version) throw diagnosticRejection(new Error('Role changed outside the editor. Reload settings before deleting.'))
      signal.throwIfAborted()
      await diagnosticPublication(() => unlink(hostPath), hostPath, 'unlink')
    }, { waitMs })

  })
}
// END_METHOD_deleteRole
