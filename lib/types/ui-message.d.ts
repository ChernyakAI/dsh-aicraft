/**
 * FILE: plugin/src/ui-message.ts
 * DESCRIPTION: Carry locale-independent presentation facts between message owners and views
 */
import type { MessageParameters } from './ui-message-catalog.ts';
/** A concrete message key and its original substitutions; no rendered locale is persisted. */
export interface UiMessage {
    key: string;
    params?: Record<string, string | number>;
    details?: string[];
}
type OwnedMessage = {
    [K in keyof MessageParameters]: {
        key: K;
        details?: string[];
    } & (keyof MessageParameters[K] extends never ? {
        params?: never;
    } : {
        params: MessageParameters[K];
    });
}[keyof MessageParameters];
/**
 * Attach presentation metadata at the point that establishes the reason, retaining the original error.
 */
export declare function withUiMessage<T extends object>(value: T, uiMessage: UiMessage): T & {
    uiMessage: UiMessage;
};
/**
 * Check owned keys and parameter names while keeping the wire descriptor open to future keys.
 */
export declare function ownMessage(message: OwnedMessage): UiMessage;
/**
 * Read explicit metadata through causal wrappers, without interpreting diagnostic prose.
 */
export declare function messageOf(value: unknown): UiMessage | undefined;
/**
 * Preserve an external diagnostic unchanged under a concrete localized explanation.
 */
export declare function externalMessage(key: keyof MessageParameters, error: unknown): UiMessage;
export {};
