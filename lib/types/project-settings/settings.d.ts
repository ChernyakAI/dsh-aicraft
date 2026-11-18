import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ProjectSettings } from './types.ts';
/**
 * START_METHOD_readSettings
 * Read project templates and role choices, independently of task state.
 */
export declare function readSettings(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<ProjectSettings>;
