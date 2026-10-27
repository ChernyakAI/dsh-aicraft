/**
 * FILE: plugin/src/task-management/commands.ts
 * DESCRIPTION: Apply explicit task creation and lifecycle commands
 */
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type Subprocess from '@deepseek-ai/dsh-subprocess'
import { randomUUID } from 'node:crypto'
import { rename,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ProjectConfig } from '../dsh-integration/config.ts'
import type { ProjectReader,ProjectView } from '../dsh-integration/types.ts'
import { readProcessForTask } from '../project-settings/processes.ts'
import { readRuns } from '../step-execution/history.ts'
import { hasActiveRun } from '../step-execution/runs.ts'
import type { RunView } from '../step-execution/types.ts'
import { targetFor } from '../work-materials/artifact-files.ts'
import { readTaskState } from './queries.ts'
import { requestSchema } from './schemas.ts'
import { currentStepOf,serializeState } from './state.ts'
import type { CreateTaskRequest } from './types.ts'

/**
 * START_METHOD_createTask
 * Create one task after rechecking project restrictions under a writer lock.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param request - Developer requirements and selected process.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Updated project with its single open task.
 */
export async function createTask(
  fs: FileSystem,
  subprocess: Subprocess,
  cwd: string,
  request: CreateTaskRequest,
  config: ProjectConfig,
  signal: AbortSignal,
  readProject: ProjectReader,
): Promise<ProjectView> {
  return diagnosticOperation({ path: 'src/task-management/commands.ts', method: 'createTask' }, { projectPath: cwd }, async () => {
    const input = requestSchema.parse(request)
    return withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      const id = input.taskIdentifier
      const destination = await targetFor(fs, cwd, `.aicraft/tasks/${id}`, signal)
      if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw diagnosticRejection(new Error(`Task directory "${id}" already exists. Choose another Task ID.`))
      const before = await readProject(fs, subprocess, cwd, config, signal)
      if (before.creationIssue) throw diagnosticRejection(new Error(before.creationIssue))
      if (!before.processes.some(item => item.id === input.processId)) throw diagnosticRejection(new Error('The selected process does not exist'))
      const route = await readProcessForTask(fs, cwd, input.processId, signal)
      diagnosticAccepted({ ...input, taskId: id })
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
        if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw diagnosticRejection(new Error(`Task directory "${id}" already exists. Choose another Task ID.`))
        await diagnosticPublication(() => rename(stagingPath, fs.processPath(destination)), fs.processPath(destination), 'rename')
      } catch (error) {
        await diagnosticPublication(() => rm(stagingPath, { recursive: true, force: true }), stagingPath, 'rm')
        throw error
      }
      return readProject(fs, subprocess, cwd, config, signal)
    }, { waitMs: config.lockWaitMs })

  })
}
// END_METHOD_createTask

/**
 * START_METHOD_updateTask
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
export async function updateTask(
  fs: FileSystem,
  subprocess: Subprocess,
  cwd: string,
  taskId: string,
  operation: 'move' | 'goto' | 'return' | 'complete' | 'skip' | 'close' | 'reopen',
  stepId: string | null,
  config: ProjectConfig,
  signal: AbortSignal,
  fromStepId: string | undefined,
  isActive: (run: RunView) => boolean | Promise<boolean>,
  readProject: ProjectReader,
): Promise<ProjectView> {
  return diagnosticOperation({ path: 'src/task-management/commands.ts', method: 'updateTask' }, { projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
    z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).parse(taskId)
    return withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      const before = await readProject(fs, subprocess, cwd, config, signal)
      if (operation === 'reopen') {
        if (before.task.kind !== 'empty') throw diagnosticRejection(new Error('Finish the open task before reopening another task; refresh if the project is invalid or ambiguous'))
        if (!before.task.allTasks.some(task => task.id === taskId && task.status !== 'open')) throw diagnosticRejection(new Error('The closed task was not found'))
        if (await hasActiveRun(before.task.allTasks.flatMap(task => task.runs), isActive)) throw diagnosticRejection(new Error('Wait for the active executor to finish before reopening a task'))
      } else if (before.task.kind !== 'task' || before.task.tasks[0]?.id !== taskId) throw diagnosticRejection(new Error('The current task changed or is ambiguous; refresh the project'))
      const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/state.json`, signal)
      const info = await fs.stat(target, signal)
      if (!info || info.type !== 'file') throw diagnosticRejection(new Error('The task state file is missing'))
      const state = { ...await readTaskState(fs, cwd, taskId, signal), runs: await readRuns(fs, cwd, taskId, signal) }
      if (operation !== 'reopen' && state.status !== 'open') throw diagnosticRejection(new Error('The task is already closed'))
      if (await hasActiveRun(state.runs, isActive)) throw diagnosticRejection(new Error('Wait for the active executor to finish before changing the task'))
      const current = currentStepOf(state)
      if (operation === 'reopen') {
        state.status = 'open'
      } else if (operation === 'close') {
        state.status = 'completed'
      } else {
        const targetIndex = state.process.steps.findIndex(step => step.id === stepId)
        if (targetIndex < 0 || stepId === null) throw diagnosticRejection(new Error('The requested step is not in the saved process'))
        const selected = state.stepStates.find(step => step.id === stepId)!
        if (selected.status === 'cancelled' && ['move', 'goto', 'return'].includes(operation)) throw diagnosticRejection(new Error('Cancelled steps cannot be selected'))
        const currentIndex = state.process.steps.findIndex(step => step.id === current)
        if (operation === 'return') {
          if (fromStepId !== current || state.stepStates.find(step => step.id === fromStepId)?.status !== 'current') throw diagnosticRejection(new Error('Only the current running step can return to an earlier step'))
          const steps = before.task.tasks[0]!.steps
          const fromIndex = steps.findIndex(step => step.id === fromStepId)
          const excluded = (index: number) => index < 0 || steps[index]!.status === 'cancelled'
          if (excluded(fromIndex) || excluded(targetIndex) || targetIndex >= fromIndex) throw diagnosticRejection(new Error('Return requires an earlier step that is not cancelled'))
        }
        if (operation === 'goto') {
          for (const step of state.stepStates) if (step.status === 'current') step.status = 'pending'
          selected.status = 'current'
        } else if (operation === 'complete' || operation === 'skip') {
          if (current !== stepId || state.stepStates.find(step => step.id === stepId)?.status !== 'current') throw diagnosticRejection(new Error('Only the current running step can be completed or skipped'))
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
      await diagnosticPublication(() => fs.writeText(target, serializeState(state), { kind: 'replaceIfVersion', version: info.version }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
      return readProject(fs, subprocess, cwd, config, signal)
    }, { waitMs: config.lockWaitMs })

  })
}
// END_METHOD_updateTask

async function createText(fs: FileSystem, cwd: string, path: string, content: string, signal: AbortSignal): Promise<void> {
  const target = await targetFor(fs, cwd, `.aicraft/${path}`, signal)
  await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
}
