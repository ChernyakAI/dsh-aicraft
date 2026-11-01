/**
 * FILE: plugin/src/client/task-creation.ts
 * DESCRIPTION: Retain each creation attempt independently of project snapshots
 */
import type { CreateTaskRequest,TaskCreationConfirmation,TaskCreationCheck } from 'dsh-aicraft/types'

/** Local attempt identity and its separately read result. */
export interface TaskCreationAttempt {
  workspaceId: string
  taskIdentifier: string
  request: CreateTaskRequest
  sequence: number
  outcome: 'sending' | 'created' | 'not-created' | 'unknown'
  confirmation: TaskCreationConfirmation | null
  reason: string | null
  check: TaskCreationCheck | null
}

/** Preserve the Remote failure code and payload supplied by the generated adapter. */
export function isCreationRefusal(error: unknown, taskIdentifier: string): boolean {
  const failure = error as { code?: string; details?: { taskIdentifier?: string; outcome?: string } } | null
  return failure?.code === 'aicraft/task-not-created' && failure.details?.outcome === 'not-created'
    && failure.details.taskIdentifier === taskIdentifier
}

/** Find the most recent attempt without discarding earlier project/task pairs. */
export function latestCreation(attempts: Record<string, TaskCreationAttempt>, workspaceId: string): TaskCreationAttempt | undefined {
  return Object.values(attempts).filter(attempt => attempt.workspaceId === workspaceId)
    .sort((left, right) => right.sequence - left.sequence)[0]
}
