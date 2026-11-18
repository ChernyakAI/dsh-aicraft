/**
 * FILE: plugin/src/client/task-view.tsx
 * DESCRIPTION: Render task steps and explicit stage actions
 */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RunModel, StepView, TaskView } from 'dsh-aicraft/types';
import { type ReactNode } from 'react';
import { type Translator } from './messages.ts';
/** Open only the original conversation selected from one saved run.
 */
export declare function CallerConversation({ t, sessionId, open }: {
    t: Translator;
    sessionId: string | null | undefined;
    open(): void;
}): ReactNode;
/**
 * Compact stage commands using the same menu and button primitives as DSH.
 */
export declare function StepActions({ blocked, step, previousSteps, returnTo, current, disabled, busy, setModel, prompt, run, runWithModel, modelCatalog, t, select }: {
    blocked: boolean;
    step: StepView;
    previousSteps: StepView[];
    returnTo(stepId: string): Promise<void>;
    current: boolean;
    disabled: boolean;
    busy: boolean;
    setModel(model: RunModel): Promise<void>;
    prompt(): void;
    run(): void;
    modelCatalog(): Promise<ModelCatalog>;
    runWithModel(model: RunModel): void;
    t: PropsLocale<'aicraft'>['t'];
    select(kind: 'goto' | 'skip' | 'complete'): void;
}): ReactNode;
/**
 * Render task steps independently of project loading and panel state.
 */
export declare function TaskStages({ task, busy, t, showStageMaterials, actions }: {
    task: TaskView;
    busy: boolean;
    t: PropsLocale<'aicraft'>['t'];
    showStageMaterials(stepId: string): void;
    actions(step: StepView): ReactNode;
}): ReactNode;
