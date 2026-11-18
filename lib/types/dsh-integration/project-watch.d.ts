import type { Context } from '@deepseek-ai/cordis';
import type { ProjectConfig } from './config.ts';
import type { ProjectChange } from './types.ts';
/** One bounded invalidation queue and directory-watch tree per visible project. */
export declare class ProjectWatch {
    private readonly ctx;
    private readonly config;
    private readonly owners;
    constructor(ctx: Context, config: ProjectConfig);
    /**
     * START_METHOD_ProjectWatch.follow
     * follow operation.
     */
    follow(cwd: string, taskId: string | null, caller: AbortSignal): AsyncIterable<ProjectChange>;
}
