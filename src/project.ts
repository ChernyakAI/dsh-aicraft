import { readMaterial, targetFor } from './materials.ts'
import { processTemplate, templateRoleInstructions, defaultStepModel } from './process-templates.ts'
import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type Subprocess from '@deepseek-ai/dsh-subprocess'
import { parse, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { readTaskSnapshot, readTaskState, serializeState, assertProjectWritable, hasActiveRun } from './task-state.ts'
import { currentStepOf, processSchema, processDraftSchema } from './schemas.ts'
import type { CreateTaskRequest, ProjectView, InitializeProjectRequest, RunView, MaterialDocument } from './types.ts'

/** Execution limits supplied by the plugin configuration. */
export interface ProjectConfig {
  gitTimeoutMs: number
  gitGraceMs: number
  lockWaitMs: number
}

const requestSchema = z.object({
  taskIdentifier: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/, 'Task ID must contain 1–128 letters, digits, hyphens or underscores, starting with a letter or digit.')
    .refine(id => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id), 'This Task ID is reserved by Windows. Choose another ID.'),
  title: z.string().trim().min(1), processId: z.string().regex(/^[a-z][a-z0-9-]*$/), requestText: z.string().trim().min(1),
})
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

async function git(subprocess: Subprocess, cwd: string, args: string[], config: ProjectConfig, signal: AbortSignal): Promise<string | null> {
  const executable = await subprocess.resolveExecutable('git')
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(config.gitTimeoutMs)])
  const handle = subprocess.spawn({
    argv: [executable, ...args], cwd, signal: runSignal,
    graceMs: config.gitGraceMs, stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } },
  })
  const outcome = await handle.done
  runSignal.throwIfAborted()
  if (outcome.exitCode !== 0) return null
  const output = handle.collected.stdout?.readFrom(0)
  if (!output || output.lossy) throw new Error('Could not read complete Git output')
  return output.text.trim()
}

/** Per-worktree metadata directory; HEAD lives here even when .git is a file. */
export async function gitDirectory(subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal): Promise<string | null> {
  try { return await git(subprocess, cwd, ['rev-parse', '--absolute-git-dir'], config, signal) }
  catch { signal.throwIfAborted(); return null }
}

/** Read the branch as a reminder; missing Git never blocks project operations. */
export async function currentBranch(subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal): Promise<string | null> {
  try { return await git(subprocess, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], config, signal) }
  catch { signal.throwIfAborted(); return null }
}

