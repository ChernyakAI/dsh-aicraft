/**
 * FILE: plugin/src/step-execution/history.ts
 * DESCRIPTION: Read durable executor history independently of task state
 */
import { validate } from '../validation.ts'
import { ownMessage, withUiMessage } from '../ui-message.ts'
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { targetFor } from '../work-materials/artifact-files.ts'
import { readTaskSnapshot } from '../task-management/queries.ts'
import { runSchema } from './schemas.ts'
import type { RunView } from './types.ts'
import type { RunStore } from './ports.ts'
import { assertRunIdentity, advanceDispatch } from './domain/run-state.ts'
import { OperationRefusal } from './application/observe-run.ts'
/**
 * START_METHOD_readRuns
 * Executor history is independent of the task state schema.
 */
export async function readRuns(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal) {
  return diagnosticOperation({ path: 'src/step-execution/history.ts', method: 'readRuns' }, { projectPath: cwd, taskId: taskId }, async () => {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw withUiMessage(new OperationRefusal('invalid-input', 'Invalid task identifier'), ownMessage({ key: 'reasonInvalidTaskIdentifier' }))
    const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/runs.json`, signal)
    const runs = await fs.stat(target, signal) ? validate(z.array(runSchema), JSON.parse(await fs.readText(target, signal))) : []
    const attempts = new Set<string>()
    for (const run of runs) {
      if (run.taskId !== undefined && run.taskId !== taskId) throw withUiMessage(new Error('Executor history belongs to a different task'), ownMessage({ key: 'reasonExecutorHistoryBelongsToADifferentTask' }))
      if (run.attemptId !== undefined) {
        if (attempts.has(run.attemptId)) throw withUiMessage(new Error('Executor history contains duplicate attempt IDs'), ownMessage({ key: 'reasonExecutorHistoryContainsDuplicateAttemptIDs' }))
        attempts.add(run.attemptId)
      }
    }
    return runs as RunView[]

  })
}
// END_METHOD_readRuns

/**
 * Persist only established facts under the existing project lock.
 */
export function createRunStore(fs: FileSystem, waitMs: number): RunStore {
  return {
    read: (context, taskId, signal) => readRuns(fs, context.projectRoot, taskId, signal),
    /**
     * Hold the existing project lock across attempt lookup and publication; lock release can still fail.
     */
    transaction: (context, taskId, signal, operation) => diagnosticOperation({ path: 'src/step-execution/history.ts' },
      { workspaceId: context.workspaceId, projectPath: context.projectRoot, taskId }, () => withFileLock(join(context.projectRoot, '.aicraft'), async () => {
        signal.throwIfAborted()
        return operation({
          read: () => readRuns(fs, context.projectRoot, taskId, signal),
          /**
           * Publish validated run facts without changing the original attempt links.
           */
          async save(run) {
            validate(runSchema, run)
            if (run.taskId !== undefined && run.taskId !== taskId) throw withUiMessage(new Error('The run must belong to the original task'), ownMessage({ key: 'reasonTheRunMustBelongToTheOriginalTask' }))
            const target = await targetFor(fs, context.projectRoot, `.aicraft/tasks/${taskId}/runs.json`)
            const info = await fs.stat(target)
            const runs = await readRuns(fs, context.projectRoot, taskId)
            const index = runs.findIndex(item => item.id === run.id)
            if (index >= 0) {
              assertRunIdentity(runs[index]!, run)
              if (run.dispatch) advanceDispatch(runs[index]!, run.dispatch)
              runs[index] = run
            } else {
              if (run.taskId === undefined) throw withUiMessage(new Error('New records require their original task identity'), ownMessage({ key: 'reasonNewRecordsRequireTheirOriginalTaskIdentity' }))
              if (runs.some(item => item.attemptId === run.attemptId)) throw withUiMessage(new Error('The original attempt is already registered'), ownMessage({ key: 'reasonTheOriginalAttemptIsAlreadyRegistered' }))
              runs.push(run)
            }
            const snapshot = await readTaskSnapshot(fs, context.projectRoot, new AbortController().signal, false)
            if (snapshot.kind === 'ambiguous') throw diagnosticRejection(withUiMessage(new OperationRefusal('state-conflict', 'Run history cannot be changed while multiple tasks are open'), ownMessage({ key: 'reasonRunHistoryCannotBeChangedWhileMultipleTasksAreOpen' })))
            // Retain a known native receipt even when the original preparation signal was cancelled.
            diagnosticAccepted({ runId: run.id, taskId, sessionId: run.sessionId })
            const text = JSON.stringify(runs, null, 2) + '\n'
            const prepared = new TextEncoder().encode(text)
            await diagnosticPublication(async () => {
              try { await fs.writeText(target, text, info
                ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }, undefined,
              { mode: 'workspace-write', workspaceRoot: context.projectRoot }) }
              catch (error) {
                if (error !== null && typeof error === 'object' && 'code' in error) {
                  const code = String(error.code)
                  if (['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(code)) {
                    throw new OperationRefusal(code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED'
                      ? 'version-conflict' : 'access-denied', error instanceof Error ? error.message : String(error), { cause: error })
                  }
                }
                // Registration and acceptance use the same exact-byte confirmation, without a second save.
                try {
                  const bytes = await fs.readBytes(target, signal, prepared.length + 1)
                  if (bytes.length === prepared.length && bytes.every((byte, index) => byte === prepared[index])) return
                }
                catch { /* Preserve the original uncertain publication and its cause. */ }
                throw error
              }
            }, target, 'writeText')
          },
        })
      }, { waitMs })),
  }
}
