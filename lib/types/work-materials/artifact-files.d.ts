import type { FileSystem } from '@deepseek-ai/dsh-fs';
/** Internal knowledge selection shared by discovery and the watch snapshot.
 */
export declare const KNOWLEDGE_ROOT = ".aicraft/knowledge-base";
/**
 * Recognize ordinary Markdown files for knowledge selection.
 */
export declare function isKnowledgeFile(name: string, type: string | undefined): boolean;
/**
 * START_METHOD_targetFor
 * Resolve only AICraft materials inside the registered project, including link targets.
 */
export declare function targetFor(fs: FileSystem, cwd: string, path: string, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-fs").FsTarget>;
/** Share bounded discovery: shallow knowledge selection, recursive stage materials.
 * Native DSH list failures propagate before selection.
 */
export declare function createArtifactScanner(fs: FileSystem, cwd: string, signal: AbortSignal, maxFiles?: number, firstOnly?: boolean): (path: string, depth?: number) => Promise<string[]>;
/**
 * START_METHOD_artifactSummary
 * Artifact discovery failures must not invalidate otherwise valid task state.
 */
export declare function artifactSummary(fs: FileSystem, cwd: string, path: string, signal: AbortSignal): Promise<{
    artifactCount: number | null;
    artifactIssue: string | null;
    artifactIssueMessage?: import('../ui-message.ts').UiMessage;
}>;
/**
 * START_METHOD_hasKnowledgeMaterials
 * Detect a first usable knowledge material without loading the corpus.
 */
export declare function hasKnowledgeMaterials(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<boolean>;
