import type { MaterialDocument } from '../work-materials/types.ts';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
/** Prefer project rules; read legacy projects without changing files during queries. */
export declare function projectRulesFile(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<string>;
/**
 * Called only under the project writer lock by explicit open/prepare operations.
 */
export declare function migrateProjectRules(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<void>;
/**
 * START_METHOD_openProjectRules
 * Explicit Project rules action; preserve existing instructions when adopting the new name.
 */
export declare function openProjectRules(fs: FileSystem, cwd: string, waitMs: number, signal: AbortSignal): Promise<MaterialDocument>;
/**
 * START_METHOD_readRulesAndRole
 * Read current shared rules and the selected role without changing project files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param roleId - Role identity from the saved process.
 * @param signal - Caller cancellation.
 * @returns Current shared rules and the selected role instructions.
 */
export declare function readRulesAndRole(fs: FileSystem, cwd: string, roleId: string, signal: AbortSignal): Promise<{
    rules: string;
    role: string;
}>;
