import type { Context } from '@deepseek-ai/cordis';
/**
 * START_METHOD_resolveProject
 * resolveProject operation.
 */
export declare function resolveProject(ctx: Context, workspaceId: string): string;
/**
 * START_METHOD_workspaceForAgent
 * Resolve a registered project for an agent's actual working directory.
 * @param cwd - Session-owned directory, never a model argument.
 * @returns The matching Workspace identity.
 */
export declare function workspaceForAgent(ctx: Context, cwd: string): string;
