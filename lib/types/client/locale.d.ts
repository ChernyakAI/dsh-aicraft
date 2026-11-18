/**
 * FILE: plugin/src/client/locale.ts
 * DESCRIPTION: Expose complete dictionaries and the typed DSH namespace
 */
export { en } from './locale-en.ts';
import type { en } from './locale-en.ts';
export { zh, ru, ja, es, fr, de, pt } from './locale-translations.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** AICraft presentation copy. */
        aicraft: keyof typeof en;
    }
}
