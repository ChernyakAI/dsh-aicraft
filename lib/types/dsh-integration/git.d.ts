import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { ProjectConfig } from './config.ts';
/**
 * START_METHOD_gitDirectory
 * Per-worktree metadata directory; HEAD lives here even when .git is a file.
 */
export declare function gitDirectory(subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal): Promise<string | null>;
/**
 * START_METHOD_currentBranch
 * Read the branch as a reminder; missing Git never blocks project operations.
 */
export declare function currentBranch(subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal): Promise<string | null>;
