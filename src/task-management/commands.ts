/**
 * FILE: plugin/src/task-management/commands.ts
 * DESCRIPTION: Apply explicit task creation and lifecycle commands
 */
import { validate } from '../validation.ts'
import { ownMessage, withUiMessage } from '../ui-message.ts'
import { diagnosticAccepted, diagnosticEvent, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
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
import { OperationRefusal } from '../step-execution/application/observe-run.ts'
import type { MutationProgress, RunView } from '../step-execution/types.ts'
import { targetFor } from '../work-materials/artifact-files.ts'
import { readTaskState } from './queries.ts'
import { requestSchema } from './schemas.ts'
import { actualCurrentStep,currentStepOf,serializeState } from './state.ts'
import { TaskCreationRefusal } from './creation-result.ts'
import type { CreateTaskRequest,TaskChangeConfirmation,TaskCreationConfirmation } from './types.ts'

/**
 * START_METHOD_createTask
 * Create one task after rechecking project restrictions under a writer lock.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param request - Developer requirements and selected process.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Confirmation of the published task, without a second read.
 */
export async function createTask(
  fs: FileSystem,
  subprocess: Subprocess,
  cwd: string,
  request: CreateTaskRequest,
  config: ProjectConfig,
  signal: AbortSignal,
  readProject: ProjectReader,
): Promise<TaskCreationConfirmation> {
  return diagnosticOperation({ path: 'src/task-management/commands.ts', method: 'createTask' }, { projectPath: cwd }, async () => {
    let operationError: unknown
    let publicationStarted = false
    let confirmation: TaskCreationConfirmation | undefined
    try {
      const input = validate(requestSchema, request)
      return await withFileLock(join(cwd, '.aicraft'), async () => {
        try {
          signal.throwIfAborted()
          const id = input.taskIdentifier
          const destination = await targetFor(fs, cwd, `.aicraft/tasks/${id}`, signal)
          if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw diagnosticRejection(withUiMessage(new Error(`Task directory "${id}" already exists. Choose another Task ID.`), ownMessage({ key: 'reasonTaskDirectoryValue0AlreadyExistsChooseAnotherTaskID', params: { value0: id } })))
          const before = await readProject(fs, subprocess, cwd, config, signal)
          if (before.creationIssue) throw diagnosticRejection(withUiMessage(new Error(before.creationIssue), before.creationIssueMessage ?? { key: 'creationBlocked' }))
          if (!before.processes.some(item => item.id === input.processId)) throw diagnosticRejection(withUiMessage(new Error('The selected process does not exist'), ownMessage({ key: 'reasonTheSelectedProcessDoesNotExist' })))
          const route = await readProcessForTask(fs, cwd, input.processId, signal)
          diagnosticAccepted({ ...input, taskId: id })
          const staging = `tasks/.creating-${randomUUID()}`
          const stagingPath = join(cwd, '.aicraft', staging)
          const prepared: TaskCreationConfirmation = {
            taskIdentifier: id, title: input.title,
            initialState: { status: 'open', stepStates: route.steps.map((step, index) =>
              ({ id: step.id, status: index === 0 ? 'current' : 'pending' })) },
          }
          try {
            await createText(fs, cwd, `${staging}/request.md`, `${input.requestText}\n`, signal)
            for (const step of route.steps) await createText(fs, cwd, `${staging}/${step.id}/.gitkeep`, '', signal)
            await createText(fs, cwd, `${staging}/process.json`, JSON.stringify(route, null, 2) + '\n', signal)
            await createText(fs, cwd, `${staging}/state.json`, serializeState({
              taskType: input.processId, taskIdentifier: id, taskTitle: input.title, status: 'open',
              ...(before.branch ? { createdBranch: before.branch } : {}),
              stepStates: prepared.initialState.stepStates,
            }), signal)
            signal.throwIfAborted()
            if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw diagnosticRejection(withUiMessage(new Error(`Task directory "${id}" already exists. Choose another Task ID.`), ownMessage({ key: 'reasonTaskDirectoryValue0AlreadyExistsChooseAnotherTaskID', params: { value0: id } })))
            const publishedPath = fs.processPath(destination)
            await diagnosticPublication(async () => {
              publicationStarted = true
              await rename(stagingPath, publishedPath)
              confirmation = prepared
            }, publishedPath, 'rename')
          } catch (error) {
            try {
              await diagnosticPublication(() => rm(stagingPath, { recursive: true, force: true }), stagingPath, 'rm')
            } catch (cleanupError) {
              diagnosticEvent('task.creation-cleanup-failed', { error: cleanupError instanceof Error
                ? { name: cleanupError.name, message: cleanupError.message, stack: cleanupError.stack }
                : { message: String(cleanupError) } })
              throw new AggregateError([error, cleanupError], error instanceof Error ? error.message : String(error), { cause: error })
            }
            throw error
          }
          return prepared
        } catch (error) { operationError = error; throw error }
      }, { waitMs: config.lockWaitMs })
    } catch (error) {
      if (confirmation) {
        diagnosticEvent('task.creation-lock-release-failed', { error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } })
        return confirmation
      }
      const failure = operationError && operationError !== error
        ? new AggregateError([operationError, error],
          operationError instanceof Error ? operationError.message : String(operationError), { cause: operationError }) : error
      if (!publicationStarted) throw diagnosticRejection(new TaskCreationRefusal(request.taskIdentifier, failure))
      throw failure
    }

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
 * @param stepId - Stage identity for goto/return/complete/skip; null for closure.
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
  operation: 'goto' | 'return' | 'complete' | 'skip' | 'close' | 'reopen',
  stepId: string | null,
  config: ProjectConfig,
  signal: AbortSignal,
  fromStepId: string | undefined,
  isActive: (run: RunView) => boolean | Promise<boolean>,
  readProject: ProjectReader,
  progress?: MutationProgress<TaskChangeConfirmation>,
  callerActivity?: () => Promise<boolean>,
  expected?: { expectedStep: string | null },
): Promise<ProjectView> {
  return diagnosticOperation({ path: 'src/task-management/commands.ts', method: 'updateTask' }, { projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
    validate(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), taskId)
    return withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      const before = await readProject(fs, subprocess, cwd, config, signal)
      if (operation === 'reopen') {
        if (before.task.kind !== 'empty') throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Finish the open task before reopening another task; refresh if the project is invalid or ambiguous'), ownMessage({ key: 'reasonFinishTheOpenTaskBeforeReopeningAnotherTaskRefreshIfTheProject' })))
        if (!before.task.allTasks.some(task => task.id === taskId && task.status !== 'open')) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'The closed task was not found'), ownMessage({ key: 'reasonTheClosedTaskWasNotFound' })))
        if (await hasActiveRun(before.task.allTasks.flatMap(task => task.runs), isActive)) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Wait for the active executor to finish before reopening a task'), ownMessage({ key: 'reasonWaitForTheActiveExecutorToFinishBeforeReopeningATask' })))
      } else if (before.task.kind !== 'task' || before.task.tasks[0]?.id !== taskId) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'The current task changed or is ambiguous; refresh the project'), ownMessage({ key: 'reasonTheCurrentTaskChangedOrIsAmbiguousRefreshTheProject' })))
      const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/state.json`, signal)
      const info = await fs.stat(target, signal)
      if (!info || info.type !== 'file') throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'The task state file is missing'), ownMessage({ key: 'reasonTheTaskStateFileIsMissing' })))
      const state = { ...await readTaskState(fs, cwd, taskId, signal), runs: await readRuns(fs, cwd, taskId, signal) }
      progress?.lastConfirmed?.({ taskId, status: state.status,
        currentStep: state.stepStates.find(step => step.status === 'current')?.id ?? null })
      if (expected && actualCurrentStep(state) !== expected.expectedStep) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'The current stage changed from expectedStep; the original request was not applied'), ownMessage({ key: 'reasonTheCurrentStageChangedFromExpectedStepTheOriginalRequestWasNot' })))
      if (operation !== 'reopen' && state.status !== 'open') throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'The task is already closed'), ownMessage({ key: 'reasonTheTaskIsAlreadyClosed' })))
      if (await callerActivity?.()) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Wait for the active executor to finish before changing the task'), ownMessage({ key: 'reasonWaitForTheActiveExecutorToFinishBeforeChangingTheTask' })))
      if (await hasActiveRun(state.runs, isActive)) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Wait for the active executor to finish before changing the task'), ownMessage({ key: 'reasonWaitForTheActiveExecutorToFinishBeforeChangingTheTask' })))
      const current = currentStepOf(state)
      if (operation === 'reopen') {
        state.status = 'open'
      } else if (operation === 'close') {
        state.status = 'completed'
      } else {
        const targetIndex = state.process.steps.findIndex(step => step.id === stepId)
        if (targetIndex < 0 || stepId === null) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'The requested step is not in the saved process'), ownMessage({ key: 'reasonTheRequestedStepIsNotInTheSavedProcess' })))
        const selected = state.stepStates.find(step => step.id === stepId)!
        if (selected.status === 'cancelled' && ['goto', 'return'].includes(operation)) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Cancelled steps cannot be selected'), ownMessage({ key: 'reasonCancelledStepsCannotBeSelected' })))
        if (operation === 'return') {
          if (fromStepId !== current || state.stepStates.find(step => step.id === fromStepId)?.status !== 'current') throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Only the current running step can return to an earlier step'), ownMessage({ key: 'reasonOnlyTheCurrentRunningStepCanReturnToAnEarlierStep' })))
          const steps = before.task.tasks[0]!.steps
          const fromIndex = steps.findIndex(step => step.id === fromStepId)
          const excluded = (index: number) => index < 0 || steps[index]!.status === 'cancelled'
          if (excluded(fromIndex) || excluded(targetIndex) || targetIndex >= fromIndex) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Return requires an earlier step that is not cancelled'), ownMessage({ key: 'reasonReturnRequiresAnEarlierStepThatIsNotCancelled' })))
        }
        if (operation === 'goto') {
          for (const step of state.stepStates) if (step.status === 'current') step.status = 'pending'
          selected.status = 'current'
        } else if (operation === 'complete' || operation === 'skip') {
          if (current !== stepId || state.stepStates.find(step => step.id === stepId)?.status !== 'current') throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Only the current running step can be completed or skipped'), ownMessage({ key: 'reasonOnlyTheCurrentRunningStepCanBeCompletedOrSkipped' })))
          state.stepStates.find(step => step.id === stepId)!.status = operation === 'complete' ? 'done' : 'skipped'
          const next = state.process.steps.slice(targetIndex + 1).find(step => state.stepStates.find(item => item.id === step.id)?.status === 'pending')
          if (next) state.stepStates.find(step => step.id === next.id)!.status = 'current'
        } else if (operation === 'return') {
          for (const [index, step] of state.process.steps.entries()) {
            const previous = state.stepStates.find(item => item.id === step.id)!
            if (previous.status === 'cancelled' || previous.status === 'skipped') continue
            if (index > targetIndex || previous.status === 'current') {
              previous.status = 'pending'
            }
          }
          state.stepStates.find(step => step.id === stepId)!.status = 'current'
        }
      }
      if (operation !== 'reopen') {
        const processTarget = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal)
        if (!await fs.stat(processTarget, signal)) {
          const processText = JSON.stringify(state.process, null, 2) + '\n'
          const processBytes = new TextEncoder().encode(processText)
          progress?.submitting()
          await diagnosticPublication(async () => {
            try { await fs.writeText(processTarget, processText, { kind: 'createIfAbsent' }, signal,
              { mode: 'workspace-write', workspaceRoot: cwd }) }
            catch (error) {
              if (error !== null && typeof error === 'object' && 'code' in error
                && ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(String(error.code))) throw error
              try {
                const bytes = await fs.readBytes(processTarget, signal, processBytes.length + 1)
                if (bytes.length === processBytes.length && bytes.every((byte, index) => byte === processBytes[index])) return
              }
              catch { /* Preserve uncertainty about the original preparation write. */ }
              throw error
            }
          }, processTarget, 'writeText')
        }
      }
      progress?.submitting()
      const text = serializeState(state)
      const prepared = new TextEncoder().encode(text)
      await diagnosticPublication(async () => {
        try { await fs.writeText(target, text, { kind: 'replaceIfVersion', version: info.version }, signal, { mode: 'workspace-write', workspaceRoot: cwd }) }
        catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error
            && ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(String(error.code))) throw error
          // Compare the exact intended timestamp and states while the original writer lock is still held.
          try {
            const bytes = await fs.readBytes(target, signal, prepared.length + 1)
            if (bytes.length === prepared.length && bytes.every((byte, index) => byte === prepared[index])) return
          }
          catch { /* An unavailable read cannot establish either publication or refusal. */ }
          throw error
        }
      }, target, 'writeText')
      progress?.confirmed({ taskId, operation, status: state.status, stepStates: state.stepStates.map(step => ({ ...step })) })
      return readProject(fs, subprocess, cwd, config, signal)
    }, { waitMs: config.lockWaitMs })

  })
}
// END_METHOD_updateTask

async function createText(fs: FileSystem, cwd: string, path: string, content: string, signal: AbortSignal): Promise<void> {
  const target = await targetFor(fs, cwd, `.aicraft/${path}`, signal)
  await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
}
