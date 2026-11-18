/**
 * FILE: plugin/src/validation.ts
 * DESCRIPTION: Retain schema diagnostics and describe the violated constraint structurally
 */
import { z } from 'zod';
/**
 * Validate at the owner's boundary; custom constraints supply their own descriptors in issue params.
 */
export declare function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S>;
