/**
 * FILE: plugin/src/client/messages.ts
 * DESCRIPTION: Render retained presentation facts using the current translator
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type UiMessage } from '../ui-message.ts';
export type Translator = PropsLocale<'aicraft'>['t'];
/** Local messages retain the original failure, including unknown outcomes and nested causes. */
export interface Notice {
    value: unknown;
    context?: UiMessage;
}
/**
 * Retain an asynchronous result without freezing its language.
 */
export declare function notice(value: unknown, context?: UiMessage): Notice;
/**
 * Translate a known descriptor; unknown keys use an action explanation and the original diagnostic.
 */
export declare function messageText(t: Translator, message: UiMessage | undefined, original?: string | null): string;
/**
 * Render a retained failure at display time, preserving structured reasons and original external details.
 */
export declare function noticeText(t: Translator, retained: Notice | null): string;
