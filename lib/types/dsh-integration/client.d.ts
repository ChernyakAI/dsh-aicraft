/**
 * FILE: plugin/src/dsh-integration/client.tsx
 * DESCRIPTION: Bind the persistent AICraft panel to native DSH services
 */
import type { Context } from '@deepseek-ai/cordis';
/** Services required to mount the Remote API and register the panel. */
export declare const inject: string[];
/**
 * START_METHOD_apply
 * Mount AICraft Remote methods and add the sidebar entry and main panel.
 * @param ctx - Browser Cordis plugin context.
 */
export declare function apply(ctx: Context): Promise<void>;
