/**
 * FILE: plugin/src/project-settings/roles.ts
 * DESCRIPTION: Save and delete shared role instructions
 */
import { ownMessage, withUiMessage } from '../ui-message.ts'
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProjectWritable } from '../task-management/queries.ts'
import { readMaterial,saveMaterial,targetFor } from '../work-materials/materials.ts'
import { identifier } from './processes.ts'
import type { RoleDocument } from './types.ts'

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
    if (!text.trim() || text.includes('\0') || new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw diagnosticRejection(withUiMessage(new Error('Role instructions must be nonempty UTF-8 text, at most 2 MiB'), ownMessage({ key: 'reasonRoleInstructionsMustBeNonemptyUTF8TextAtMost2MiB' })))
    const path = `.aicraft/config/roles/${id}.md`
    if (version !== null) {
      const file = await saveMaterial(fs, cwd, path, text, version, waitMs, signal)
      return { id, text: file.text, version: file.version }
    }
    await targetFor(fs, cwd, path, signal)
    if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw diagnosticRejection(withUiMessage(new Error('Initialize an AICraft project first'), ownMessage({ key: 'reasonInitializeAnAICraftProjectFirst' })))
    return withFileLock(join(cwd, '.aicraft'), async () => {
      await assertProjectWritable(fs, cwd, signal)
      const target = await targetFor(fs, cwd, path, signal)
      if (await fs.lstat(path, { cwd }, signal)) throw diagnosticRejection(withUiMessage(new Error('A role with this ID already exists'), ownMessage({ key: 'reasonARoleWithThisIDAlreadyExists' })))
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
 * Delete the selected instruction, preserving every task and process reference.
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
    if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw diagnosticRejection(withUiMessage(new Error('Initialize an AICraft project first'), ownMessage({ key: 'reasonInitializeAnAICraftProjectFirst' })))
    await withFileLock(join(cwd, '.aicraft'), async () => {
      await assertProjectWritable(fs, cwd, signal)
      const target = await targetFor(fs, cwd, path, signal)
      const current = await fs.lstat(path, { cwd }, signal)
      if (!current || current.type !== 'file' || current.version !== version) throw diagnosticRejection(withUiMessage(new Error('Role changed outside the editor. Reload settings before deleting.'), ownMessage({ key: 'reasonRoleChangedOutsideTheEditorReloadSettingsBeforeDeleting' })))
      // shortcut: DSH has no file-delete service; only explicitly host-mapped files are supported.
      const hostPath = fileURLToPath(fs.fileUrl(target))
      if (fs.processPathFromHostPath(hostPath) !== fs.processPath(target)) throw diagnosticRejection(withUiMessage(new Error('This filesystem does not support local role deletion'), ownMessage({ key: 'reasonThisFilesystemDoesNotSupportLocalRoleDeletion' })))
      const latest = await fs.lstat(path, { cwd }, signal)
      if (!latest || latest.type !== 'file' || latest.version !== version) throw diagnosticRejection(withUiMessage(new Error('Role changed outside the editor. Reload settings before deleting.'), ownMessage({ key: 'reasonRoleChangedOutsideTheEditorReloadSettingsBeforeDeleting' })))
      signal.throwIfAborted()
      await diagnosticPublication(() => unlink(hostPath), hostPath, 'unlink')
    }, { waitMs })

  })
}
// END_METHOD_deleteRole
