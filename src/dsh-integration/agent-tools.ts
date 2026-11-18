/**
 * FILE: plugin/src/dsh-integration/agent-tools.ts
 * DESCRIPTION: Authorize agent calls before invoking shared server operations
 */
import type { Context } from '@deepseek-ai/cordis'
import { approveEscalation,type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool,type ToolDefinition,type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { } from '@deepseek-ai/dsh-user-approval'
import { resolve } from 'node:path'
import type { } from './service.ts'
import { operationStatusDescription, compactAgentResult, compactRunObservation } from './agent-help.ts'
import type { CallContext } from '../step-execution/types.ts'

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * START_METHOD_registerAgentTools
 * Expose the same operations used by the panel to agents in their own project.
 * @param ctx - Context with AICraft and tool registry dependencies.
 */
export function registerAgentTools(ctx: Context): void {
  const own = new Map<ToolDefinition, string>()
  /**
   * Retain the exact definitions from these registrations for the caller-specific help catalog.
   */
  const register = (tool: ToolDefinition): void => {
    tool.parameters.additionalProperties = false
    own.set(tool, tool.description)
    tool.description += ' ' + operationStatusDescription
    ctx.tools.register(tool)
  }
  /**
   * Resolve the registered project from the actual calling agent's working directory.
   */
  const workspace = (exec: ToolRunContext): string => {
    const cwd = exec.agent?.session.header.cwd
    if (!cwd) throw new Error('AICraft tools require an agent with a project working directory')
    return ctx.aicraft.workspaceForAgent(cwd)
  }
  /**
   * Read the actual caller's standing sandbox policy without promoting a one-call grant.
   */
  const standingPolicy = (exec: ToolRunContext): SandboxExecutionPolicy => {
    const policy = ctx.get('sandboxPolicy')
    if (!policy || !exec.agent) throw new Error('AICraft requires the actual agent sandbox policy')
    return policy.resolve({ session: exec.agent.session })
  }
  const callContext = (exec: ToolRunContext, workspaceId: string, standing = standingPolicy(exec)): CallContext =>
    ctx.aicraft.contextForAgent(workspaceId, exec.agent!, exec.callId, standing)
  /**
   * Check the original workspace and obtain any required one-operation write approval.
   */
  const authorizeWrite = async (exec: ToolRunContext, name: string, standing: SandboxExecutionPolicy): Promise<void> => {
    exec.signal.throwIfAborted()
    if (resolve(standing.workspaceRoot) !== resolve(exec.agent!.session.header.cwd!)) throw new Error('AICraft project must match the session workspace')
    if (standing.mode === 'read-only') {
      await approveEscalation({ requestedMode: 'workspace-write', effectiveMode: standing.mode,
        justification: `${name} changes AICraft data in the current project.`, subject: 'AICraft operation' },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: name, signal: exec.signal })
    } else if (standing.mode !== 'workspace-write' && standing.mode !== 'danger-full-access') throw new Error('Unknown DSH sandbox permission mode')
    exec.signal.throwIfAborted()
  }
  /**
   * Apply trusted caller context and write authorization before invoking a shared mutation.
   * Agent calls authorize the project-scoped write capability before entering shared UI operations.
   */
  const mutate = async (exec: ToolRunContext, name: string, call: (workspaceId: string, standing: SandboxExecutionPolicy,
    context: CallContext) => Promise<unknown>): Promise<string> => {
    exec.signal.throwIfAborted()
    const workspaceId = workspace(exec), standing = standingPolicy(exec)
    const context = callContext(exec, workspaceId, standing)
    await authorizeWrite(exec, name, standing)
    return JSON.stringify(await call(workspaceId, standing, context))
  }
  /**
   * Read caller-specific help from the actual registry definitions.
   */
  register(defineTool({
    name: 'aicraft_help', description: 'Read the AICraft framework description and other AICraft commands available to this agent. Independent of tasks and assignments; read-only, without starting or continuing work.',
    parameters: {}, output,
    /**
     * Read the actual caller catalog without task work or write authority.
     */
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const context = callContext(exec, workspace(exec))
      return compactAgentResult(await ctx.aicraft.helpForAgent(context, agent =>
        ctx.tools.schemas(agent).flatMap((schema) => {
          const definition = ctx.tools.get(schema.name, agent)
          const description = definition && own.get(definition)
          return schema.name !== 'aicraft_help' && description !== undefined ? [{ ...schema, description }] : []
        }), exec.signal), value => value)
    },
  }))
  /**
   * Read the open task ID and its ordered stages in this conversation's project.
   */
  register(defineTool({
    name: 'aicraft_project', description: "Read the open task ID and its ordered stages in this conversation's project. Use this command as the authoritative source of the current task's route and stage states. Shared process templates are for creating new tasks and do not describe an existing task's current state. Returns openTaskId and every stage in saved process order, each with only id, a short English description, and status: pending (waiting), current (selected for work), done (accepted completion), skipped (skipped), or cancelled (cancelled). Stage status is separate from operationStatus and executor state; finishing an executor does not accept a stage. Returns the full route even without a current stage. If no task is open, returns openTaskId=null and steps=[]. Known read failures return rejected/problem without a successful value. Each call reads fresh data without changing files, preparing assignments, starting or continuing work. Does not return task history or execution details.",
    parameters: {}, output,
    /**
     * Return the shared reader result for the caller original project.
     */
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const context = callContext(exec, workspace(exec))
      return compactAgentResult(await ctx.aicraft.projectForAgent(context, exec.signal), value => value)
    },
  }))
  /**
   * Read the current stage of the open task in this conversation's project.
   */
  register(defineTool({
    name: 'aicraft_step', description: "Read the current stage of the open task in this conversation's project. Returns its stage ID, or null only when the single valid open task has no current stage. Does not substitute the last completed stage. If there is no open task, several open tasks, invalid state, or unavailable state, returns operationStatus=rejected with the concrete reason; these cases are not a successful null result.",
    parameters: {}, output,
    /**
     * Return only the actual current stage from the shared task reader.
     */
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const context = callContext(exec, workspace(exec))
      return compactAgentResult(await ctx.aicraft.stepForAgent(context, exec.signal), value => value)
    },
  }))
  /**
   * Change stages of the current task.
   */
  register(defineTool({
    name: 'aicraft_move_step', description: 'Change stages of the current task. complete accepts the current stage; skip marks it skipped; both select the next pending stage. goto selects targetStep and preserves other outcomes. return selects an earlier targetStep and resets later ordinary stages to pending, preserving other skipped and cancelled stages. expectedStep must match the actual current stage; null is allowed only for goto when no stage is current. targetStep is required only for goto and return; use an ID from aicraft_project.steps. Returns the new current stage ID or null. Does not close the task.',
    parameters: {
      action: { type: 'string', enum: ['complete', 'skip', 'goto', 'return'], required: true },
      expectedStep: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      targetStep: { type: 'string' },
    }, output,
    /**
     * Authorize one guarded transition and select its publication-time current stage.
     */
    async execute(args, exec) {
      return mutate(exec, 'aicraft_move_step', async (_id, _standing, context) =>
        JSON.parse(compactAgentResult(await ctx.aicraft.moveStepForAgent(context, args.action, args.expectedStep,
          args.targetStep, exec.signal), value => value.stepStates.find(step => step.status === 'current')?.id ?? null)))
    },
  }))
  /**
   * Close the current open task in this conversation's project.
   */
  register(defineTool({
    name: 'aicraft_close_task', description: "Close the current open task in this conversation's project. Preserve materials, execution links and conversations. Returns confirmed only after the change is established; no task or stage details are returned.",
    parameters: {}, output,
    /**
     * Authorize closure of the selected open task and return its bare confirmation.
     */
    async execute(args, exec) {
      return mutate(exec, 'aicraft_close_task', async (_id, _standing, context) =>
        JSON.parse(compactAgentResult(await ctx.aicraft.closeTaskForAgent(context, exec.signal), () => undefined)))
    },
  }))
  /**
   * Reopen the specified closed task without resetting its stages or materials.
   */
  register(defineTool({
    name: 'aicraft_reopen_task', description: 'Reopen the specified closed task without resetting its stages or materials. Use the task ID retained from the earlier project response or conversation. Returns confirmed without task or stage details. Does not choose an arbitrary closed task.',
    parameters: { taskId: { type: 'string', required: true } }, output,
    /**
     * Authorize reopening the explicit saved task without changing its stage data.
     */
    async execute(args, exec) {
      return mutate(exec, 'aicraft_reopen_task', async (_id, _standing, context) =>
        JSON.parse(compactAgentResult(await ctx.aicraft.changeTask(context, args.taskId, 'reopen', null, exec.signal), () => undefined)))
    },
  }))
  /**
   * Check one execution of the current task without starting work.
   */
  register(defineTool({
    name: 'aicraft_check_run', description: 'Check one execution of the current task without starting work. Supply exactly one identifier: runId returned by aicraft_start_step, or the attemptId supplied before that start if its reply was lost. Returns runId (saved execution ID), stepId (its task stage), sessionId (its executor conversation), initialAssignmentStatus (completed, failed, interrupted, or unknown for the initial assignment), and conversationActivity (active, inactive, or unknown now). initialAssignmentError is the exact known reason only for a confirmed failed initial assignment; otherwise the field is absent. Later conversation activity changes neither the initial assignment status nor its error. A successful read returns operationStatus=confirmed even when the assignment failed; an unavailable read returns unknown with its concrete problem. After a native DSH failure notification, explicitly call aicraft_check_run to obtain the reason; the same check works if the notification was lost. No automatic polling or custom notifications are added. Inactive does not mean successful completion. No result content, events, or full run record are returned.',
    parameters: { runId: { type: 'string' }, attemptId: { type: 'string' } }, output,
    /**
     * Select the original attempt and expose only its short observation.
     */
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const context = callContext(exec, workspace(exec))
      return compactAgentResult(await ctx.aicraft.checkRunForAgent(context, args.runId, args.attemptId, exec.signal),
        compactRunObservation)
    },
  }))
  /**
   * Start the current stage with the plugin's exact saved assignment and assigned model in a fresh executor conversation.
   */
  register(defineTool({
    name: 'aicraft_start_step', description: "Start the current stage with the plugin's exact saved assignment and assigned model in a fresh executor conversation. expectedStep must match the actual current stage. Choose attemptId before the call: 1\u2013128 letters, digits, underscores or hyphens, unique for a new intended attempt within this task. Keep that ID if the reply is lost; it identifies the original attempt and must not be replaced to retry uncertain work. Returns runId and sessionId after the launch is accepted, before completion. DSH normally sends the executor's final text or failure notice to the original calling conversation through native subagent notifications. A notification may resume that same conversation in a later turn; keeping this turn open is unnecessary. When blocked only on the executor, end this turn with a brief waiting update and continue on the notification. Do not use sleep or polling loops. Use aicraft_check_run for an explicit check of the original run if delivery is unavailable or its outcome is uncertain. Inspect the delivered result before separately accepting the stage. Does not accept or advance the stage.",
    parameters: { expectedStep: { type: 'string', required: true }, attemptId: { type: 'string', required: true } }, output,
    /**
     * Authorize the original guarded launch while preserving standing child permissions.
     */
    async execute(args, exec) {
      return mutate(exec, 'aicraft_start_step', async (_id, _standing, context) =>
        JSON.parse(compactAgentResult(await ctx.aicraft.startStepForAgent(context, args.expectedStep, args.attemptId,
          exec.signal), value => ({ runId: value.link.id, sessionId: value.link.sessionId }))))
    },
  }))
}
