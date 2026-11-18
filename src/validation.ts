/**
 * FILE: plugin/src/validation.ts
 * DESCRIPTION: Retain schema diagnostics and describe the violated constraint structurally
 */
import { z } from 'zod'
import { withUiMessage, type UiMessage } from './ui-message.ts'

/**
 * Validate at the owner's boundary; custom constraints supply their own descriptors in issue params.
 */
export function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  try { return schema.parse(input) }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error
    const issue = error.issues[0]
    const field = issue?.path.join('.') || 'value'
    let uiMessage: UiMessage
    if (issue?.code === 'custom' && issue.params?.uiMessage) uiMessage = issue.params.uiMessage as UiMessage
    else if (issue?.code === 'too_small') uiMessage = { key: 'validationMinimum', params: { field, minimum: String(issue.minimum) } }
    else if (issue?.code === 'too_big') uiMessage = { key: 'validationMaximum', params: { field, maximum: String(issue.maximum) } }
    else if (issue?.code === 'invalid_format') uiMessage = { key: 'validationFormat', params: { field, format: 'pattern' in issue ? String(issue.pattern) : issue.format } }
    else if (issue?.code === 'invalid_value') uiMessage = { key: 'validationChoice', params: { field, values: issue.values.map(String).join(', ') } }
    else if (issue?.code === 'invalid_type') uiMessage = { key: 'validationType', params: { field, expected: issue.expected } }
    else uiMessage = { key: 'validationField', params: { field } }
    throw withUiMessage(error, { ...uiMessage, details: [error.message] })
  }
}
