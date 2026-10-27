/**
 * FILE: plugin/src/project-settings/project.ts
 * DESCRIPTION: Read project readiness and prepare missing settings
 */
import { diagnosticAccepted, diagnosticPublication, diagnosticOperation, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type Subprocess from '@deepseek-ai/dsh-subprocess'
import { join } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig } from '../dsh-integration/config.ts'
import type { ProjectReader,ProjectView } from '../dsh-integration/types.ts'
import { assertProjectWritable } from '../task-management/queries.ts'
import { targetFor } from '../work-materials/materials.ts'
import { process } from './processes.ts'
import { migrateProjectRules,projectRulesFile } from './rules.ts'
import { processDraftSchema } from './schemas.ts'
import { defaultStepModel,processTemplate,templateRoleInstructions } from './templates.ts'
import type { InitializeProjectRequest,ProjectReadiness } from './types.ts'

const defaultProcess = {
  language: 'ru',
  name: 'Анализ → изменение файла → ревью',
  steps: [
    { id: 'analysis', title: 'Анализ', role: 'analyst', model: defaultStepModel() },
    { id: 'implementation', title: 'Изменение файла', role: 'developer', model: defaultStepModel() },
    { id: 'review', title: 'Ревью', role: 'reviewer', model: defaultStepModel() },
  ],
}

