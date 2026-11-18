import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection';
import type { ExecutionStatistics } from '../types.ts';
import { type AccountingState } from './accounting.ts';
/** Host-owned persisted folds and bounded query admission, independent of panel rendering. */
export declare class StatisticsController {
    private readonly ctx;
    private readonly lockWaitMs;
    readonly ready: Promise<ProjectionHandle<AccountingState>>;
    private readonly attached;
    private readonly packets;
    private readonly source;
    private readers;
    private readonly waiting;
    constructor(ctx: Context, lockWaitMs?: number);
    /** Keep project accounting metadata separate from session logs. */
    private tracking;
    /**
     * START_METHOD_StatisticsController.track
     * Track only AICraft executors and their native descendants; never append custom chat events.
     */
    track(agent: Agent): Promise<void>;
    /**
     * START_METHOD_StatisticsController.read
     * Validate the requested root; retain saved descendants even when their parent packet is unavailable.
     */
    read(cwd: string, taskId: string, sessionId: string | null, signal: AbortSignal): Promise<ExecutionStatistics>;
    /** Keep one bounded LRU of completed folds; source validation never globally resolves a direct file. */
    private observe;
}
