/**
 * FILE: plugin/src/work-materials/cleanup.ts
 * DESCRIPTION: Delete confirmed step outputs while preserving prompt and task records
 */
import { diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { readdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuns } from '../step-execution/history.ts'
import { hasActiveRun } from '../step-execution/runs.ts'
import type { RunView } from '../step-execution/types.ts'
import { readTaskSnapshot,readTaskState } from '../task-management/queries.ts'
import { targetFor } from '../work-materials/artifact-files.ts'
/**
 * START_METHOD_deleteStepMaterials
 * Clear only the selected step's files, keeping task state and executor history.
 */
export async function deleteStepMaterials(
  fs: FileSystem,
  waitMs: number,
  isActive: (run: RunView) => boolean | Promise<boolean>,
  cwd: string,
  taskId: string,
  stepId: string,
  signal: AbortSignal,
): Promise<void> {
  return diagnosticOperation({ path: 'src/work-materials/cleanup.ts', method: 'deleteStepMaterials' }, { projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId) || !/^[a-z][a-z0-9-]*$/.test(stepId)) throw diagnosticRejection(new Error('Invalid task or step ID'))
    await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/${stepId}`, signal)
    await withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      const snapshot = await readTaskSnapshot(fs, cwd, signal)
      if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw diagnosticRejection(new Error('Only the open, unambiguous task can be changed'))
      const state = { ...await readTaskState(fs, cwd, taskId, signal), runs: await readRuns(fs, cwd, taskId, signal) }
      if (!state.process.steps.some(step => step.id === stepId)) throw diagnosticRejection(new Error('Step is missing from the task process'))
      if (await hasActiveRun(state.runs, isActive)) {
        throw diagnosticRejection(new Error('Stop the task executor before deleting step artifacts'))
      }
      const path = `.aicraft/tasks/${taskId}/${stepId}`
      const target = await targetFor(fs, cwd, path, signal)
      const info = await fs.lstat(path, { cwd }, signal)
      if (!info) return
      if (info.type !== 'directory') throw diagnosticRejection(new Error('Step artifacts must be a regular directory'))
      // shortcut: DSH has no deletion service; only explicitly host-mapped local files are supported.
      const hostPath = fileURLToPath(fs.fileUrl(target))
      if (fs.processPathFromHostPath(hostPath) !== fs.processPath(target)) throw diagnosticRejection(new Error('This filesystem does not support local artifact deletion'))
      for (const name of await readdir(hostPath)) {
        if (name === '.gitkeep' || name === 'input-prompt.md') continue
        signal.throwIfAborted()
        await diagnosticPublication(() => rm(join(hostPath, name), { recursive: true }), join(hostPath, name), 'rm')
      }
    }, { waitMs: waitMs })

  })
}
// END_METHOD_deleteStepMaterials
