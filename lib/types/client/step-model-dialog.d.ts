import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RunModel } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
/**
 * Show the stored route and effort without resolving historical defaults again.
 */
export declare function modelLabel(model: RunModel | null | undefined, t: PropsLocale<'aicraft'>['t']): string;
/**
 * Keep a local model and effort draft for assignment or one-shot execution.
 */
export declare function StepModelDialog({ stepTitle, disabled, t, modelCatalog, close, confirm, assignment, initialModel }: {
    stepTitle: string;
    disabled: boolean;
    t: PropsLocale<'aicraft'>['t'];
    modelCatalog(): Promise<ModelCatalog>;
    close(): void;
    confirm(model: RunModel): void;
    assignment?: boolean;
    initialModel?: RunModel | null;
}): ReactNode;
