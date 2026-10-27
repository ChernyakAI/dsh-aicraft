/**
 * FILE: plugin/src/step-execution/history.ts
 * DESCRIPTION: Read durable executor history independently of task state
 */
import { diagnosticOperation } from '../dsh-integration/diagnostics.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { targetFor } from '../work-materials/artifact-files.ts'
import { runSchema } from './schemas.ts'
/**
 * START_METHOD_readRuns
 * Executor history is independent of the task state schema.
 */
export async function readRuns(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal) {
  return diagnosticOperation({ path: 'src/step-execution/history.ts', method: 'readRuns' }, { projectPath: cwd, taskId: taskId }, async () => {
    const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/runs.json`, signal)
    return await fs.stat(target, signal) ? z.array(runSchema).parse(JSON.parse(await fs.readText(target, signal))) : []

  })
}
// END_METHOD_readRuns
