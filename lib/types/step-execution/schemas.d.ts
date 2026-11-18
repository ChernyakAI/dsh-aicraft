/**
 * FILE: plugin/src/step-execution/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod';
import type { UiMessage } from '../ui-message.ts';
/**
 * Validate the caller-supplied attempt identifier before lookup or publication.
 */
export declare const attemptIdSchema: z.ZodString;
/**
 * Explicit process assignment, resolved through DSH's provider registry.
 */
export declare const modelAssignmentSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    reasoningEffort: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
/**
 * Durable execution records; old task files may have no runs yet.
 */
export declare const runSchema: z.ZodObject<{
    id: z.ZodString;
    stepId: z.ZodString;
    sessionId: z.ZodString;
    status: z.ZodEnum<{
        running: "running";
        completed: "completed";
        starting: "starting";
        interrupted: "interrupted";
        failed: "failed";
    }>;
    startedAt: z.ZodString;
    finishedAt: z.ZodNullable<z.ZodString>;
    outputPath: z.ZodString;
    model: z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        reasoningEffort: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    error: z.ZodNullable<z.ZodString>;
    errorMessage: z.ZodOptional<z.ZodPipe<z.ZodObject<{
        key: z.ZodString;
        params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        details: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>, z.ZodTransform<UiMessage, {
        key: string;
        params?: Record<string, string | number> | undefined;
        details?: string[] | undefined;
    }>>>;
    taskId: z.ZodOptional<z.ZodString>;
    attemptId: z.ZodOptional<z.ZodString>;
    callerSessionId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    request: z.ZodOptional<z.ZodObject<{
        stepId: z.ZodString;
        modelOverride: z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            reasoningEffort: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    dispatch: z.ZodOptional<z.ZodObject<{
        phase: z.ZodEnum<{
            registered: "registered";
            submitting: "submitting";
            accepted: "accepted";
            rejected: "rejected";
        }>;
        messageId: z.ZodNullable<z.ZodString>;
        reason: z.ZodNullable<z.ZodString>;
        reasonMessage: z.ZodOptional<z.ZodPipe<z.ZodObject<{
            key: z.ZodString;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            details: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>, z.ZodTransform<UiMessage, {
            key: string;
            params?: Record<string, string | number> | undefined;
            details?: string[] | undefined;
        }>>>;
    }, z.core.$strip>>;
    initialTurn: z.ZodOptional<z.ZodObject<{
        turn: z.ZodNullable<z.ZodNumber>;
        messageId: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    promptVersion: z.ZodOptional<z.ZodString>;
    promptSha256: z.ZodOptional<z.ZodString>;
    executionBackend: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            standalone: "standalone";
            "spawn-in-process": "spawn-in-process";
        }>;
        providerName: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
