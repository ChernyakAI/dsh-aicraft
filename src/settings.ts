import { assertProjectWritable } from './task-state.ts'
import { templateRoleInstructions } from './process-templates.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { FileSystem, FsVersion, FsTarget } from '@deepseek-ai/dsh-fs'
import { parse, type ParseError } from 'jsonc-parser'
import { processDraftSchema, processSchema } from './schemas.ts'
import { readMaterial, saveMaterial, targetFor } from './materials.ts'
import type { ProcessDefinition, ProcessDocument, ProjectSettings, RoleDocument, ProcessTemplateLanguage } from './types.ts'

function identifier(id: string): void {
  if (typeof id !== 'string' || id !== id.trim() || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Use a lowercase identifier with letters, digits and hyphens')
}
function definition(text: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error('Process definition is invalid')
  return processDraftSchema.parse(value)
}
async function readProcess(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<ProcessDocument> {
  identifier(id)
  const file = await readMaterial(fs, cwd, `.aicraft/config/processes/${id}.jsonc`, signal)
  return { id, definition: definition(file.text), version: file.version }
}

/** Read project templates and role choices, independently of task state. */
export async function readSettings(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<ProjectSettings> {
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
  result.processes.sort((a, b) => a.id.localeCompare(b.id)); result.roles.sort(); result.roleDocuments.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

/** Save only a project template with version checks; never rewrite task snapshots. */
export async function saveProcess(fs: FileSystem, cwd: string, id: string, input: ProcessDefinition, version: string | null, waitMs: number, signal: AbortSignal, templateLanguage: ProcessTemplateLanguage | null = null): Promise<ProcessDocument> {
  identifier(id)
  if (templateLanguage !== null && (version !== null || !['ru', 'en'].includes(templateLanguage))) throw new Error('Choose a bundled template only for a new process')
  const value = processSchema.parse(input)
  if (!value.name.trim() || value.steps.some(step => !step.title.trim())) throw new Error('Process and step names must not be empty')
  await targetFor(fs, cwd, `.aicraft/config/processes/${id}.jsonc`, signal)
  if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw new Error('Initialize an AICraft project first')
  return withFileLock(join(cwd, '.aicraft'), async () => {
    await assertProjectWritable(fs, cwd, signal)
    signal.throwIfAborted()
    const root = await fs.resolve('.aicraft', { cwd, signal })
    if ((await fs.stat(root, signal))?.type !== 'directory') throw new Error('Initialize an AICraft project first')
    const path = `.aicraft/config/processes/${id}.jsonc`
    const target = await targetFor(fs, cwd, path, signal)
    const current = await fs.lstat(path, { cwd }, signal)
    if (current?.type === 'symlink' || (current && current.type !== 'file')) throw new Error('Process template must be a regular file')
    if (version === null ? Boolean(current) : !current || current.version !== version) throw new Error('Process changed outside the editor. Reload settings before saving.')
    const instructions = templateLanguage ? templateRoleInstructions(templateLanguage) : {}
    const missing: { target: FsTarget; text: string }[] = []
    for (const role of new Set(value.steps.map(step => step.role))) {
      const rolePath = `.aicraft/config/roles/${role}.md`
      const roleTarget = await targetFor(fs, cwd, rolePath, signal)
      if (await fs.lstat(rolePath, { cwd }, signal)) await readMaterial(fs, cwd, rolePath, signal)
      else if (instructions[role]) missing.push({ target: roleTarget, text: instructions[role] })
      else throw new Error(`Create role "${role}" before saving this process.`)
    }
    const original = current ? definition((await readMaterial(fs, cwd, path, signal)).text) : undefined
    const merged = { ...original, ...value, steps: value.steps.map(step => ({ ...original?.steps.find(old => old.id === step.id), ...step })) }
    const text = JSON.stringify(merged, null, 2) + '\n'
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Process template is too large')
    for (const role of missing) await fs.writeText(role.target, role.text, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    await fs.writeText(target, text, version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version as FsVersion }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    return readProcess(fs, cwd, id, signal)
  }, { waitMs: waitMs })
}

/** Save a shared role instruction, using the material editor's versioned writer for edits. */
export async function saveRole(fs: FileSystem, cwd: string, id: string, text: string, version: string | null, waitMs: number, signal: AbortSignal): Promise<RoleDocument> {
  identifier(id)
  if (!text.trim() || text.includes('\0') || new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Role instructions must be nonempty UTF-8 text, at most 2 MiB')
  const path = `.aicraft/config/roles/${id}.md`
  if (version !== null) {
    const file = await saveMaterial(fs, cwd, path, text, version, waitMs, signal)
    return { id, text: file.text, version: file.version }
  }
  await targetFor(fs, cwd, path, signal)
  if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw new Error('Initialize an AICraft project first')
  return withFileLock(join(cwd, '.aicraft'), async () => {
    await assertProjectWritable(fs, cwd, signal)
    const target = await targetFor(fs, cwd, path, signal)
    if (await fs.lstat(path, { cwd }, signal)) throw new Error('A role with this ID already exists')
    await fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    const file = await readMaterial(fs, cwd, path, signal)
    return { id, text: file.text, version: file.version }
  }, { waitMs })
}

/** Delete an unused role, preserving every task and process reference. */
export async function deleteRole(fs: FileSystem, cwd: string, id: string, version: string, waitMs: number, signal: AbortSignal): Promise<void> {
  identifier(id)
  const path = `.aicraft/config/roles/${id}.md`
  await targetFor(fs, cwd, path, signal)
  if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw new Error('Initialize an AICraft project first')
  await withFileLock(join(cwd, '.aicraft'), async () => {
    await assertProjectWritable(fs, cwd, signal)
    const target = await targetFor(fs, cwd, path, signal)
    const current = await fs.lstat(path, { cwd }, signal)
    if (!current || current.type !== 'file' || current.version !== version) throw new Error('Role changed outside the editor. Reload settings before deleting.')
    const settings = await readSettings(fs, cwd, signal)
    const used = settings.processes.find(process => process.definition.steps.some(step => step.role === id))
    if (used) throw new Error(`Role is used by process "${used.definition.name}". Change its steps before deleting.`)
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
      if (process.steps.some(step => step.role === id)) throw new Error(`Role is used by task "${entry.name}". Its saved process must retain the role.`)
    }
    // shortcut: DSH has no file-delete service; only explicitly host-mapped files are supported.
    const hostPath = fileURLToPath(fs.fileUrl(target))
    if (fs.processPathFromHostPath(hostPath) !== fs.processPath(target)) throw new Error('This filesystem does not support local role deletion')
    const latest = await fs.lstat(path, { cwd }, signal)
    if (!latest || latest.type !== 'file' || latest.version !== version) throw new Error('Role changed outside the editor. Reload settings before deleting.')
    signal.throwIfAborted()
    await unlink(hostPath)
  }, { waitMs })
}