async function text(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<string> {
  return fs.readText(await targetFor(fs, cwd, `.aicraft/${path}`, signal), signal)
}

/** Prefer project rules; read legacy projects without changing files during queries. */
async function projectRulesFile(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<string> {
  for (const file of ['project-rules.md', 'agent-rules.md']) {
    await targetFor(fs, cwd, `.aicraft/${file}`, signal)
    if (await fs.lstat(`.aicraft/${file}`, { cwd }, signal)) return file
  }
  return 'project-rules.md'
}

/** Called only under the project writer lock by explicit open/prepare operations. */
async function migrateProjectRules(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<void> {
  if (await projectRulesFile(fs, cwd, signal) !== 'agent-rules.md') return
  const source = await targetFor(fs, cwd, '.aicraft/agent-rules.md', signal)
  const target = await targetFor(fs, cwd, '.aicraft/project-rules.md', signal)
  const document = await readMaterial(fs, cwd, '.aicraft/agent-rules.md', signal)
  const from = fileURLToPath(fs.fileUrl(source)), to = fileURLToPath(fs.fileUrl(target))
  if (fs.processPathFromHostPath(from) !== fs.processPath(source) || fs.processPathFromHostPath(to) !== fs.processPath(target)) throw new Error('This filesystem does not support local rules renaming')
  if ((await fs.lstat('.aicraft/agent-rules.md', { cwd }, signal))?.version !== document.version) throw new Error('Project rules changed before renaming. Try again.')
  if (await fs.lstat('.aicraft/project-rules.md', { cwd }, signal)) return
  signal.throwIfAborted()
  await rename(from, to)
}

/** Explicit Project rules action; preserve existing instructions when adopting the new name. */
export async function openProjectRules(fs: FileSystem, cwd: string, waitMs: number, signal: AbortSignal): Promise<MaterialDocument> {
  return withFileLock(join(cwd, '.aicraft'), async () => {
    await assertProjectWritable(fs, cwd, signal)
    await migrateProjectRules(fs, cwd, signal)
    return readMaterial(fs, cwd, '.aicraft/project-rules.md', signal)
  }, { waitMs })
}

async function process(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<z.infer<typeof processSchema>> {
  const errors: ParseError[] = []
  const value: unknown = parse(await text(fs, cwd, `config/processes/${id}.jsonc`, signal), errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Process ${id} contains invalid JSONC`)
  return processDraftSchema.parse(value)
}

/**
 * Read preparation, current branch, process choices and the current task.
 * @param fs - DSH filesystem.
 * @param subprocess - DSH process provider for read-only Git commands.
 * @param cwd - Canonical local project directory.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Project readiness and task state.
 */
export async function readProject(fs: FileSystem, subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal): Promise<ProjectView> {
  const task = await readTaskSnapshot(fs, cwd, signal)
  const branch = await currentBranch(subprocess, cwd, config, signal)
  const prepared = await hasAicraftProject(fs, cwd, signal)
  const requiredFiles = await Promise.all(Object.keys(defaults).map(async path => fs.stat(await targetFor(fs, cwd, `.aicraft/${path === 'project-rules.md' ? await projectRulesFile(fs, cwd, signal) : path}`, signal), signal)))
  const needsPreparation = requiredFiles.some(info => info?.type !== 'file')
  const result: ProjectView = { prepared, needsPreparation, branch, creationIssue: null, executionIssue: null, processes: [], task, requestTemplate: '' }
  if (task.kind === 'task') {
    const current = task.tasks[0]!
    const step = current.steps.find(item => item.id === current.currentStep)
    if (step) {
      try { await readExecutionInputs(fs, cwd, current.id, step.role, signal) }
      catch (error) {
        signal.throwIfAborted()
        result.executionIssue = error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (!prepared) { result.creationIssue ??= 'Prepare AICraft project files first.'; return result }
  try {
    result.requestTemplate = await text(fs, cwd, 'request.md', signal)
    const directory = await targetFor(fs, cwd, '.aicraft/config/processes', signal)
    let readyProcess = false
    for (const entry of await fs.listDir(directory, signal)) {
      if (entry.type !== 'file' || !entry.name.endsWith('.jsonc')) continue
      const id = entry.name.slice(0, -6)
      if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Process filenames must be lowercase identifiers')
      const definition = await process(fs, cwd, id, signal)
      readyProcess ||= definition.steps.length > 0
      result.processes.push({ id, name: definition.name })
    }
    result.processes.sort((a, b) => a.id.localeCompare(b.id))
    if (!result.creationIssue && task.kind !== 'empty') result.creationIssue = 'Resolve or close the current task before creating another.'
    if (!result.creationIssue && result.processes.length === 0) result.creationIssue = 'Add a process definition before creating a task.'
    if (!result.creationIssue && !readyProcess) result.creationIssue = 'Add roles and at least one step in Project settings before creating a task.'
  } catch (error) {
    signal.throwIfAborted()
    result.creationIssue = error instanceof Error ? error.message : String(error)
  }
  return result
}

/**
 * Identify an MVP project by its directory, without requiring metadata files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param signal - Caller cancellation.
 * @returns Whether .aicraft exists as a directory.
 */
export async function hasAicraftProject(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<boolean> {
  return (await fs.stat(await targetFor(fs, cwd, '.aicraft/', signal), signal))?.type === 'directory'
}

/**
 * Validate and read the same executor inputs for the panel and dispatch.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param taskId - Task identity obtained from the current snapshot.
 * @param roleId - Role identity from the saved process.
 * @param signal - Caller cancellation.
 * @returns Current rules, role and task requirements.
 */
export async function readExecutionInputs(fs: FileSystem, cwd: string, taskId: string, roleId: string, signal: AbortSignal) {
  const read = async (path: string, missing: string): Promise<string> => {
    const target = await targetFor(fs, cwd, path, signal)
    const info = await fs.stat(target, signal)
    if (!info) throw new Error(missing)
    if (info.type !== 'file') throw new Error(`Executor input must be a file: ${path}`)
    const content = await fs.readText(target, signal)
    if (!content.trim()) throw new Error(`Executor input must not be empty: ${path}`)
    return content
  }
  const rules = await read(`.aicraft/${await projectRulesFile(fs, cwd, signal)}`, 'Missing .aicraft/project-rules.md. Prepare or restore the project rules before starting an executor.')
  const rolePath = `.aicraft/config/roles/${roleId}.md`
  const role = await read(rolePath, `Add the role instruction in ${rolePath} before starting an executor.`)
  const requestPath = `.aicraft/tasks/${taskId}/request.md`
  const request = await read(requestPath, `Add task requirements in ${requestPath} before starting an executor.`)
  return { rules, role, request }
}

async function createText(fs: FileSystem, cwd: string, path: string, content: string, signal: AbortSignal): Promise<void> {
  const target = await targetFor(fs, cwd, `.aicraft/${path}`, signal)
  await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
}

/**
 * Create missing defaults without overwriting existing project materials.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Updated project readiness.
 */
export async function prepareProject(fs: FileSystem, subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal, request: InitializeProjectRequest | null = null): Promise<ProjectView> {
  const input = request === null ? null : z.object({ template: z.enum(['ru', 'en', 'manual']), processId: z.string().regex(/^[a-z][a-z0-9-]*$/), definition: processDraftSchema.nullable() }).parse(request)
  const language = input?.template === 'en' || input?.template === 'manual' ? 'en' : 'ru'
  const definition = input?.template === 'manual' ? input.definition : input ? processTemplate(language) : defaultProcess
  if (!definition || !definition.name.trim() || definition.steps.some(step => !step.title.trim())) throw new Error('Enter a process name and names for any steps.')
  const roles: Record<string, string> = input?.template === 'manual' ? {} : templateRoleInstructions(language)
  if (input?.template !== 'manual' && definition.steps.some(step => !roles[step.role])) throw new Error('Choose a supported role for each step.')
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
    if (input && await fs.stat(target, signal)) throw new Error('A process with this ID already exists. Choose another ID.')
    await migrateProjectRules(fs, cwd, signal)
    for (const path of Object.keys(files)) await targetFor(fs, cwd, `.aicraft/${path}`, signal)
    for (const [path, content] of Object.entries(files)) {
      if (!await fs.stat(await targetFor(fs, cwd, `.aicraft/${path}`, signal), signal)) await createText(fs, cwd, path, content, signal)
    }
    if (!await fs.stat(target, signal)) await createText(fs, cwd, processPath, JSON.stringify(definition, null, 2) + '\n', signal)
    return readProject(fs, subprocess, cwd, config, signal)
  }, { waitMs: config.lockWaitMs })
}

/**
 * Create one task after rechecking project restrictions under a writer lock.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param request - Developer requirements and selected process.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Updated project with its single open task.
 */
export async function createTask(fs: FileSystem, subprocess: Subprocess, cwd: string, request: CreateTaskRequest, config: ProjectConfig, signal: AbortSignal): Promise<ProjectView> {
  const input = requestSchema.parse(request)
  return withFileLock(join(cwd, '.aicraft'), async () => {
    signal.throwIfAborted()
    const id = input.taskIdentifier
    const destination = await targetFor(fs, cwd, `.aicraft/tasks/${id}`, signal)
    if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw new Error(`Task directory "${id}" already exists. Choose another Task ID.`)
    const before = await readProject(fs, subprocess, cwd, config, signal)
    if (before.creationIssue) throw new Error(before.creationIssue)
    if (!before.processes.some(item => item.id === input.processId)) throw new Error('The selected process does not exist')
    const route = processSchema.parse(await process(fs, cwd, input.processId, signal))
    for (const step of route.steps) {
      if (!(await text(fs, cwd, `config/roles/${step.role}.md`, signal)).trim()) throw new Error(`Role ${step.role} has no instructions`)
    }
    if (!(await text(fs, cwd, await projectRulesFile(fs, cwd, signal), signal)).trim()) throw new Error('The project has no project rules')
    const staging = `tasks/.creating-${randomUUID()}`
    const stagingPath = join(cwd, '.aicraft', staging)
    try {
      await createText(fs, cwd, `${staging}/request.md`, `${input.requestText}\n`, signal)
      for (const step of route.steps) await createText(fs, cwd, `${staging}/${step.id}/.gitkeep`, '', signal)
      await createText(fs, cwd, `${staging}/process.json`, JSON.stringify(route, null, 2) + '\n', signal)
      await createText(fs, cwd, `${staging}/state.json`, serializeState({
        taskType: input.processId, taskIdentifier: id, taskTitle: input.title, status: 'open',
        ...(before.branch ? { createdBranch: before.branch } : {}),
        stepStates: route.steps.map((step, index) => ({ id: step.id, status: index === 0 ? 'current' : 'pending' })),
      }), signal)
      signal.throwIfAborted()
      if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw new Error(`Task directory "${id}" already exists. Choose another Task ID.`)
      await rename(stagingPath, fs.processPath(destination))
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true })
      throw error
    }
    return readProject(fs, subprocess, cwd, config, signal)
  }, { waitMs: config.lockWaitMs })
}

/**
 * Apply one explicit task command; preserve process and all stage materials.
 * @param fs - DSH filesystem provider.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical project directory.
 * @param taskId - Exact open task identity from the caller's view.
 * @param operation - Stage selection, completion, or separate task closure.
 * @param stepId - Stage identity for move/complete/skip; null for closure.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @param fromStepId - Source stage for an explicit return.
 * @param isActive - Shared executor check including live native chat continuations.
 * @returns Updated project state.
 */
export async function updateTask(fs: FileSystem, subprocess: Subprocess, cwd: string, taskId: string, operation: 'move' | 'goto' | 'return' | 'complete' | 'skip' | 'close' | 'reopen', stepId: string | null, config: ProjectConfig, signal: AbortSignal, fromStepId?: string, isActive: (run: RunView) => boolean | Promise<boolean> = run => ['starting', 'running'].includes(run.status)): Promise<ProjectView> {
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).parse(taskId)
  return withFileLock(join(cwd, '.aicraft'), async () => {
    signal.throwIfAborted()
    const before = await readProject(fs, subprocess, cwd, config, signal)
    if (operation === 'reopen') {
      if (before.task.kind !== 'empty') throw new Error('Finish the open task before reopening another task; refresh if the project is invalid or ambiguous')
      if (!before.task.allTasks.some(task => task.id === taskId && task.status !== 'open')) throw new Error('The closed task was not found')
      if (await hasActiveRun(before.task.allTasks.flatMap(task => task.runs), isActive)) throw new Error('Wait for the active executor to finish before reopening a task')
    } else if (before.task.kind !== 'task' || before.task.tasks[0]?.id !== taskId) throw new Error('The current task changed or is ambiguous; refresh the project')
    const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/state.json`, signal)
    const info = await fs.stat(target, signal)
    if (!info || info.type !== 'file') throw new Error('The task state file is missing')
    const state = await readTaskState(fs, cwd, taskId, signal)
    if (operation !== 'reopen' && state.status !== 'open') throw new Error('The task is already closed')
    if (await hasActiveRun(state.runs, isActive)) throw new Error('Wait for the active executor to finish before changing the task')
    const current = currentStepOf(state)
    if (operation === 'reopen') {
      state.status = 'open'
    } else if (operation === 'close') {
      state.status = 'completed'
    } else {
      const targetIndex = state.process.steps.findIndex(step => step.id === stepId)
      if (targetIndex < 0 || stepId === null) throw new Error('The requested step is not in the saved process')
      const selected = state.stepStates.find(step => step.id === stepId)!
      if (selected.status === 'cancelled' && ['move', 'goto', 'return'].includes(operation)) throw new Error('Cancelled steps cannot be selected')
      const currentIndex = state.process.steps.findIndex(step => step.id === current)
      if (operation === 'return') {
        if (fromStepId !== current || state.stepStates.find(step => step.id === fromStepId)?.status !== 'current') throw new Error('Only the current running step can return to an earlier step')
        const steps = before.task.tasks[0]!.steps
        const fromIndex = steps.findIndex(step => step.id === fromStepId)
        const excluded = (index: number) => index < 0 || steps[index]!.status === 'cancelled'
        if (excluded(fromIndex) || excluded(targetIndex) || targetIndex >= fromIndex) throw new Error('Return requires an earlier step that is not cancelled')
      }
      if (operation === 'goto') {
        for (const step of state.stepStates) if (step.status === 'current') step.status = 'pending'
        selected.status = 'current'
      } else if (operation === 'complete' || operation === 'skip') {
        if (current !== stepId || state.stepStates.find(step => step.id === stepId)?.status !== 'current') throw new Error('Only the current running step can be completed or skipped')
        state.stepStates.find(step => step.id === stepId)!.status = operation === 'complete' ? 'done' : 'skipped'
        const next = state.process.steps.slice(targetIndex + 1).find(step => state.stepStates.find(item => item.id === step.id)?.status === 'pending')
        if (next) state.stepStates.find(step => step.id === next.id)!.status = 'current'
      } else {
        for (const [index, step] of state.process.steps.entries()) {
          const previous = state.stepStates.find(item => item.id === step.id)!
          if (previous.status === 'cancelled' || (operation === 'return' && previous.status === 'skipped')) continue
          if (((operation === 'return' || targetIndex <= currentIndex) && index > targetIndex) || previous.status === 'current') {
            previous.status = 'pending'
          }
        }
        state.stepStates.find(step => step.id === stepId)!.status = 'current'
      }
    }
    if (operation !== 'reopen' && !await fs.stat(await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal), signal)) {
      await createText(fs, cwd, `tasks/${taskId}/process.json`, JSON.stringify(state.process, null, 2) + '\n', signal)
    }
    await fs.writeText(target, serializeState(state), { kind: 'replaceIfVersion', version: info.version }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    return readProject(fs, subprocess, cwd, config, signal)
  }, { waitMs: config.lockWaitMs })
}
