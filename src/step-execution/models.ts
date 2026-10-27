/**
 * FILE: plugin/src/step-execution/models.ts
 * DESCRIPTION: Save task step model assignments after native validation
 */
import { diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { join } from 'node:path'
import { readRuns } from '../step-execution/history.ts'
import { hasActiveRun } from '../step-execution/runs.ts'
import { modelAssignmentSchema } from '../step-execution/schemas.ts'
import type { RunModel,RunView } from '../step-execution/types.ts'
import { readTaskSnapshot,readTaskState } from '../task-management/queries.ts'
import { targetFor } from '../work-materials/artifact-files.ts'
/**
 * START_METHOD_setStepModel
 * Persist a task-specific model assignment without changing project templates.
 */
export async function setStepModel(
  fs: FileSystem,
  waitMs: number,
  isActive: (run: RunView) => boolean | Promise<boolean>,
  cwd: string,
  taskId: string,
  stepId: string,
  input: RunModel,
  signal: AbortSignal,
  resolveModel: (model: RunModel, signal: AbortSignal) => Promise<RunModel>,
): Promise<void> {
  return diagnosticOperation({ path: 'src/step-execution/models.ts', method: 'setStepModel' }, { projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId) || !/^[a-z][a-z0-9-]*$/.test(stepId)) throw diagnosticRejection(new Error('Invalid task or step ID'))
    const model = modelAssignmentSchema.parse(input)
    await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal)
    await withFileLock(join(cwd, '.aicraft'), async () => {
      const snapshot = await readTaskSnapshot(fs, cwd, signal)
      if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw diagnosticRejection(new Error('Only the open, unambiguous task can be changed'))
      const path = `.aicraft/tasks/${taskId}/process.json`
      const target = await targetFor(fs, cwd, path, signal)
      const info = await fs.lstat(path, { cwd }, signal)
      if (info && info.type !== 'file') throw diagnosticRejection(new Error('Task process must be a regular file'))
      const version = info ? (await fs.stat(target, signal))?.version : undefined
      if (info && !version) throw diagnosticRejection(new Error('Task process changed while loading; refresh before saving'))
      const state = { ...await readTaskState(fs, cwd, taskId, signal), runs: await readRuns(fs, cwd, taskId, signal) }
      if (await hasActiveRun(state.runs, isActive)) throw diagnosticRejection(new Error('Wait for the task executor before changing its model'))
      const step = state.process.steps.find(step => step.id === stepId)
      if (!step) throw diagnosticRejection(new Error('Step is missing from the task process'))
      await resolveModel(model, signal)
      step.model = model
      await diagnosticPublication(() => fs.writeText(target, JSON.stringify(state.process, null, 2) + '\n', info ? { kind: 'replaceIfVersion', version: version! } : { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
    }, { waitMs: waitMs })

  })
}
// END_METHOD_setStepModel
