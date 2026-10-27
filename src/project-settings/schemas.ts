/**
 * FILE: plugin/src/project-settings/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod'
import { modelAssignmentSchema } from '../step-execution/schemas.ts'
import { defaultStepModel } from './templates.ts'
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
