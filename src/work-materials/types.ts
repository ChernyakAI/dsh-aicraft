/**
 * FILE: plugin/src/work-materials/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
/** A workspace-relative document listed in a material group. */
export interface MaterialFile { path: string; name: string }

/** Documents grouped by task stage or project purpose. */
export interface MaterialGroup { id: string; title: string; files: MaterialFile[]; issue: string | null }

/** Bounded read-only document content for the panel. */
export interface MaterialDocument { path: string; text: string; version: string; format: 'markdown' | 'text'; readOnly?: boolean }
