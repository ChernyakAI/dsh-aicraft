/**
 * FILE: plugin/src/step-execution/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod'
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
