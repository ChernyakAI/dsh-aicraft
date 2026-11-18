import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { MaterialDocument, MaterialGroup } from '../types.ts';
import type { MutationProgress } from '../step-execution/types.ts';
export { targetFor } from '../work-materials/artifact-files.ts';
/**
 * START_METHOD_listMaterials
 * List task and project documents without reading their contents or requiring a chat.
 */
export declare function listMaterials(fs: FileSystem, cwd: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]>;
/**
 * START_METHOD_readMaterial
 * Read bounded UTF-8 content; unsupported or binary files never render as HTML.
 */
export declare function readMaterial(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<MaterialDocument>;
/**
 * START_METHOD_saveMaterial
 * Save versioned Markdown and reconcile a lost receipt once under the original lock.
 */
export declare function saveMaterial(fs: FileSystem, cwd: string, path: string, text: string, version: string, lockWaitMs: number, signal: AbortSignal, progress?: MutationProgress<MaterialDocument>): Promise<MaterialDocument>;
