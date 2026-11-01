/**
 * FILE: plugin/src/dsh-integration/agent-tools.ts
 * DESCRIPTION: Authorize agent calls before invoking shared server operations
 */
import type { Context } from '@deepseek-ai/cordis'
import { approveEscalation,type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool,type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { } from '@deepseek-ai/dsh-user-approval'
import { resolve } from 'node:path'
import type { } from './service.ts'
import { checkTaskCreation } from './creation-result.ts'

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const taskId = { type: 'string' as const, required: true as const, description: 'Current task ID returned by aicraft_project.' }

const stepId = { type: 'string' as const, required: true as const, description: 'Step ID from the task saved process.' }
/**
 * START_METHOD_registerAgentTools
 * Expose the same operations used by the panel to agents in their own project.
 * @param ctx - Context with AICraft and tool registry dependencies.
 */
export function registerAgentTools(ctx: Context): void {
  const workspace = (exec: ToolRunContext): string => {
    const cwd = exec.agent?.session.header.cwd
    if (!cwd) throw new Error('AICraft tools require an agent with a project working directory')
    return ctx.aicraft.workspaceForAgent(cwd)
  }
  // Agent calls authorize the project-scoped write capability before entering shared UI operations.
  const mutate = async (exec: ToolRunContext, name: string, call: (workspaceId: string, standing: SandboxExecutionPolicy) =>
  Promise<unknown>): Promise<string> => {
    exec.signal.throwIfAborted()
    const workspaceId = workspace(exec)
    const policyService = ctx.get('sandboxPolicy')
    if (!policyService) throw new Error('AICraft agent mutations require the DSH sandbox policy service')
    const standing = policyService.resolve({ session: exec.agent!.session })
    if (resolve(standing.workspaceRoot) !== resolve(exec.agent!.session.header.cwd!)) throw new Error('AICraft project must match the session workspace')
    if (standing.mode === 'read-only') {
      await approveEscalation({ requestedMode: 'workspace-write', effectiveMode: standing.mode,
        justification: `${name} changes AICraft task data in the current project${name === 'aicraft_start_step' ? ' and starts an executor with the calling session permission mode' : ''}.`, subject: 'AICraft operation' },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: name, signal: exec.signal })
    } else if (standing.mode !== 'workspace-write' && standing.mode !== 'danger-full-access') throw new Error('Unknown DSH sandbox permission mode')
    exec.signal.throwIfAborted()
    return JSON.stringify(await call(workspaceId, standing))
  }
  /** Read the session project or check an exact task after a lost creation response.
   */
  ctx.tools.register(defineTool({
    name: 'aicraft_project', description: 'Read AICraft state and processes in the current session project.',
    parameters: {
      taskIdentifier: { type: 'string', description: 'Exact Task ID to check after an unknown creation outcome.' },
      expectedWorkspaceId: { type: 'string', description: 'Original workspace ID, when known; never check a different project.' },
    }, output,
    async execute(args, exec) {
      const workspaceId = workspace(exec)
      if (!args.taskIdentifier) return JSON.stringify(await ctx.aicraft.projectForAgent(workspaceId, exec.signal))
      if (args.expectedWorkspaceId && args.expectedWorkspaceId !== workspaceId) return JSON.stringify({ project: null,
        check: checkTaskCreation(args.expectedWorkspaceId, args.taskIdentifier, null, 'The session project differs from the original workspace') })
      try {
        const project = await ctx.aicraft.projectForAgent(workspaceId, exec.signal)
        return JSON.stringify({ project, check: checkTaskCreation(workspaceId, args.taskIdentifier, project) })
      } catch (error) {
        return JSON.stringify({ project: null, check: checkTaskCreation(workspaceId, args.taskIdentifier, null,
          error instanceof Error ? error.message : String(error)) })
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_prepare_project', description: 'Prepare missing AICraft project files without overwriting existing files.',
    parameters: {
      template: { type: 'string', required: true, description: 'Bundled process language: ru or en. Ask the user before choosing.' },
      processId: { type: 'string', required: true, description: 'Lowercase identifier for the initial process, such as feature.' },
    }, output,
    async execute(args, exec) {
      if (args.template !== 'ru' && args.template !== 'en') throw new Error('Choose ru or en')
      const template = args.template
      return mutate(exec, 'aicraft_prepare_project', workspaceId => ctx.aicraft.prepare(workspaceId, { template, processId: args.processId, definition: null }, exec.signal))
    },
  }))
  /** Return a creation outcome independently of the subsequent project read.
   */
  ctx.tools.register(defineTool({
    name: 'aicraft_create_task', description: 'Create an AICraft task. Returns confirmation only; read aicraft_project separately. Never repeat creation after unknown: check the original Task ID with aicraft_project. Git is not required.',
    parameters: {
      taskIdentifier: { type: 'string', required: true, description: 'User-chosen task directory ID, such as export-report; 1–128 letters, digits, hyphens or underscores, starting with a letter or digit.' },
      title: { type: 'string', required: true, description: 'Task title.' },
      processId: { type: 'string', required: true, description: 'Process ID returned by aicraft_project.' },
      requestText: { type: 'string', required: true, description: 'Requirements and acceptance criteria.' },
    }, output,
    async execute(args, exec) {
      return mutate(exec, 'aicraft_create_task', async (workspaceId) => {
        try {
          const confirmation = await ctx.aicraft.createTask(workspaceId, args, exec.signal)
          return { outcome: 'created', workspaceId, confirmation }
        } catch (error) {
          const refusal = error as { code?: string; message?: string }
          return { outcome: refusal.code === 'aicraft/task-not-created' ? 'not-created' : 'unknown',
            workspaceId, taskIdentifier: args.taskIdentifier, reason: error instanceof Error ? error.message : String(error),
            nextAction: 'Read aicraft_project with taskIdentifier and expectedWorkspaceId; do not automatically repeat creation.' }
        }
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_move_step', description: 'Select a non-cancelled task step, including a skipped step. Returning resets later statuses but keeps all materials.',
    parameters: { taskId, stepId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_move_step', workspaceId => ctx.aicraft.moveStep(workspaceId, args.taskId, args.stepId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_complete_step', description: 'Complete the current running step and select the next pending step. Does not close the task.',
    parameters: { taskId, stepId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_complete_step', workspaceId => ctx.aicraft.completeStep(workspaceId, args.taskId, args.stepId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_go_to_step', description: 'Make the selected step current, including a skipped step, and the previous current step pending. Preserve every other status and all materials; cancelled targets are refused.',
    parameters: { taskId, stepId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_go_to_step', workspaceId => ctx.aicraft.goToStep(workspaceId, args.taskId, args.stepId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_return_step', description: 'Return from the current running task step to an earlier step, including a skipped target but excluding cancelled targets. Reset later ordinary stages to pending; preserve other skipped/cancelled statuses and all materials.',
    parameters: { taskId, fromStepId: { ...stepId, description: 'Current running step ID; the target must precede this step.' }, stepId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_return_step', workspaceId => ctx.aicraft.returnStep(workspaceId, args.taskId, args.fromStepId, args.stepId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_skip_step', description: 'Skip the current running step and select the next pending step. Keeps materials and does not close the task.',
    parameters: { taskId, stepId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_skip_step', workspaceId => ctx.aicraft.skipStep(workspaceId, args.taskId, args.stepId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_close_task', description: 'Close the current task explicitly. Keeps files and performs no Git commits or merges.',
    parameters: { taskId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_close_task', workspaceId => ctx.aicraft.closeTask(workspaceId, args.taskId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_reopen_task', description: 'Reopen a closed task only when no task is open. Preserve stages, artifacts and chat history.',
    parameters: { taskId }, output,
    async execute(args, exec) { return mutate(exec, 'aicraft_reopen_task', workspaceId => ctx.aicraft.reopenTask(workspaceId, args.taskId, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'aicraft_start_step', description: 'Start the current running stage in a separate executor session using its explicit model assignment (Flash for new or legacy unassigned steps). Does not accept or advance the stage.',
    parameters: { taskId, stepId }, output,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('AICraft execution requires an agent session')
      return mutate(exec, 'aicraft_start_step', (workspaceId, standing) => ctx.aicraft.startStepForAgent(workspaceId, args.taskId, args.stepId, standing.mode, exec.signal))
    },
  }))
}
// END_METHOD_registerAgentTools
