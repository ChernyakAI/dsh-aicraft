/**
 * FILE: plugin/src/dsh-integration/project-view.ts
 * DESCRIPTION: Compose project readiness, task data, history and material counts
 */
import { diagnosticOperation } from './diagnostics.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type Subprocess from '@deepseek-ai/dsh-subprocess'
import { readProjectReadiness } from '../project-settings/project.ts'
import { readRuns } from '../step-execution/history.ts'
import { readExecutionInputs } from '../step-execution/prompts.ts'
import { readTaskSnapshot } from '../task-management/queries.ts'
import { artifactSummary } from '../work-materials/artifact-files.ts'
import type { ProjectConfig } from './config.ts'
import { currentBranch } from './git.ts'
import type { ProjectView,TaskSnapshot,TaskView } from './types.ts'
/**
 * START_METHOD_readProject
 * Read preparation, current branch, process choices and the current task.
 * @param fs - DSH filesystem.
 * @param subprocess - DSH process provider for read-only Git commands.
 * @param cwd - Canonical local project directory.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Project readiness and task state.
 */
export async function readProject(
  fs: FileSystem,
  subprocess: Subprocess,
  cwd: string,
  config: ProjectConfig,
  signal: AbortSignal,
): Promise<ProjectView> {
  return diagnosticOperation({ path: 'src/dsh-integration/project-view.ts', method: 'readProject' }, { projectPath: cwd }, async () => {
    const task = await readTaskView(fs, cwd, signal)
    const branch = await currentBranch(subprocess, cwd, config, signal)
    const readiness = await readProjectReadiness(fs, cwd, signal, task.kind === 'empty')
    const result: ProjectView = { ...readiness, branch, executionIssue: null, task }
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
    return result

  })
}
// END_METHOD_readProject

/** Add history and material counts to validated task data at the integration boundary. */
export async function readTaskView(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<TaskSnapshot> {
  const snapshot = await readTaskSnapshot(fs, cwd, signal, false)
  const allTasks: TaskView[] = []
  const issues = [...snapshot.issues]
  for (const task of snapshot.allTasks) {
    try {
      const runs = await readRuns(fs, cwd, task.id, signal)
      const steps = await Promise.all(task.steps.map(async step => ({
        ...step, ...await artifactSummary(fs, cwd, `.aicraft/tasks/${task.id}/${step.id}`, signal),
      })))
      allTasks.push({ ...task, runs, steps })
    } catch (error) {
      signal.throwIfAborted()
      issues.push(`.aicraft/tasks/${task.id}/state.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const tasks = allTasks.filter(task => task.status === 'open')
  return { kind: issues.length ? 'invalid' : tasks.length === 0 ? 'empty' : tasks.length === 1 ? 'task' : 'ambiguous', tasks: issues.length ? [] : tasks, allTasks, issues }
}
