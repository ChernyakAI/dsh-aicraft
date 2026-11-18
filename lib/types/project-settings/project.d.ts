import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { ProjectConfig } from '../dsh-integration/config.ts';
import type { ProjectReader, ProjectView } from '../dsh-integration/types.ts';
import type { InitializeProjectRequest, ProjectReadiness } from './types.ts';
export declare function text(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<string>;
export declare function createText(fs: FileSystem, cwd: string, path: string, content: string, signal: AbortSignal): Promise<void>;
/**
 * START_METHOD_hasAicraftProject
 * Identify an MVP project by its directory, without requiring metadata files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param signal - Caller cancellation.
 * @returns Whether .aicraft exists as a directory.
 */
export declare function hasAicraftProject(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<boolean>;
/**
 * START_METHOD_readProjectReadiness
 * Read required settings without inspecting knowledge materials or their marker.
 */
export declare function readProjectReadiness(fs: FileSystem, cwd: string, signal: AbortSignal, canCreate?: boolean): Promise<ProjectReadiness>;
/**
 * START_METHOD_prepareProject
 * Create missing defaults without overwriting existing project materials.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Updated project readiness.
 */
export declare function prepareProject(fs: FileSystem, subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal, request: InitializeProjectRequest | null, readProject: ProjectReader): Promise<ProjectView>;
