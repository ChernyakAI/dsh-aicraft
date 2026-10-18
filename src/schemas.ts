import { z } from 'zod'
import { defaultStepModel } from './process-templates.ts'

/** Explicit process assignment, resolved through DSH's provider registry. */
export const modelAssignmentSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).nullable().default(null),
})

/** Durable execution records; old task files may have no runs yet. */
export const runSchema = z.object({
  id: z.string(), stepId: z.string(), sessionId: z.string(),
  status: z.enum(['starting', 'running', 'completed', 'failed', 'interrupted']),
  startedAt: z.string(), finishedAt: z.string().nullable(), outputPath: z.string(),
  model: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() }),
  error: z.string().nullable(),
})

/** Process fields needed by the prototype; retain additional route metadata. */
export const processDraftSchema = z.object({
  language: z.enum(['ru', 'en']).optional(),
  name: z.string().min(1),
  steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().min(1),
    role: z.string().regex(/^[a-z][a-z0-9-]*$/),
    model: modelAssignmentSchema.nullable().optional().transform(model => model ?? defaultStepModel()),
  }).passthrough()),
}).passthrough().superRefine((process, ctx) => {
  const ids = process.steps.map(step => step.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Process step IDs must be unique' })
})

/** Executable task routes must contain at least one step. */
export const processSchema = processDraftSchema.refine(process => process.steps.length > 0, { message: 'Add at least one step before creating a task.', path: ['steps'] })

/** Agreed task state; process snapshots and executor links live separately. */
export const stateSchema = z.object({
  taskType: z.string().trim().min(1),
  taskIdentifier: z.string().trim().min(1),
  taskTitle: z.string().trim().min(1).optional(), // Missing only in legacy states.
  status: z.enum(['open', 'completed', 'cancelled']),
  updatedAt: z.iso.datetime().optional(),
  createdBranch: z.string().optional(),
  stepStates: z.array(z.object({
    id: z.string().min(1), status: z.enum(['done', 'current', 'pending', 'skipped', 'cancelled']),
  })).min(1),
}).strict().superRefine((state, ctx) => {
  const ids = state.stepStates.map(step => step.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Step IDs must be unique' })
  if (state.stepStates.filter(step => step.status === 'current').length > 1) {
    ctx.addIssue({ code: 'custom', message: 'Only one step may be current' })
  }
})

/** Resolve selection from saved stage states, falling back to the last completed stage. */
export function currentStepOf(state: z.infer<typeof stateSchema>): string | null {
  return state.stepStates.find(step => step.status === 'current')?.id
    ?? state.stepStates.findLast(step => step.status === 'done')?.id
    ?? null
}
