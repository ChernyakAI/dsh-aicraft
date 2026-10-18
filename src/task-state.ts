import { artifactSummary, targetFor } from './artifact-files.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { parse, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { currentStepOf, stateSchema, processSchema, runSchema } from './schemas.ts'
import type { RunView, TaskSnapshot, TaskView } from './types.ts'
import { AMBIGUOUS_TASKS_MESSAGE } from './types.ts'

/** Await native activity providers before admitting any task mutation. */
export async function hasActiveRun(runs: RunView[], isActive: (run: RunView) => boolean | Promise<boolean>): Promise<boolean> {
  for (const run of runs) if (await isActive(run)) return true
  return false
}

/** Recheck under the caller's writer lock; a merged task set is view-only. */
export async function assertProjectWritable(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<void> {
  if ((await readTaskSnapshot(fs, cwd, signal)).kind === 'ambiguous') throw new Error(AMBIGUOUS_TASKS_MESSAGE)
}

/** Read task data without writing or migrating project files. */
export async function readTaskState(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal) {
  const read = async (path: string) => fs.readText(await targetFor(fs, cwd, path, signal), signal)
  const root = `.aicraft/tasks/${taskId}`
  const state = stateSchema.parse(JSON.parse(await read(`${root}/state.json`)))
  if (state.taskIdentifier !== taskId) throw new Error('taskIdentifier must match the task directory')
  // taskType is data, never an unchecked path supplied to the filesystem.
  if (!/^[a-z][a-z0-9-]*$/.test(state.taskType)) throw new Error('taskType must name a process file')
  const saved = await fs.stat(await targetFor(fs, cwd, `${root}/process.json`, signal), signal)
  const errors: ParseError[] = []
  const route = parse(await read(saved ? `${root}/process.json` : `.aicraft/config/processes/${state.taskType}.jsonc`), errors, { allowTrailingComma: true })
  if (errors.length) throw new Error('Task process contains invalid JSONC')
  const process = processSchema.parse(route)
  const ids = process.steps.map(step => step.id)
  if (state.stepStates.length !== ids.length || state.stepStates.some(step => !ids.includes(step.id))) throw new Error('stepStates must match the process steps')
  const title = state.taskTitle ?? ((await read(`${root}/request.md`)).match(/^#\s+(.+)$/m)?.[1]?.trim() || state.taskIdentifier)
  const runs = await readRuns(fs, cwd, taskId, signal)
  return { ...state, taskTitle: title, process, title, runs }
}

/** Executor history is independent of the task state schema. */
export async function readRuns(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal) {
  const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/runs.json`, signal)
  return await fs.stat(target, signal) ? z.array(runSchema).parse(JSON.parse(await fs.readText(target, signal))) : []
}

/** Serialize only agreed state fields, updating the plugin write timestamp. */
export function serializeState(state: z.infer<typeof stateSchema>): string {
  const { taskType, taskIdentifier, taskTitle, status, createdBranch, stepStates } = state
  return JSON.stringify(stateSchema.parse({ taskType, taskIdentifier, taskTitle, status, createdBranch, stepStates, updatedAt: new Date().toISOString() }), null, 2) + '\n'
}

/**
 * Read the current task without modifying project files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Project directory in the provider's execution world.
 * @param signal - Caller cancellation.
 * @returns A task, an empty project, or explicit invalid/ambiguous state.
 */
export async function readTaskSnapshot(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<TaskSnapshot> {
  const target = await targetFor(fs, cwd, '.aicraft/tasks', signal)
  const info = await fs.stat(target, signal)
  if (!info) return { kind: 'empty', tasks: [], allTasks: [], issues: [] }
  if (info.type !== 'directory') return { kind: 'invalid', tasks: [], allTasks: [], issues: ['.aicraft/tasks must be a directory'] }
  const tasks: TaskView[] = []
  const issues: string[] = []
  for (const entry of await fs.listDir(target, signal)) {
    if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
    signal.throwIfAborted()
    const label = `.aicraft/tasks/${entry.name}/state.json`
    try {
      const file = await targetFor(fs, cwd, label, signal)
      const raw = stateSchema.parse(JSON.parse(await fs.readText(file, signal)))
      if (raw.taskIdentifier !== entry.name) throw new Error('taskIdentifier must match the task directory')
      const state = await readTaskState(fs, cwd, entry.name, signal)
      const currentStep = currentStepOf(state)
      const steps = await Promise.all(state.process.steps.map(async step => ({
        ...step, model: step.model, status: state.stepStates.find(item => item.id === step.id)!.status,
        ...await artifactSummary(fs, cwd, `.aicraft/tasks/${entry.name}/${step.id}`, signal),
      })))
      tasks.push({
        id: entry.name, title: state.title, status: state.status, updatedAt: state.updatedAt ?? null, processName: state.process.name,
        currentStep,
        runs: state.runs, createdBranch: state.createdBranch ?? null,
        steps,
      })
    } catch (error) {
      signal.throwIfAborted()
      issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  tasks.sort((a, b) => (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) : -Infinity) || a.id.localeCompare(b.id))
  if (issues.length) return { kind: 'invalid', tasks: [], allTasks: tasks, issues }
  const open = tasks.filter(task => task.status === 'open')
  return { kind: open.length === 0 ? 'empty' : open.length === 1 ? 'task' : 'ambiguous', tasks: open, allTasks: tasks, issues: [] }
}
