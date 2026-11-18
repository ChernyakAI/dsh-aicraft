import type { Translator } from './messages.ts';
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import { type ReactNode } from 'react';
import type { ProcessDefinition, ProcessDocument, ProcessTemplateLanguage, ProjectSettings, RoleDocument } from '../types.ts';
interface Props {
    t: Translator;
    externalRevision: number;
    workspaceId: string;
    back: ReactNode;
    projectRules(): void;
    load(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>;
    save(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage: ProcessTemplateLanguage | null): Promise<ProcessDocument>;
    saveRole(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>;
    deleteRole(workspaceId: string, id: string, version: string): Promise<void>;
    modelCatalog(): Promise<ModelCatalog>;
    dirtyChanged(dirty: boolean): void;
    saved(): void;
}
/**
 * Form editor for project templates; existing task processes are left intact.
 */
export declare function ProcessSettings({ t, externalRevision, workspaceId, back, projectRules, load, save, saveRole, deleteRole, modelCatalog, dirtyChanged, saved }: Props): import("react").JSX.Element;
export {};
