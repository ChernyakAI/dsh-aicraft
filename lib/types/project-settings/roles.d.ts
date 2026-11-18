import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { RoleDocument } from './types.ts';
/**
 * START_METHOD_saveRole
 * Save a shared role instruction, using the material editor's versioned writer for edits.
 */
export declare function saveRole(fs: FileSystem, cwd: string, id: string, text: string, version: string | null, waitMs: number, signal: AbortSignal): Promise<RoleDocument>;
/**
 * START_METHOD_deleteRole
 * Delete the selected instruction, preserving every task and process reference.
 */
export declare function deleteRole(fs: FileSystem, cwd: string, id: string, version: string, waitMs: number, signal: AbortSignal): Promise<void>;
