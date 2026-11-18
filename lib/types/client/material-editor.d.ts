import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type ReactNode } from 'react';
import type { LocaleSource } from '../dsh-integration/client-locale.tsx';
import type { MaterialDocument, OperationResult } from '../types.ts';
/**
 * Read and version-save editor documents and request a default prompt draft.
 */
export interface MaterialEditorApi {
    t: PropsLocale<'aicraft'>['t'];
    load(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument>;
    /**
     * Editor save port supplied by PanelFace.saveMaterial.
     */
    save(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<OperationResult<MaterialDocument>>;
    resetPrompt?(workspaceId: string, taskId: string, stepId: string, version: string, signal: AbortSignal): Promise<MaterialDocument>;
    saved(workspaceId: string, path: string): void;
}
/**
 * START_METHOD_mountMaterialEditors
 * DSH's own floating layout, independent of a chat or the selected project.
 */
export declare function mountMaterialEditors(api: MaterialEditorApi & {
    locale: LocaleSource;
}): {
    open(workspaceId: string, workspaceTitle: string, path: string, preview?: MaterialDocument): void;
    dispose(): void;
};
/**
 * The task request uses the same versioned Markdown editor in a modal.
 */
export declare function TaskRequestDialog({ workspaceId, workspaceTitle, taskId, taskTitle, t, load, save, close }: {
    workspaceId: string;
    workspaceTitle: string;
    taskId: string;
    taskTitle: string;
    t: MaterialEditorApi['t'];
    load: MaterialEditorApi['load'];
    save: MaterialEditorApi['save'];
    close(): void;
}): ReactNode;
