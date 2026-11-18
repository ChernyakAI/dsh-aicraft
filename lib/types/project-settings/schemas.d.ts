/**
 * FILE: plugin/src/project-settings/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod';
/**
 * Validate editable process fields while retaining additional route metadata.
 */
export declare const processDraftSchema: z.ZodObject<{
    language: z.ZodOptional<z.ZodEnum<{
        ru: "ru";
        en: "en";
    }>>;
    name: z.ZodString;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        role: z.ZodString;
        model: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            reasoningEffort: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>>>, z.ZodTransform<import("../types.ts").RunModel, {
            provider: string;
            model: string;
            reasoningEffort: string | null;
        } | null | undefined>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** Executable task routes must contain at least one step. */
export declare const processSchema: z.ZodObject<{
    language: z.ZodOptional<z.ZodEnum<{
        ru: "ru";
        en: "en";
    }>>;
    name: z.ZodString;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        role: z.ZodString;
        model: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            reasoningEffort: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        }, z.core.$strip>>>, z.ZodTransform<import("../types.ts").RunModel, {
            provider: string;
            model: string;
            reasoningEffort: string | null;
        } | null | undefined>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
