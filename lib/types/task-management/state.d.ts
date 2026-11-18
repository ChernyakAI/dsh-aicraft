import type { z } from 'zod';
import { stateSchema } from './schemas.ts';
/** Resolve selection from saved stage states, falling back to the last completed stage. */
export declare function currentStepOf(state: z.infer<typeof stateSchema>): string | null;
/**
 * Return only the actual current stage, independently of the panel's last-done selection.
 */
export declare function actualCurrentStep(state: {
    stepStates: {
        id: string;
        status: string;
    }[];
}): string | null;
/**
 * Serialize only agreed state fields, updating the plugin write timestamp.
 */
export declare function serializeState(state: z.infer<typeof stateSchema>): string;
