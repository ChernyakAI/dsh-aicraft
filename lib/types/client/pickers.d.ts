/**
 * FILE: plugin/src/client/pickers.tsx
 * DESCRIPTION: Select registered projects and saved tasks
 */
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ProjectPresence, TaskView } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
/** Use DSH's standard menu so project entries can carry the sidebar icon. */
export declare function ProjectPicker({ projects, presence, selectedId, busy, t, select }: {
    projects: readonly WorkspaceView[];
    presence: ProjectPresence[];
    selectedId: string;
    busy: boolean;
    t: PropsLocale<'aicraft'>['t'];
    select(id: string): void;
}): ReactNode;
/** Browse task history without changing the project's open task. */
export declare function TaskPicker({ tasks, selectedId, busy, t, select, create, canCreate }: {
    tasks: TaskView[];
    selectedId: string;
    busy: boolean;
    t: PropsLocale<'aicraft'>['t'];
    select(id: string): void;
    create(): void;
    canCreate: boolean;
}): ReactNode;
/**
 * Render the AICraft sidebar icon.
 * @param props - Icon size supplied by the sidebar.
 * @returns A forged crafting hammer with three magic sparks.
 */
export declare function AicraftIcon({ size }: {
    size: number;
}): ReactNode;
