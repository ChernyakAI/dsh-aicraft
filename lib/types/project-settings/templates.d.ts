/**
 * FILE: plugin/src/project-settings/templates.ts
 * DESCRIPTION: Supply matching Russian and English process templates
 */
import type { ProcessDefinition, ProcessTemplateLanguage, RunModel } from '../types.ts';
/**
 * START_METHOD_defaultStepModel
 * Explicit initial assignment; never inherits DSH's mutable default selection.
 */
export declare function defaultStepModel(): RunModel;
/**
 * START_METHOD_processTemplate
 * Return an editable process copy; bundled templates are never written to the project.
 */
export declare function processTemplate(language: ProcessTemplateLanguage): ProcessDefinition;
/**
 * START_METHOD_templateRoleInstructions
 * Initial role instructions; existing project instructions always take precedence.
 */
export declare function templateRoleInstructions(language: ProcessTemplateLanguage): Record<string, string>;
