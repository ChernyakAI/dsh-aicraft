/**
 * FILE: plugin/src/project-settings/rules.ts
 * DESCRIPTION: Read and explicitly migrate shared project rules
 */
import { diagnosticPublication, diagnosticOperation, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import type { MaterialDocument } from '../work-materials/types.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProjectWritable } from '../task-management/queries.ts'
import { readMaterial,targetFor } from '../work-materials/materials.ts'

/** Prefer project rules; read legacy projects without changing files during queries. */
export async function projectRulesFile(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<string> {
  for (const file of ['project-rules.md', 'agent-rules.md']) {
    await targetFor(fs, cwd, `.aicraft/${file}`, signal)
    if (await fs.lstat(`.aicraft/${file}`, { cwd }, signal)) return file
  }
  return 'project-rules.md'
}
/** Called only under the project writer lock by explicit open/prepare operations. */
export async function migrateProjectRules(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<void> {
  if (await projectRulesFile(fs, cwd, signal) !== 'agent-rules.md') return
  const source = await targetFor(fs, cwd, '.aicraft/agent-rules.md', signal)
  const target = await targetFor(fs, cwd, '.aicraft/project-rules.md', signal)
  const document = await readMaterial(fs, cwd, '.aicraft/agent-rules.md', signal)
  const from = fileURLToPath(fs.fileUrl(source)), to = fileURLToPath(fs.fileUrl(target))
  if (fs.processPathFromHostPath(from) !== fs.processPath(source) || fs.processPathFromHostPath(to) !== fs.processPath(target)) throw diagnosticRejection(new Error('This filesystem does not support local rules renaming'))
  if ((await fs.lstat('.aicraft/agent-rules.md', { cwd }, signal))?.version !== document.version) throw diagnosticRejection(new Error('Project rules changed before renaming. Try again.'))
  if (await fs.lstat('.aicraft/project-rules.md', { cwd }, signal)) return
  signal.throwIfAborted()
  await diagnosticPublication(() => rename(from, to), to, 'rename')
}

/**
 * START_METHOD_openProjectRules
 * Explicit Project rules action; preserve existing instructions when adopting the new name.
 */
export async function openProjectRules(fs: FileSystem, cwd: string, waitMs: number, signal: AbortSignal): Promise<MaterialDocument> {
  return diagnosticOperation({ path: 'src/project-settings/rules.ts', method: 'openProjectRules' }, { projectPath: cwd }, async () => {
    return withFileLock(join(cwd, '.aicraft'), async () => {
      await assertProjectWritable(fs, cwd, signal)
      await migrateProjectRules(fs, cwd, signal)
      return readMaterial(fs, cwd, '.aicraft/project-rules.md', signal)
    }, { waitMs })

  })
}
// END_METHOD_openProjectRules

/**
 * START_METHOD_readRulesAndRole
 * Read current shared rules and the selected role without changing project files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param roleId - Role identity from the saved process.
 * @param signal - Caller cancellation.
 * @returns Current shared rules and the selected role instructions.
 */
export async function readRulesAndRole(fs: FileSystem, cwd: string, roleId: string, signal: AbortSignal) {
  return diagnosticOperation({ path: 'src/project-settings/rules.ts', method: 'readRulesAndRole' }, { projectPath: cwd }, async () => {
    const read = async (path: string, missing: string): Promise<string> => {
      const target = await targetFor(fs, cwd, path, signal)
      const info = await fs.stat(target, signal)
      if (!info) throw diagnosticRejection(new Error(missing))
      if (info.type !== 'file') throw diagnosticRejection(new Error(`Executor input must be a file: ${path}`))
      const content = await fs.readText(target, signal)
      if (!content.trim()) throw diagnosticRejection(new Error(`Executor input must not be empty: ${path}`))
      return content
    }
    const rules = await read(`.aicraft/${await projectRulesFile(fs, cwd, signal)}`, 'Missing .aicraft/project-rules.md. Prepare or restore the project rules before starting an executor.')
    const rolePath = `.aicraft/config/roles/${roleId}.md`
    const role = await read(rolePath, `Add the role instruction in ${rolePath} before starting an executor.`)
    return { rules, role }

  })
}
// END_METHOD_readRulesAndRole
