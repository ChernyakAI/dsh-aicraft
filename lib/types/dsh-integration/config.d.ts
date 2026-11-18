/**
 * FILE: plugin/src/dsh-integration/config.ts
 * DESCRIPTION: Define deployment limits for Git reads and project writer locks
 */
import Schema from '@deepseek-ai/schemastery';
/** Execution limits supplied by the plugin configuration. */
export interface ProjectConfig {
    gitTimeoutMs: number;
    gitGraceMs: number;
    lockWaitMs: number;
}
/** Deployment limits for Git reads and project writer locks. */
export type Config = ReturnType<typeof Config>;
/** Validate operation limits before plugin activation. */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    oneCDark: Schema<boolean, boolean, "volatile-defined">;
    gitTimeoutMs: Schema<number, number, "defined">;
    gitGraceMs: Schema<number, number, "defined">;
    lockWaitMs: Schema<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    oneCDark: Schema<boolean, boolean, "volatile-defined">;
    gitTimeoutMs: Schema<number, number, "defined">;
    gitGraceMs: Schema<number, number, "defined">;
    lockWaitMs: Schema<number, number, "defined">;
}>>, "plain">;
