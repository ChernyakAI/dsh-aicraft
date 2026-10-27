/**
 * FILE: plugin/src/project-settings/processes.ts
 * DESCRIPTION: Read and save project process definitions
 */
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem,FsTarget,FsVersion } from '@deepseek-ai/dsh-fs'
import { parse,type ParseError } from 'jsonc-parser'
import { join } from 'node:path'
import { z } from 'zod'
import { assertProjectWritable } from '../task-management/queries.ts'
import { readMaterial,targetFor } from '../work-materials/materials.ts'
import { text } from './project.ts'
import { projectRulesFile } from './rules.ts'
import { processDraftSchema,processSchema } from './schemas.ts'
import { templateRoleInstructions } from './templates.ts'
import type { ProcessDefinition,ProcessDocument,ProcessTemplateLanguage } from './types.ts'

export function identifier(id: string): void {
  if (typeof id !== 'string' || id !== id.trim() || !/^[a-z][a-z0-9-]*$/.test(id)) throw diagnosticRejection(new Error('Use a lowercase identifier with letters, digits and hyphens'))
}

export function definition(text: string) {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw diagnosticRejection(new Error('Process definition is invalid'))
  return processDraftSchema.parse(value)
}

export async function readProcess(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<ProcessDocument> {
  identifier(id)
  const file = await readMaterial(fs, cwd, `.aicraft/config/processes/${id}.jsonc`, signal)
  return { id, definition: definition(file.text), version: file.version }
}
/**
 * START_METHOD_saveProcess
 * Save only a project template with version checks; never rewrite task snapshots.
 */
export async function saveProcess(
  fs: FileSystem,
  cwd: string,
  id: string,
  input: ProcessDefinition,
  version: string | null,
  waitMs: number,
  signal: AbortSignal,
  templateLanguage: ProcessTemplateLanguage | null = null,
): Promise<ProcessDocument> {
  return diagnosticOperation({ path: 'src/project-settings/processes.ts', method: 'saveProcess' }, { projectPath: cwd }, async () => {
    identifier(id)
    if (templateLanguage !== null && (version !== null || !['ru', 'en'].includes(templateLanguage))) throw diagnosticRejection(new Error('Choose a bundled template only for a new process'))
    const value = processSchema.parse(input)
    if (!value.name.trim() || value.steps.some(step => !step.title.trim())) throw diagnosticRejection(new Error('Process and step names must not be empty'))
    await targetFor(fs, cwd, `.aicraft/config/processes/${id}.jsonc`, signal)
    if ((await fs.stat(await fs.resolve('.aicraft', { cwd, signal }), signal))?.type !== 'directory') throw diagnosticRejection(new Error('Initialize an AICraft project first'))
    return withFileLock(join(cwd, '.aicraft'), async () => {
      await assertProjectWritable(fs, cwd, signal)
      signal.throwIfAborted()
      const root = await fs.resolve('.aicraft', { cwd, signal })
      if ((await fs.stat(root, signal))?.type !== 'directory') throw diagnosticRejection(new Error('Initialize an AICraft project first'))
      const path = `.aicraft/config/processes/${id}.jsonc`
      const target = await targetFor(fs, cwd, path, signal)
      const current = await fs.lstat(path, { cwd }, signal)
      if (current?.type === 'symlink' || (current && current.type !== 'file')) throw diagnosticRejection(new Error('Process template must be a regular file'))
      if (version === null ? Boolean(current) : !current || current.version !== version) throw diagnosticRejection(new Error('Process changed outside the editor. Reload settings before saving.'))
      const instructions = templateLanguage ? templateRoleInstructions(templateLanguage) : {}
      const missing: { target: FsTarget; text: string }[] = []
      for (const role of new Set(value.steps.map(step => step.role))) {
        const rolePath = `.aicraft/config/roles/${role}.md`
        const roleTarget = await targetFor(fs, cwd, rolePath, signal)
        if (await fs.lstat(rolePath, { cwd }, signal)) await readMaterial(fs, cwd, rolePath, signal)
        else if (instructions[role]) missing.push({ target: roleTarget, text: instructions[role] })
        else throw diagnosticRejection(new Error(`Create role "${role}" before saving this process.`))
      }
      const original = current ? definition((await readMaterial(fs, cwd, path, signal)).text) : undefined
      const merged = { ...original, ...value, steps: value.steps.map(step => ({ ...original?.steps.find(old =>
        old.id === step.id), ...step })) }
      const text = JSON.stringify(merged, null, 2) + '\n'
      if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw diagnosticRejection(new Error('Process template is too large'))
      diagnosticAccepted(merged)
      for (const role of missing) await diagnosticPublication(() => fs.writeText(role.target, role.text, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), role.target, 'writeText')
      await diagnosticPublication(() => fs.writeText(target, text, version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version as FsVersion }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
      return readProcess(fs, cwd, id, signal)
    }, { waitMs: waitMs })

  })
}
// END_METHOD_saveProcess

export async function process(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<z.infer<typeof processSchema>> {
  const errors: ParseError[] = []
  const value: unknown = parse(await text(fs, cwd, `config/processes/${id}.jsonc`, signal), errors, { allowTrailingComma: true })
  if (errors.length) throw diagnosticRejection(new Error(`Process ${id} contains invalid JSONC`))
  return processDraftSchema.parse(value)
}
/**
 * START_METHOD_readProcessForTask
 * Validate the selected process and its current shared instructions.
 */
export async function readProcessForTask(fs: FileSystem, cwd: string, id: string, signal: AbortSignal) {
  return diagnosticOperation({ path: 'src/project-settings/processes.ts', method: 'readProcessForTask' }, { projectPath: cwd }, async () => {
    const route = processSchema.parse(await process(fs, cwd, id, signal))
    for (const step of route.steps) {
      if (!(await text(fs, cwd, `config/roles/${step.role}.md`, signal)).trim()) throw diagnosticRejection(new Error(`Role ${step.role} has no instructions`))
    }
    if (!(await text(fs, cwd, await projectRulesFile(fs, cwd, signal), signal)).trim()) throw diagnosticRejection(new Error('The project has no project rules'))
    return route

  })
}
// END_METHOD_readProcessForTask
