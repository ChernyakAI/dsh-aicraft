import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { CallContext, MessageRef, OperationResult, RunObservation } from '../step-execution/types.ts';
import type { StepData, TaskChangeConfirmation } from '../task-management/types.ts';
import { Service, type Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { CreateTaskRequest, TaskCreationConfirmation, ExecutionStatistics, InitializeProjectRequest, MaterialDocument, MaterialGroup, ProcessDefinition, ProcessDocument, ProcessTemplateLanguage, ProjectChange, ProjectPresence, ProjectSettings, ProjectView, RoleDocument, RunModel, TaskSnapshot } from '../types.ts';
import type { Config } from './config.ts';
import type { AgentHelp } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** AICraft operations shared by the panel and future agent tools. */
        aicraft: AicraftService;
    }
}
/**
 * Server operations shared by the AICraft panel and actual agent callers.
 */
export declare class AicraftService extends TypertRemoteService {
    private readonly config;
    /** Project identity and filesystem operations are provided by DSH. */
    static inject: string[];
    private readonly runs;
    private readonly statisticsController;
    private readonly projectWatch;
    private readonly callers;
    /**
     * @param ctx - Owning Cordis plugin context.
     * @param config - Validated operation limits.
     */
    constructor(ctx: Context, config: Config);
    /** Publish operations only after the owned accounting registration is ready.
     */
    protected [Service.init](): Promise<void>;
    /**
     * START_METHOD_AicraftService.changes
     * One event-driven project subscription, independent of the selected chat.
     */
    changes(workspaceId: string, taskId: string | null, signal: AbortSignal): AsyncIterable<ProjectChange>;
    /**
     * START_METHOD_AicraftService.status
     * Confirm that the AICraft server service is reachable.
     * @returns The stable connection status.
     */
    status(): string;
    /**
     * START_METHOD_AicraftService.projects
     * Inspect project directories for icons in the workspace picker.
     * @param signal - Caller cancellation.
     * @returns Presence information for every registered workspace.
     */
    projects(signal: AbortSignal): Promise<ProjectPresence[]>;
    /**
     * START_METHOD_AicraftService.task
     * Read task state for an explicitly selected DSH project.
     * @param workspaceId - Registered DSH Workspace identity, never an arbitrary path.
     * @param signal - Caller cancellation injected by Remote API.
     * @returns The project's current task snapshot.
     */
    task(workspaceId: string, signal: AbortSignal): Promise<TaskSnapshot>;
    /**
     * START_METHOD_AicraftService.statistics
     * Fetch derived task or executor-tree statistics separately from project/UI loading.
     */
    statistics(workspaceId: string, taskId: string, sessionId: string | null, signal: AbortSignal): Promise<ExecutionStatistics>;
    private projectPath;
    /**
     * Keep actual caller identity and the common outcome in the existing diagnostic channel.
     */
    private forCall;
    /** Expose the shared material catalog through the common read result.
     */
    materialsForCall(context: CallContext, taskId: string | null, signal: AbortSignal): Promise<OperationResult<MaterialGroup[]>>;
    /** Expose document reading through the common read result.
     */
    materialForCall(context: CallContext, path: string, signal: AbortSignal): Promise<OperationResult<MaterialDocument>>;
    /** Build trusted references from the actual tool execution, never model parameters.
     */
    contextForAgent(workspaceId: string, agent: Agent, callId: string, standing: SandboxExecutionPolicy): CallContext;
    /**
     * Build trusted panel context for the registered project without inventing a caller session.
     */
    private panelContext;
    /**
     * Select only a fully read, unambiguous open task without history or material projections.
     */
    private openTaskForAgent;
    /**
     * Read the actual current stage; the panel's last-done selection is irrelevant.
     */
    stepForAgent(context: CallContext, signal: AbortSignal): Promise<OperationResult<string | null>>;
    /**
     * Read the unchanged framework description from its settings owner.
     */
    private readHelpDescription;
    /**
     * Read the mandatory explanation independently of task or execution state.
     */
    private readHelpResultNotes;
    /**
     * Return fresh help for the trusted actual caller without reading or admitting task work.
     */
    helpForAgent(context: CallContext, catalog: (agent: Agent) => ToolSchema[], signal: AbortSignal): Promise<OperationResult<AgentHelp>>;
    /** The same task-state owner serves panel and actual agent callers.
     */
    changeTask(context: CallContext, taskId: string, operation: TaskChangeConfirmation['operation'], stepId: string | null, signal: AbortSignal, fromStepId?: string, expected?: {
        expectedStep: string | null;
    }): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.project
     * Read project readiness, process choices, current branch and task state.
     * @param workspaceId - Registered DSH project identity.
     * @param signal - Caller cancellation.
     * @returns Project state suitable for creation controls.
     */
    project(workspaceId: string, signal: AbortSignal): Promise<ProjectView>;
    /**
     * Read the open task ID and all saved stages with their actual states.
     */
    projectForAgent(context: CallContext, signal: AbortSignal): Promise<OperationResult<{
        openTaskId: string | null;
        steps: {
            id: string;
            description: string;
            status: StepData['status'];
        }[];
    }>>;
    /**
     * Apply a guarded agent transition through the common task owner and original selected task.
     */
    moveStepForAgent(context: CallContext, action: 'complete' | 'skip' | 'goto' | 'return', expectedStep: string | null, targetStep: string | undefined, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * Resolve the open task once before the shared owner rechecks its identity under lock.
     */
    closeTaskForAgent(context: CallContext, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.materials
     * List documents in the selected project, independently of the chat session.
     */
    materials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]>;
    /**
     * START_METHOD_AicraftService.material
     * Read one project material without modifying it.
     */
    material(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument>;
    /**
     * START_METHOD_AicraftService.projectRules
     * Open shared project rules, adopting the current filename on explicit request.
     */
    projectRules(workspaceId: string, signal: AbortSignal): Promise<MaterialDocument>;
    /**
     * START_METHOD_AicraftService.saveMaterial
     * Save existing Markdown with an optimistic file version guard.
     */
    saveMaterial(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<OperationResult<MaterialDocument>>;
    /** Connect versioned material saving to the common mutation result.
     */
    saveMaterialForCall(context: CallContext, path: string, text: string, version: string, signal: AbortSignal): Promise<OperationResult<MaterialDocument>>;
    /**
     * START_METHOD_AicraftService.setStepModel
     * Save the model used by subsequent runs of this task step.
     */
    setStepModel(workspaceId: string, taskId: string, stepId: string, model: RunModel, signal: AbortSignal): Promise<ProjectView>;
    /**
     * START_METHOD_AicraftService.deleteStepMaterials
     * Delete step outputs only after the panel's explicit confirmation.
     */
    deleteStepMaterials(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<ProjectView>;
    /**
     * START_METHOD_AicraftService.settings
     * Read editable project process templates and available roles.
     */
    settings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>;
    /**
     * START_METHOD_AicraftService.saveProcess
     * Persist a project process template without changing existing tasks.
     */
    saveProcess(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage: ProcessTemplateLanguage | null, signal: AbortSignal): Promise<ProcessDocument>;
    /**
     * START_METHOD_AicraftService.saveRole
     * Save project role instructions without replacing stale edits.
     */
    saveRole(workspaceId: string, id: string, text: string, version: string | null, signal: AbortSignal): Promise<RoleDocument>;
    /**
     * START_METHOD_AicraftService.deleteRole
     * Remove the selected role instruction after version and access checks.
     */
    deleteRole(workspaceId: string, id: string, version: string, signal: AbortSignal): Promise<void>;
    /**
     * START_METHOD_AicraftService.stepPrompt
     * Read or create the editable step prompt, preserving the owner's publication outcome at the Remote boundary.
     */
    stepPrompt(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<string>;
    /**
     * START_METHOD_AicraftService.defaultStepPrompt
     * Generate default editor text without saving; preserve the loaded file version.
     */
    defaultStepPrompt(workspaceId: string, taskId: string, stepId: string, version: string, signal: AbortSignal): Promise<MaterialDocument>;
    /**
     * START_METHOD_AicraftService.startStep
     * Launch the current stage in a new independent session.
     * @param workspaceId - Registered project identity.
     * @param taskId - Current task identity.
     * @param stepId - Current running stage.
     * @param model - Optional per-run model override.
     * @param signal - Creation cancellation.
     * @returns Durable executor link, without accepting the stage.
     */
    startStep(workspaceId: string, taskId: string, stepId: string, model: RunModel | null, attemptId: string, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
    /**
     * START_METHOD_AicraftService.startStepForAgent
     * Authorized agent entry; the executor inherits standing permissions, not a one-call grant.
     */
    startStepForAgent(context: CallContext, expectedStep: string, attemptId: string, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
    /** Read one attempt without reconciliation or execution.
     */
    run(workspaceId: string, taskId: string, runId: string | null, attemptId: string | null, expectedWorkspaceId: string | null, messageRef: MessageRef | null, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
    /** Route either transport to the shared saved-attempt observation.
     */
    observeRunForCall(context: CallContext, taskId: string, runId: string | null, attemptId: string | null, expectedWorkspaceId: string | null, messageRef: MessageRef | null, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
    /**
     * Read one original attempt of the selected open task without choosing a later run.
     */
    checkRunForAgent(context: CallContext, runId: string | undefined, attemptId: string | undefined, signal: AbortSignal): Promise<OperationResult<RunObservation>>;
    /**
     * START_METHOD_AicraftService.prepare
     * Prepare missing project files without overwriting existing materials.
     * @param workspaceId - Registered DSH project identity.
     * @param signal - Caller cancellation.
     * @returns Updated project state.
     */
    prepare(workspaceId: string, request: InitializeProjectRequest, signal: AbortSignal): Promise<ProjectView>;
    /**
     * START_METHOD_AicraftService.createTask
     * Create one open task in the selected project.
     * @param workspaceId - Registered DSH project identity.
     * @param request - Task title, selected process and requirements.
     * @param signal - Caller cancellation.
     * @returns Publication confirmation; full project state is read separately.
     */
    createTask(workspaceId: string, request: CreateTaskRequest, signal: AbortSignal): Promise<TaskCreationConfirmation>;
    /**
     * START_METHOD_AicraftService.workspaceForAgent
     * Resolve the registered project matching the calling agent's working directory.
     */
    workspaceForAgent(cwd: string): string;
    /**
     * START_METHOD_AicraftService.completeStep
     * Complete the current step and select the next pending stage without closing the task.
     * @param workspaceId - Registered project.
     * @param taskId - Current task identity.
     * @param stepId - Current running stage.
     * @param signal - Caller cancellation.
     * @returns Updated project state.
     */
    completeStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.goToStep
     * Select a step without resetting the other stages; the previous current stage becomes pending.
     */
    goToStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.returnStep
     * Return from a row to an eligible earlier step, preserving excluded stages and materials.
     */
    returnStep(workspaceId: string, taskId: string, fromStepId: string, stepId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.skipStep
     * Skip the current step and select the next pending stage, keeping all materials.
     */
    skipStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.closeTask
     * Close a task without deleting materials or performing Git mutations.
     * @param workspaceId - Registered project.
     * @param taskId - Current task identity.
     * @param signal - Caller cancellation.
     * @returns Updated project state.
     */
    closeTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
    /**
     * START_METHOD_AicraftService.reopenTask
     * Reopen a closed task without resetting stages, artifacts or executor history.
     */
    reopenTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<OperationResult<TaskChangeConfirmation>>;
}
/**
 * START_METHOD_resolveModel
 * Resolve the explicit model assignment with DSH without substituting a default route.
 */
export declare function resolveModel(ctx: Context, assignment: RunModel, signal: AbortSignal): Promise<RunModel>;
