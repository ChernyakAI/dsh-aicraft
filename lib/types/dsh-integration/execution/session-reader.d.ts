import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types';
import type { CallContext } from '../../step-execution/types.ts';
export interface NativeConversationCut {
    header: SessionHeader;
    events: readonly SessionEvent[];
    upper: number;
}
export declare class NativeSessionReader {
    private readonly ctx;
    constructor(ctx: Context);
    /** Read a consistent Session Query cut within an automatically released observation.
     */
    read(context: CallContext, sessionId: string, signal: AbortSignal): Promise<NativeConversationCut>;
}
