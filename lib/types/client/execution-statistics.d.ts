/**
 * FILE: plugin/src/client/execution-statistics.tsx
 * DESCRIPTION: Display derived execution usage and cost
 */
import { type Translator } from './messages.ts';
import type { ExecutionStatistics as Statistics } from '../types.ts';
export interface StatisticsProps {
    t: Translator;
    workspaceId: string;
    taskId: string;
    sessionId: string | null;
    active: boolean;
    revision: string;
    running?: boolean;
    load(workspaceId: string, taskId: string, sessionId: string | null, signal: AbortSignal): Promise<Statistics>;
    title?: string;
}
/**
 * Metrics have their own asynchronous lifecycle; they never block project, table or chat rendering.
 */
export declare function ExecutionStatistics({ t, workspaceId, taskId, sessionId, active, revision, load, title, running }: StatisticsProps): import("react").JSX.Element | null;
