/**
 * FILE: plugin/src/task-management/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod'
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
export const requestSchema = z.object({
  taskIdentifier: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/, 'Task ID must contain 1–128 letters, digits, hyphens or underscores, starting with a letter or digit.')
    .refine(id => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id), 'This Task ID is reserved by Windows. Choose another ID.'),
  title: z.string().trim().min(1), processId: z.string().regex(/^[a-z][a-z0-9-]*$/), requestText: z.string().trim().min(1),
})
