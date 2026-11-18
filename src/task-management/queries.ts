/**
 * FILE: plugin/src/task-management/queries.ts
 * DESCRIPTION: Read task data without modifying project files
 */
import { validate } from '../validation.ts'
import { ownMessage, withUiMessage, messageOf, externalMessage } from '../ui-message.ts'
import { OperationRefusal } from '../step-execution/application/observe-run.ts'
import { diagnosticOperation, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { parse,type ParseError } from 'jsonc-parser'
import { processSchema } from '../project-settings/schemas.ts'
import { readRuns } from '../step-execution/history.ts'
import { targetFor } from '../work-materials/artifact-files.ts'
import { stateSchema } from './schemas.ts'
import { currentStepOf } from './state.ts'
import { AMBIGUOUS_TASKS_MESSAGE,type TaskData,type TaskDataSnapshot,type TaskReadIssue } from './types.ts'
/**
 * START_METHOD_assertProjectWritable
 * Recheck under the caller's writer lock; a merged task set is view-only.
 */
export async function assertProjectWritable(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<void> {
  return diagnosticOperation({ path: 'src/task-management/queries.ts', method: 'assertProjectWritable' }, { projectPath: cwd }, async () => {
    if ((await readTaskSnapshot(fs, cwd, signal)).kind === 'ambiguous') throw diagnosticRejection(withUiMessage(
      new OperationRefusal('state-conflict', AMBIGUOUS_TASKS_MESSAGE), ownMessage({ key: 'ambiguousTasks' })))

  })
}
// END_METHOD_assertProjectWritable

/**
 * START_METHOD_readTaskState
 * Read task data without writing or migrating project files.
 */
export async function readTaskState(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal) {
  return diagnosticOperation({ path: 'src/task-management/queries.ts', method: 'readTaskState' }, { projectPath: cwd, taskId: taskId }, async () => {
    const read = async (path: string) => fs.readText(await targetFor(fs, cwd, path, signal), signal)
    const root = `.aicraft/tasks/${taskId}`
    const state = parseState(await read(`${root}/state.json`))
    if (state.taskIdentifier !== taskId) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'taskIdentifier must match the task directory'), ownMessage({ key: 'reasonTaskIdentifierMustMatchTheTaskDirectory' })))
    // taskType is data, never an unchecked path supplied to the filesystem.
    if (!/^[a-z][a-z0-9-]*$/.test(state.taskType)) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'taskType must name a process file'), ownMessage({ key: 'reasonTaskTypeMustNameAProcessFile' })))
    const saved = await fs.stat(await targetFor(fs, cwd, `${root}/process.json`, signal), signal)
    const errors: ParseError[] = []
    const route = parse(await read(saved ? `${root}/process.json` : `.aicraft/config/processes/${state.taskType}.jsonc`), errors, { allowTrailingComma: true })
    if (errors.length) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Task process contains invalid JSONC'), ownMessage({ key: 'reasonTaskProcessContainsInvalidJSONC' })))
    let process
    try { process = validate(processSchema, route) }
    catch (error) { throw new OperationRefusal('state-conflict', error instanceof Error ? error.message : String(error), { cause: error }) }
    const ids = process.steps.map(step => step.id)
    if (state.stepStates.length !== ids.length || state.stepStates.some(step => !ids.includes(step.id))) throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'stepStates must match the process steps'), ownMessage({ key: 'reasonStepStatesMustMatchTheProcessSteps' })))
    const title = state.taskTitle ?? ((await read(`${root}/request.md`)).match(/^#\s+(.+)$/m)?.[1]?.trim() || state.taskIdentifier)
    return { ...state, taskTitle: title, process, title }

  })
}
// END_METHOD_readTaskState

/**
 * START_METHOD_readTaskSnapshot
 * Read the current task without modifying project files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Project directory in the provider's execution world.
 * @param signal - Caller cancellation.
 * @returns A task, an empty project, or explicit invalid/ambiguous state.
 */
export async function readTaskSnapshot(
  fs: FileSystem,
  cwd: string,
  signal: AbortSignal,
  validateHistory = true,
): Promise<TaskDataSnapshot> {
  return diagnosticOperation<TaskDataSnapshot>({ path: 'src/task-management/queries.ts', method: 'readTaskSnapshot' }, { projectPath: cwd }, async () => {
    const target = await targetFor(fs, cwd, '.aicraft/tasks', signal)
    const info = await fs.stat(target, signal)
    if (!info) return { kind: 'empty', tasks: [], allTasks: [], issues: [] }
    if (info.type !== 'directory') return { kind: 'invalid', tasks: [], allTasks: [], issues: [{ code: 'state-conflict', message: '.aicraft/tasks must be a directory', uiMessage: { key: 'taskDirectoryRequired' } }] }
    const tasks: TaskData[] = []
    const issues: TaskReadIssue[] = []
    for (const entry of await fs.listDir(target, signal)) {
      if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
      signal.throwIfAborted()
      const label = `.aicraft/tasks/${entry.name}/state.json`
      try {
        const state = await readTaskState(fs, cwd, entry.name, signal)
        if (validateHistory) await readRuns(fs, cwd, entry.name, signal)
        const currentStep = currentStepOf(state)
        const steps = await Promise.all(state.process.steps.map(async step => ({
          ...step, model: step.model, status: state.stepStates.find(item => item.id === step.id)!.status,
        })))
        tasks.push({
          id: entry.name, title: state.title, status: state.status, updatedAt: state.updatedAt ?? null, processName: state.process.name,
          currentStep,
          createdBranch: state.createdBranch ?? null,
          steps,
        })
      } catch (error) {
        signal.throwIfAborted()
        issues.push(taskReadIssue(error, `${label}: `))
      }
    }
    tasks.sort((a, b) => (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) :
      -Infinity) || a.id.localeCompare(b.id))
    if (issues.length) return { kind: 'invalid', tasks: [], allTasks: tasks, issues }
    const open = tasks.filter(task => task.status === 'open')
    return { kind: open.length === 0 ? 'empty' : open.length === 1 ? 'task' : 'ambiguous', tasks: open, allTasks: tasks, issues: [] }

  }).catch((error) => {
    signal.throwIfAborted()
    const issue = taskReadIssue(error)
    throw withUiMessage(new OperationRefusal(issue.code, issue.message, { cause: error }),
      issue.uiMessage ?? externalMessage('invalidTaskState', error))
  })
}
// END_METHOD_readTaskSnapshot

/**
 * Classify invalid saved state at the parser boundary, keeping filesystem failures outside it.
 */
function parseState(text: string) {
  try { return validate(stateSchema, JSON.parse(text)) }
  catch (error) { throw new OperationRefusal('state-conflict', error instanceof Error ? error.message : String(error), { cause: error }) }
}

/**
 * Classify typed source failures and data-validation failures without parsing exception prose.
 */
function taskReadIssue(error: unknown, prefix = ''): TaskReadIssue {
  const code = error instanceof OperationRefusal && ['access-denied', 'state-conflict'].includes(error.code)
    ? error.code as 'access-denied' | 'state-conflict'
    : error instanceof SyntaxError || error instanceof z.ZodError ? 'state-conflict'
      : error !== null && typeof error === 'object' && 'code' in error
        && ['FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(String(error.code)) ? 'access-denied' : 'dependency-unavailable'
  return { code, uiMessage: messageOf(error) ? { ...messageOf(error)!, details: [prefix, ...(messageOf(error)?.details ?? [])].filter(Boolean) } : externalMessage('invalidTaskState', error), message: prefix + (error instanceof Error ? error.message : String(error)), cause: error }
}
