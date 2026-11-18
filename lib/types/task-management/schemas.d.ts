/**
 * FILE: plugin/src/task-management/schemas.ts
 * DESCRIPTION: Validate the owning module data and inputs
 */
import { z } from 'zod';
/** Agreed task state; process snapshots and executor links live separately. */
export declare const stateSchema: z.ZodObject<{
    taskType: z.ZodString;
    taskIdentifier: z.ZodString;
    taskTitle: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        completed: "completed";
        cancelled: "cancelled";
        open: "open";
    }>;
    updatedAt: z.ZodOptional<z.ZodISODateTime>;
    createdBranch: z.ZodOptional<z.ZodString>;
    stepStates: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<{
            pending: "pending";
            skipped: "skipped";
            cancelled: "cancelled";
            current: "current";
            done: "done";
        }>;
    }, z.core.$strip>>;
}, z.core.$strict>;
export declare const requestSchema: z.ZodObject<{
    taskIdentifier: z.ZodString;
    title: z.ZodString;
    processId: z.ZodString;
    requestText: z.ZodString;
}, z.core.$strip>;
