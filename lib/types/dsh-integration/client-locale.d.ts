/**
 * FILE: plugin/src/dsh-integration/client-locale.tsx
 * DESCRIPTION: Adapt native locale revisions for the independent floating editor root
 */
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client';
import type { Translator } from '../client/messages.ts';
export interface LocaleSource {
    getSnapshot(): {
        active: string;
        revision: number;
        t: Translator;
    };
    subscribe(listener: () => void): () => void;
}
/**
 * Cache one immutable translator snapshot per native revision; the root owns its sole subscription.
 */
export declare function editorLocale(runtime: LocaleRuntime): LocaleSource;
