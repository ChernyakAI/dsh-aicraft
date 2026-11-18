/**
 * FILE: plugin/src/client/initialize-project.tsx
 * DESCRIPTION: Choose the initial project process
 */
import type { Translator } from './messages.ts';
import type { InitializeProjectRequest } from '../types.ts';
/**
 * Choose a demo process or create an empty process for project settings.
 */
export declare function InitializeProject({ t, busy, submit, cancel, dirtyChanged }: {
    t: Translator;
    busy: boolean;
    submit(request: InitializeProjectRequest): Promise<void>;
    cancel(): void;
    dirtyChanged(dirty: boolean): void;
}): import("react").JSX.Element;
