/**
 * FILE: plugin/src/project-settings/settings.ts
 * DESCRIPTION: Read editable processes and role documents
 */
import { diagnosticOperation } from '../dsh-integration/diagnostics.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { readMaterial,targetFor } from '../work-materials/materials.ts'
import { readProcess } from './processes.ts'
import type { ProjectSettings } from './types.ts'
/**
 * START_METHOD_readSettings
 * Read project templates and role choices, independently of task state.
 */
export async function readSettings(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<ProjectSettings> {
  return diagnosticOperation({ path: 'src/project-settings/settings.ts', method: 'readSettings' }, { projectPath: cwd }, async () => {
    const result: ProjectSettings = { processes: [], roles: [], roleDocuments: [] }
    for (const kind of ['processes', 'roles'] as const) {
      const dir = await targetFor(fs, cwd, `.aicraft/config/${kind}`, signal)
      if (!await fs.stat(dir, signal)) continue
      for (const entry of await fs.listDir(dir, signal)) {
        const match = entry.name.match(kind === 'processes' ? /^([a-z][a-z0-9-]*)\.jsonc$/ : /^([a-z][a-z0-9-]*)\.md$/)
        if (!match) continue
        if (kind === 'processes') result.processes.push(await readProcess(fs, cwd, match[1]!, signal))
        else {
          const role = await readMaterial(fs, cwd, `.aicraft/config/roles/${entry.name}`, signal)
          result.roles.push(match[1]!)
          result.roleDocuments.push({ id: match[1]!, text: role.text, version: role.version })
        }
      }
    }
    result.processes.sort((a, b) => a.id.localeCompare(b.id)); result.roles.sort(); result.roleDocuments.sort((a, b) =>
      a.id.localeCompare(b.id))
    return result

  })
}
// END_METHOD_readSettings
