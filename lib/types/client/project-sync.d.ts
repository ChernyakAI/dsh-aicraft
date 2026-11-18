/**
 * FILE: plugin/src/client/project-sync.ts
 * DESCRIPTION: Bound project rereads and publish only the latest live request
 */
/**
 * START_METHOD_projectReader
 * Own read cancellation independently of the project event stream.
 * @param load - Read the selected project.
 * @param lifetime - Selected context lifetime.
 * @param available - Whether DSH currently provides a ready connection.
 * @param publish - Apply a result of the latest live read.
 * @param failed - Report a read failure without ending observation.
 * @param settled - Finish the latest live cycle after success or its last failed attempt.
 * @returns A request function with its current in-flight state.
 */
export declare function projectReader<T>(load: (signal: AbortSignal) => Promise<T>, lifetime: AbortSignal, available: () => boolean, publish: (value: T) => void, failed: (error: unknown) => void, settled?: () => void): (() => void) & {
    pending(): boolean;
};
