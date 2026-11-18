/**
 * FILE: plugin/src/step-execution/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod'
import type { UiMessage } from '../ui-message.ts'
const uiMessageSchema = z.object({
  key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  details: z.array(z.string()).optional(),
}).transform(value => value as UiMessage)
/**
 * Validate the caller-supplied attempt identifier before lookup or publication.
 */
export const attemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
/**
 * Explicit process assignment, resolved through DSH's provider registry.
 */
export const modelAssignmentSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).nullable().default(null),
})

/**
 * Durable execution records; old task files may have no runs yet.
 */
export const runSchema = z.object({
  id: z.string(), stepId: z.string(), sessionId: z.string(),
  status: z.enum(['starting', 'running', 'completed', 'failed', 'interrupted']),
  startedAt: z.string(), finishedAt: z.string().nullable(), outputPath: z.string(),
  model: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() }),
  error: z.string().nullable(),
  errorMessage: uiMessageSchema.optional(),
  taskId: z.string().optional(),
  attemptId: attemptIdSchema.optional(),
  callerSessionId: z.string().nullable().optional(),
  request: z.object({ stepId: z.string(), modelOverride: z.object({ provider: z.string(), model: z.string(),
    reasoningEffort: z.string().nullable() }).nullable() }).optional(),
  dispatch: z.object({ phase: z.enum(['registered', 'submitting', 'accepted', 'rejected']), messageId: z.string().nullable(), reason: z.string().nullable(), reasonMessage: uiMessageSchema.optional() }).optional(),
  initialTurn: z.object({ turn: z.number().int().nonnegative().nullable(), messageId: z.string().nullable() }).optional(),
  promptVersion: z.string().optional(),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  executionBackend: z.object({ kind: z.enum(['standalone', 'spawn-in-process']), providerName: z.string().nullable() }).optional(),
}).superRefine((run, ctx) => {
  const fields = ['taskId', 'attemptId', 'callerSessionId', 'request', 'dispatch', 'initialTurn', 'promptVersion', 'promptSha256', 'executionBackend'] as const
  if (fields.some(field => run[field] !== undefined) && fields.some(field => run[field] === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Attempt records require all durable linkage fields' , params: { uiMessage: { key: 'constraintAttemptRecordsRequireAllDurableLinkageFields' } } })
  }
  if (run.request && run.request.stepId !== run.stepId) ctx.addIssue({ code: 'custom', message: 'Run request must name the saved step' , params: { uiMessage: { key: 'constraintRunRequestMustNameTheSavedStep' } } })
  if (run.dispatch?.phase === 'accepted' && !run.dispatch.messageId) ctx.addIssue({ code: 'custom', message: 'Accepted dispatch requires its native message ID' , params: { uiMessage: { key: 'constraintAcceptedDispatchRequiresItsNativeMessageID' } } })
  if (run.initialTurn?.messageId != null && run.dispatch?.messageId != null && run.initialTurn.messageId !== run.dispatch.messageId) ctx.addIssue({ code: 'custom', message: 'Initial native message links must agree' , params: { uiMessage: { key: 'constraintInitialNativeMessageLinksMustAgree' } } })
  if (run.executionBackend?.kind === 'spawn-in-process' && (!run.callerSessionId || run.executionBackend.providerName !== 'spawn')) ctx.addIssue({ code: 'custom', message: 'Native child execution requires its actual caller and exact spawn backend' , params: { uiMessage: { key: 'constraintNativeChildExecutionRequiresItsActualCallerAndExactSpawnBackend' } } })
  if (run.executionBackend?.kind === 'standalone' && run.callerSessionId != null) ctx.addIssue({ code: 'custom', message: 'Standalone panel runs do not acquire a guessed caller' , params: { uiMessage: { key: 'constraintStandalonePanelRunsDoNotAcquireAGuessedCaller' } } })
})
