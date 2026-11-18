import type { ConversationReader, WorkObservation } from '../../step-execution/ports.ts';
import type { CallContext, MessageRef, RunObservation, RunView } from '../../step-execution/types.ts';
import { NativeSessionReader, type NativeConversationCut } from './session-reader.ts';
/**
 * Read immutable native conversation facts independently of publication and task acceptance.
 */
export declare class NativeConversations implements ConversationReader {
    private readonly source;
    private readonly work;
    constructor(source: NativeSessionReader, work: WorkObservation);
    /**
     * Establish initial submission from the reserved conversation and exact original assignment, without creating work.
     */
    acceptedMessage(context: CallContext, run: RunView, signal: AbortSignal): Promise<{
        messageId: import("@deepseek-ai/dsh-llm").MessageId;
        observation: RunObservation;
        observationError?: undefined;
    } | {
        messageId: import("@deepseek-ai/dsh-llm").MessageId;
        observationError: unknown;
        observation?: undefined;
    } | undefined>;
    /** Assemble run and message observations from their exact native conversation sources.
     */
    observe(context: CallContext, run: RunView, signal: AbortSignal, messageRef?: MessageRef, executorCut?: NativeConversationCut): Promise<RunObservation>;
}