const defaults: Record<string, string> = {

  'project-rules.md': '## Общие правила\n\nРаботай только в пределах постановки задачи. При недостатке требований задай вопрос разработчику. Сохраняй результат в каталоге этапа. Не переводи и не закрывай задачу самостоятельно. Не создавай коммиты, не переключай ветки и не отправляй изменения без отдельного поручения.\n',
  'request.md': '# Постановка задачи\n\n## Требования\n\n## Ожидаемый результат\n\n## Условия приёмки\n',
  'knowledge-base/.gitkeep': '',
  'tasks/.gitkeep': '',
}
export async function text(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<string> {
  return fs.readText(await targetFor(fs, cwd, `.aicraft/${path}`, signal), signal)
}
export async function createText(fs: FileSystem, cwd: string, path: string, content: string, signal: AbortSignal): Promise<void> {
  const target = await targetFor(fs, cwd, `.aicraft/${path}`, signal)
  await diagnosticPublication(() => fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
}

/**
 * START_METHOD_hasAicraftProject
 * Identify an MVP project by its directory, without requiring metadata files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param signal - Caller cancellation.
 * @returns Whether .aicraft exists as a directory.
 */
export async function hasAicraftProject(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<boolean> {
  return diagnosticOperation({ path: 'src/project-settings/project.ts', method: 'hasAicraftProject' }, { projectPath: cwd }, async () => {
    return (await fs.stat(await targetFor(fs, cwd, '.aicraft/', signal), signal))?.type === 'directory'

  })
}
// END_METHOD_hasAicraftProject

/**
 * START_METHOD_readProjectReadiness
 * Read project settings readiness without task or executor projections.
 */

export async function readProjectReadiness(fs: FileSystem, cwd: string, signal: AbortSignal, canCreate = true): Promise<ProjectReadiness> {
  return diagnosticOperation({ path: 'src/project-settings/project.ts', method: 'readProjectReadiness' }, { projectPath: cwd }, async () => {
    const prepared = await hasAicraftProject(fs, cwd, signal)
    const requiredFiles = await Promise.all(Object.keys(defaults).map(async path => fs.stat(await targetFor(fs, cwd, `.aicraft/${path === 'project-rules.md' ? await projectRulesFile(fs, cwd, signal) : path}`, signal), signal)))
    const needsPreparation = requiredFiles.some(info => info?.type !== 'file')
    const result: ProjectReadiness = { prepared, needsPreparation, creationIssue: null, processes: [], requestTemplate: '' }
    if (!prepared) { result.creationIssue ??= 'Prepare AICraft project files first.'; return result }
    try {
      result.requestTemplate = await text(fs, cwd, 'request.md', signal)
      const directory = await targetFor(fs, cwd, '.aicraft/config/processes', signal)
      let readyProcess = false
      for (const entry of await fs.listDir(directory, signal)) {
        if (entry.type !== 'file' || !entry.name.endsWith('.jsonc')) continue
        const id = entry.name.slice(0, -6)
        if (!/^[a-z][a-z0-9-]*$/.test(id)) throw diagnosticRejection(new Error('Process filenames must be lowercase identifiers'))
        const definition = await process(fs, cwd, id, signal)
        readyProcess ||= definition.steps.length > 0
        result.processes.push({ id, name: definition.name })
      }
      result.processes.sort((a, b) => a.id.localeCompare(b.id))
      if (!result.creationIssue && !canCreate) result.creationIssue = 'Resolve or close the current task before creating another.'
      if (!result.creationIssue && result.processes.length === 0) result.creationIssue = 'Add a process definition before creating a task.'
      if (!result.creationIssue && !readyProcess) result.creationIssue = 'Add roles and at least one step in Project settings before creating a task.'
    } catch (error) {
      signal.throwIfAborted()
      result.creationIssue = error instanceof Error ? error.message : String(error)
    }
    return result

  })
}
// END_METHOD_readProjectReadiness

/**
 * START_METHOD_prepareProject
 * Create missing defaults without overwriting existing project materials.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Updated project readiness.
 */
export async function prepareProject(
  fs: FileSystem,
  subprocess: Subprocess,
  cwd: string,
  config: ProjectConfig,
  signal: AbortSignal,
  request: InitializeProjectRequest | null,
  readProject: ProjectReader,
): Promise<ProjectView> {
  return diagnosticOperation({ path: 'src/project-settings/project.ts', method: 'prepareProject' }, { projectPath: cwd }, async () => {
    const input = request === null ? null : z.object({ template: z.enum(['ru', 'en', 'manual']), processId: z.string().regex(/^[a-z][a-z0-9-]*$/), definition: processDraftSchema.nullable() }).parse(request)
    const language = input?.template === 'en' || input?.template === 'manual' ? 'en' : 'ru'
    const definition = input?.template === 'manual' ? input.definition : input ? processTemplate(language) : defaultProcess
    if (!definition || !definition.name.trim() || definition.steps.some(step => !step.title.trim())) throw diagnosticRejection(new Error('Enter a process name and names for any steps.'))
    const roles: Record<string, string> = input?.template === 'manual' ? {} : templateRoleInstructions(language)
    if (input?.template !== 'manual' && definition.steps.some(step => !roles[step.role])) throw diagnosticRejection(new Error('Choose a supported role for each step.'))
    const processPath = `config/processes/${input?.processId ?? 'manual'}.jsonc`
    const files = { ...defaults, ...Object.fromEntries(Object.entries(roles).map(([id, text]) => [`config/roles/${id}.md`, text])) }
    if (language === 'en') {
      files['project-rules.md'] = '## Shared rules\n\nWork only within the task requirements. Ask the user if requirements are incomplete. Save results in the step directory. Do not advance or close the task yourself. Do not create commits, switch branches or push changes without a separate instruction.\n'
      files['request.md'] = '# Task requirements\n\n## Requirements\n\n## Expected result\n\n## Acceptance criteria\n'
    }
    for (const path of [...Object.keys(files), processPath]) await targetFor(fs, cwd, `.aicraft/${path}`, signal)
    return withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      await assertProjectWritable(fs, cwd, signal)
      const target = await targetFor(fs, cwd, `.aicraft/${processPath}`, signal)
      if (input && await fs.stat(target, signal)) throw diagnosticRejection(new Error('A process with this ID already exists. Choose another ID.'))
      await migrateProjectRules(fs, cwd, signal)
      for (const path of Object.keys(files)) await targetFor(fs, cwd, `.aicraft/${path}`, signal)
      diagnosticAccepted({ input, language })
      for (const [path, content] of Object.entries(files)) {
        if (!await fs.stat(await targetFor(fs, cwd, `.aicraft/${path}`, signal), signal)) await createText(fs, cwd, path, content, signal)
      }
      if (!await fs.stat(target, signal)) await createText(fs, cwd, processPath, JSON.stringify(definition, null, 2) + '\n', signal)
      return readProject(fs, subprocess, cwd, config, signal)
    }, { waitMs: config.lockWaitMs })

  })
}
// END_METHOD_prepareProject
