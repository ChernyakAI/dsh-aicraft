/**
 * FILE: plugin/src/dsh-integration/agent-help.ts
 * DESCRIPTION: Assemble a complete read-only framework help response from its mandatory sources
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { OperationResult, RunObservation } from '../step-execution/types.ts'
import type { AgentHelp } from './types.ts'

/**
 * Explain the common result once in each actual tool registration, independently of work state.
 */
export const operationStatusDescription = 'operationStatus is the command result: confirmed means an established result; rejected means a known refusal; unknown means available evidence cannot establish the outcome. It is separate from task, stage, and executor state.'

/**
 * Preserve the accepted shared result guidance in the help response.
 */
export const agentResultNotes = 'operationStatus describes the command result, not the task, stage, or executor state. The result envelope uses operationStatus=confirmed for an established result, operationStatus=rejected for a known refusal, and operationStatus=unknown only when available evidence cannot establish the outcome. The plugin performs the checks available to it before replying. Errors retain a concrete reason; an unknown outcome may include the last confirmed state, which is not a claim about current state. Do not automatically repeat an uncertain change. No verification instruction or separate verification mode is returned. Use native DSH tools for messages, interruptions, and access to task materials and knowledge files. Obtain plugin-owned task state and configuration through AICraft, not by reading its service files directly.'

/**
 * Format only the supported flat parameter shapes, refusing a misleading signature.
 */
function parameterType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') throw new Error('Unsupported AICraft parameter schema')
  if (Object.keys(schema).some(key => !['type', 'enum', 'oneOf', 'description', 'title'].includes(key))) {
    throw new Error('Unsupported AICraft parameter constraint; a trustworthy signature cannot be produced')
  }
  const node = schema as { type?: unknown; enum?: unknown; oneOf?: unknown }
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2 || node.type !== undefined || node.enum !== undefined) throw new Error('Unsupported AICraft parameter union')
    return node.oneOf.map(parameterType).join(' | ')
  }
  if (node.enum !== undefined) {
    if (node.type !== 'string' || !Array.isArray(node.enum) || !node.enum.length
      || node.enum.some(value => typeof value !== 'string')) throw new Error('Unsupported AICraft parameter enum')
    return node.enum.map(value => JSON.stringify(value)).join(' | ')
  }
  if (node.type === 'string' || node.type === 'null') return node.type
  throw new Error('Unsupported AICraft parameter shape; a trustworthy signature cannot be produced')
}

/**
 * Read all mandatory help sections using the fresh, caller-visible registration parameters.
 */
export function readAgentHelp(description: () => string, commands: () => ToolSchema[],
  notes: () => string = () => agentResultNotes): AgentHelp {
  const text = description()
  if (typeof text !== 'string' || !text.trim()) throw new Error('The AICraft description is unavailable')
  const catalog = commands().map((command) => {
    const schema = command.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] }
    if (schema.type !== 'object' || !schema.properties) throw new Error('Unsupported AICraft command parameters')
    const parameters = Object.entries(schema.properties).map(([name, node]) =>
      name + (schema.required?.includes(name) ? '' : '?') + ': ' + parameterType(node)).join(', ')
    return { name: command.name, signature: command.name + '(' + parameters + ')', description: command.description }
  })
  const resultNotes = notes()
  if (typeof resultNotes !== 'string' || !resultNotes.trim()) throw new Error('The AICraft result notes are unavailable')
  return { description: text, commands: catalog, resultNotes }
}

/**
 * Select the public observation fields independently of the detailed panel result.
 */
export function compactRunObservation(value: RunObservation) {
  return { runId: value.link.id, stepId: value.link.stepId, sessionId: value.link.sessionId,
    initialAssignmentStatus: value.initialOutcome.state, conversationActivity: value.activity.selected.state,
    ...(value.initialOutcome.state === 'failed' && value.initialOutcome.reason
      ? { initialAssignmentError: value.initialOutcome.reason } : {}) }
}

/**
 * Serialize an explicit public envelope without internal recovery addresses or refresh details.
 */
export function compactAgentResult<T>(result: OperationResult<T>, project: (value: T) => unknown): string {
  if (result.operationStatus === 'confirmed') {
    const value = project(result.value)
    return JSON.stringify(value === undefined ? { operationStatus: result.operationStatus }
      : { operationStatus: result.operationStatus, value })
  }
  const problem = { code: result.problem.code, message: result.problem.message,
    correlationId: result.problem.correlationId, ...(result.problem.cause === undefined ? {} : { cause: result.problem.cause }) }
  if (result.operationStatus === 'rejected') return JSON.stringify({ operationStatus: result.operationStatus, problem })
  const state = result.lastConfirmedState
  if (state === undefined) return JSON.stringify({ operationStatus: result.operationStatus, problem })
  const lastConfirmedState = { taskId: state.taskId, status: state.status, currentStep: state.currentStep,
    attemptId: state.attemptId, runId: state.runId, stepId: state.stepId, sessionId: state.sessionId,
    initialAssignmentStatus: state.initialAssignmentStatus, conversationActivity: state.conversationActivity }
  return JSON.stringify({ operationStatus: result.operationStatus, problem, lastConfirmedState })
}
