import type { PanelFace } from './panel.tsx';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionActivity, TaskView } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
/** Latest executor chats first, with native opening and confirmed panel cancellation.
 */
export declare function RunHistory({ readOnly, task, workspaceId, statistics, active, sessionActivity, archivedSessionIds, t, openExecutor, stopGenerating, archiveChat, observeRun }: {
    readOnly: boolean;
    task: TaskView;
    workspaceId: string;
    statistics: PanelFace['statistics'];
    active: boolean;
    sessionActivity: Record<string, SessionActivity & {
        completed: string;
    }>;
    archivedSessionIds: readonly SessionId[];
    stopGenerating(sessionId: string): Promise<void>;
    archiveChat(sessionId: string): Promise<void>;
    t: PropsLocale<'aicraft'>['t'];
    openExecutor(sessionId: string): void;
    observeRun: PanelFace['observeRun'];
}): ReactNode;
