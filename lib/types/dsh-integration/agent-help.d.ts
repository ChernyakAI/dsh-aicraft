/**
 * FILE: plugin/src/dsh-integration/agent-help.ts
 * DESCRIPTION: Assemble a complete read-only framework help response from its mandatory sources
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { OperationResult, RunObservation } from '../step-execution/types.ts';
import type { AgentHelp } from './types.ts';
/**
 * Explain the common result once in each actual tool registration, independently of work state.
 */
export declare const operationStatusDescription = "operationStatus is the command result: confirmed means an established result; rejected means a known refusal; unknown means available evidence cannot establish the outcome. It is separate from task, stage, and executor state.";
/**
 * Preserve the accepted shared result guidance in the help response.
 */
export declare const agentResultNotes = "operationStatus describes the command result, not the task, stage, or executor state. The result envelope uses operationStatus=confirmed for an established result, operationStatus=rejected for a known refusal, and operationStatus=unknown only when available evidence cannot establish the outcome. The plugin performs the checks available to it before replying. Errors retain a concrete reason; an unknown outcome may include the last confirmed state, which is not a claim about current state. Do not automatically repeat an uncertain change. No verification instruction or separate verification mode is returned. Use native DSH tools for messages, interruptions, and access to task materials and knowledge files. Obtain plugin-owned task state and configuration through AICraft, not by reading its service files directly.";
/**
 * Read all mandatory help sections using the fresh, caller-visible registration parameters.
 */
export declare function readAgentHelp(description: () => string, commands: () => ToolSchema[], notes?: () => string): AgentHelp;
/**
 * Select the public observation fields independently of the detailed panel result.
 */
export declare function compactRunObservation(value: RunObservation): {
    initialAssignmentError?: string | undefined;
    runId: string;
    stepId: string;
    sessionId: string;
    initialAssignmentStatus: "completed" | "interrupted" | "unknown" | "failed";
    conversationActivity: "unknown" | "active" | "inactive";
};
/**
 * Serialize an explicit public envelope without internal recovery addresses or refresh details.
 */
export declare function compactAgentResult<T>(result: OperationResult<T>, project: (value: T) => unknown): string;
