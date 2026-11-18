import type { PanelFace } from './panel.tsx';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { TaskView } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
/**
 * Material catalog stays visible while documents open in independent floating panels.
 */
export declare function MaterialsBrowser({ active, workspaceId, workspaceTitle, task, canDelete, busy, deleteArtifacts, initialGroup, refresh, resetScroll, t, loadMaterials, openMaterial }: {
    active: boolean;
    workspaceId: string;
    workspaceTitle: string;
    task: TaskView | null;
    canDelete: boolean;
    busy: boolean;
    deleteArtifacts(stepId: string): Promise<void>;
    initialGroup: string | null;
    refresh: number;
    resetScroll(): void;
    t: PropsLocale<'aicraft'>['t'];
    loadMaterials: PanelFace['loadMaterials'];
    openMaterial: PanelFace['openMaterial'];
}): ReactNode;
