import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { CreateTaskRequest, TaskCreationConfirmation, InitializeProjectRequest, MaterialDocument, MaterialGroup, ProcessDefinition, ProcessDocument, ProcessTemplateLanguage, ProjectChange, ProjectPresence, ProjectSettings, ProjectView, RoleDocument, RunModel, RunView, ExecutionStatistics as Statistics } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
/**
 * Operations supplied by DSH integration to the panel, with shared mutation outcomes.
 */
export interface PanelFace {
    /** Observe platform recovery independently of an AICraft snapshot. */
    useConnectionGeneration(): number | null;
    /** Read the connection status from the AICraft server service. */
    checkConnection(): Promise<string>;
    /** Identify workspaces containing the AICraft directory. */
    loadProjects(signal: AbortSignal): Promise<ProjectPresence[]>;
    /** Read the current task for a registered project. */
    statistics(workspaceId: string, taskId: string, sessionId: string | null, signal: AbortSignal): Promise<Statistics>;
    followProject(workspaceId: string, taskId: string | null, signal: AbortSignal): AsyncIterable<ProjectChange>;
    loadProject(workspaceId: string, signal: AbortSignal): Promise<ProjectView>;
    /** Prepare missing project files. */
    prepareProject(workspaceId: string, request: InitializeProjectRequest): Promise<ProjectView>;
    /** Create a task through the shared server operation. */
    createTask(workspaceId: string, request: CreateTaskRequest): Promise<TaskCreationConfirmation>;
    goToStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>;
    returnStep(workspaceId: string, taskId: string, fromStepId: string, stepId: string): Promise<ProjectView>;
    skipStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>;
    setStepModel(workspaceId: string, taskId: string, stepId: string, model: RunModel): Promise<ProjectView>;
    deleteStepMaterials(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>;
    completeStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>;
    reopenTask(workspaceId: string, taskId: string): Promise<ProjectView>;
    closeTask(workspaceId: string, taskId: string): Promise<ProjectView>;
    startStep(workspaceId: string, taskId: string, stepId: string, model: RunModel | null, attemptId: string): Promise<RunView>;
    observeRun(workspaceId: string, taskId: string, runId: string | null, attemptId: string | null): Promise<import('../types.ts').RunObservation>;
    loadMaterials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]>;
    loadMaterial(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument>;
    /**
     * Client save port passed to TaskRequestDialog's document editor.
     */
    saveMaterial(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<import('../types.ts').OperationResult<MaterialDocument>>;
    showStepPrompt(workspaceId: string, workspaceTitle: string, taskId: string, stepId: string): Promise<void>;
    openProjectRules(workspaceId: string, workspaceTitle: string): Promise<void>;
    openMaterial(workspaceId: string, workspaceTitle: string, path: string, preview?: MaterialDocument): void;
    loadSettings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>;
    saveProcess(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage: ProcessTemplateLanguage | null): Promise<ProcessDocument>;
    saveRole(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>;
    deleteRole(workspaceId: string, id: string, version: string): Promise<void>;
    modelCatalog(): Promise<ModelCatalog>;
    stopGenerating(sessionId: string): Promise<void>;
    archiveChat(sessionId: string): Promise<void>;
    openExecutor(sessionId: string): void;
}
export type PanelProps = PropsRuntime<'main'> & PropsLocale<'aicraft'> & InjectFace<PanelFace> & {
    sessionId?: SessionId;
    visible: boolean;
};
/**
 * START_METHOD_AicraftPanel
 * Render project controls and show the server connection error only on failure.
 * @param props - Slot-owned translations and server operation.
 * @returns The AICraft panel.
 */
export declare function AicraftPanel({ t, checkConnection, loadProjects, loadProject, followProject, statistics, prepareProject, createTask, goToStep, returnStep, skipStep, completeStep, closeTask, reopenTask, startStep, observeRun, loadMaterials, loadMaterial, saveMaterial, setStepModel, deleteStepMaterials, openMaterial, openProjectRules, showStepPrompt, modelCatalog, loadSettings, saveProcess, saveRole, deleteRole, openExecutor, stopGenerating, archiveChat, useWorkspaces, useConnectionGeneration, sessionId, visible }: PanelProps): ReactNode;
