/**
 * FILE: plugin/src/dsh-integration/agent-tools.ts
 * DESCRIPTION: Authorize agent calls before invoking shared server operations
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * START_METHOD_registerAgentTools
 * Expose the same operations used by the panel to agents in their own project.
 * @param ctx - Context with AICraft and tool registry dependencies.
 */
export declare function registerAgentTools(ctx: Context): void;
