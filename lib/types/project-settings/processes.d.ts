import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { z } from 'zod';
import { processSchema } from './schemas.ts';
import type { ProcessDefinition, ProcessDocument, ProcessTemplateLanguage } from './types.ts';
/**
 * Validate process identifiers before constructing project-relative paths.
 */
export declare function identifier(id: string): void;
/**
 * Parse a process draft and retain the violated schema constraint.
 */
export declare function definition(text: string): {
    [x: string]: unknown;
    name: string;
    steps: {
        [x: string]: unknown;
        id: string;
        title: string;
        role: string;
        model: import("../types.ts").RunModel;
        description?: string | undefined;
    }[];
    language?: "ru" | "en" | undefined;
};
/**
 * Read the original versioned process definition.
 */
export declare function readProcess(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<ProcessDocument>;
/**
 * START_METHOD_saveProcess
 * Save only a project template with version checks; never rewrite task snapshots.
 */
export declare function saveProcess(fs: FileSystem, cwd: string, id: string, input: ProcessDefinition, version: string | null, waitMs: number, signal: AbortSignal, templateLanguage?: ProcessTemplateLanguage | null): Promise<ProcessDocument>;
/**
 * Read and validate the selected process without changing its contents.
 */
export declare function process(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<z.infer<typeof processSchema>>;
/**
 * START_METHOD_readProcessForTask
 * Validate the selected process and its current shared instructions.
 */
export declare function readProcessForTask(fs: FileSystem, cwd: string, id: string, signal: AbortSignal): Promise<{
    [x: string]: unknown;
    name: string;
    steps: {
        [x: string]: unknown;
        id: string;
        title: string;
        role: string;
        model: import("../types.ts").RunModel;
        description?: string | undefined;
    }[];
    language?: "ru" | "en" | undefined;
}>;
