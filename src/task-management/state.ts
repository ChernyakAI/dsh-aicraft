/**
 * FILE: plugin/src/task-management/state.ts
 * DESCRIPTION: Serialize task state and derive the selected step
 */
import type { z } from 'zod'
import { stateSchema } from './schemas.ts'
/** Resolve selection from saved stage states, falling back to the last completed stage. */
export function currentStepOf(state: z.infer<typeof stateSchema>): string | null {
  return state.stepStates.find(step => step.status === 'current')?.id
    ?? state.stepStates.findLast(step => step.status === 'done')?.id
    ?? null
}
/** Serialize only agreed state fields, updating the plugin write timestamp. */
export function serializeState(state: z.infer<typeof stateSchema>): string {
  const { taskType, taskIdentifier, taskTitle, status, createdBranch, stepStates } = state
  return JSON.stringify(stateSchema.parse({ taskType, taskIdentifier, taskTitle, status, createdBranch, stepStates, updatedAt: new Date().toISOString() }), null, 2) + '\n'
}
