import { approveEscalation } from "@deepseek-ai/dsh-sandbox";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { Service, symbols } from "@deepseek-ai/cordis";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { z } from "zod";
import { parse } from "jsonc-parser";
import { brandNumber, brandString } from "@deepseek-ai/dsh-brand";
import { readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { workspaceDomainState } from "@deepseek-ai/dsh-workspace";
import { finalAssistantOutput } from "@deepseek-ai/dsh-subagent";
import Schema from "@deepseek-ai/schemastery";
/**
* Preserve the accepted shared result guidance in the help response.
*/
const agentResultNotes = "operationStatus describes the command result, not the task, stage, or executor state. The result envelope uses operationStatus=confirmed for an established result, operationStatus=rejected for a known refusal, and operationStatus=unknown only when available evidence cannot establish the outcome. The plugin performs the checks available to it before replying. Errors retain a concrete reason; an unknown outcome may include the last confirmed state, which is not a claim about current state. Do not automatically repeat an uncertain change. No verification instruction or separate verification mode is returned. Use native DSH tools for messages, interruptions, and access to task materials and knowledge files. Obtain plugin-owned task state and configuration through AICraft, not by reading its service files directly.";
/**
* Format only the supported flat parameter shapes, refusing a misleading signature.
*/
function parameterType(schema) {
	if (!schema || typeof schema !== "object") throw new Error("Unsupported AICraft parameter schema");
	if (Object.keys(schema).some((key) => ![
		"type",
		"enum",
		"oneOf",
		"description",
		"title"
	].includes(key))) throw new Error("Unsupported AICraft parameter constraint; a trustworthy signature cannot be produced");
	const node = schema;
	if (node.oneOf !== void 0) {
		if (!Array.isArray(node.oneOf) || node.oneOf.length < 2 || node.type !== void 0 || node.enum !== void 0) throw new Error("Unsupported AICraft parameter union");
		return node.oneOf.map(parameterType).join(" | ");
	}
	if (node.enum !== void 0) {
		if (node.type !== "string" || !Array.isArray(node.enum) || !node.enum.length || node.enum.some((value) => typeof value !== "string")) throw new Error("Unsupported AICraft parameter enum");
		return node.enum.map((value) => JSON.stringify(value)).join(" | ");
	}
	if (node.type === "string" || node.type === "null") return node.type;
	throw new Error("Unsupported AICraft parameter shape; a trustworthy signature cannot be produced");
}
/**
* Read all mandatory help sections using the fresh, caller-visible registration parameters.
*/
function readAgentHelp(description, commands, notes = () => agentResultNotes) {
	const text = description();
	if (typeof text !== "string" || !text.trim()) throw new Error("The AICraft description is unavailable");
	const catalog = commands().map((command) => {
		const schema = command.parameters;
		if (schema.type !== "object" || !schema.properties) throw new Error("Unsupported AICraft command parameters");
		const parameters = Object.entries(schema.properties).map(([name, node]) => name + (schema.required?.includes(name) ? "" : "?") + ": " + parameterType(node)).join(", ");
		return {
			name: command.name,
			signature: command.name + "(" + parameters + ")",
			description: command.description
		};
	});
	const resultNotes = notes();
	if (typeof resultNotes !== "string" || !resultNotes.trim()) throw new Error("The AICraft result notes are unavailable");
	return {
		description: text,
		commands: catalog,
		resultNotes
	};
}
/**
* Select the public observation fields independently of the detailed panel result.
*/
function compactRunObservation(value) {
	return {
		runId: value.link.id,
		stepId: value.link.stepId,
		sessionId: value.link.sessionId,
		initialAssignmentStatus: value.initialOutcome.state,
		conversationActivity: value.activity.selected.state,
		...value.initialOutcome.state === "failed" && value.initialOutcome.reason ? { initialAssignmentError: value.initialOutcome.reason } : {}
	};
}
/**
* Serialize an explicit public envelope without internal recovery addresses or refresh details.
*/
function compactAgentResult(result, project) {
	if (result.operationStatus === "confirmed") {
		const value = project(result.value);
		return JSON.stringify(value === void 0 ? { operationStatus: result.operationStatus } : {
			operationStatus: result.operationStatus,
			value
		});
	}
	const problem = {
		code: result.problem.code,
		message: result.problem.message,
		correlationId: result.problem.correlationId,
		...result.problem.cause === void 0 ? {} : { cause: result.problem.cause }
	};
	if (result.operationStatus === "rejected") return JSON.stringify({
		operationStatus: result.operationStatus,
		problem
	});
	const state = result.lastConfirmedState;
	if (state === void 0) return JSON.stringify({
		operationStatus: result.operationStatus,
		problem
	});
	const lastConfirmedState = {
		taskId: state.taskId,
		status: state.status,
		currentStep: state.currentStep,
		attemptId: state.attemptId,
		runId: state.runId,
		stepId: state.stepId,
		sessionId: state.sessionId,
		initialAssignmentStatus: state.initialAssignmentStatus,
		conversationActivity: state.conversationActivity
	};
	return JSON.stringify({
		operationStatus: result.operationStatus,
		problem,
		lastConfirmedState
	});
}
//#endregion
//#region .build/host/dsh-integration/agent-tools.js
const output = {
	schema: { type: "string" },
	render: (_args, value) => [{
		type: "text",
		text: value
	}]
};
/**
* START_METHOD_registerAgentTools
* Expose the same operations used by the panel to agents in their own project.
* @param ctx - Context with AICraft and tool registry dependencies.
*/
function registerAgentTools(ctx) {
	const own = /* @__PURE__ */ new Map();
	/**
	* Retain the exact definitions from these registrations for the caller-specific help catalog.
	*/
	const register = (tool) => {
		tool.parameters.additionalProperties = false;
		own.set(tool, tool.description);
		tool.description += " operationStatus is the command result: confirmed means an established result; rejected means a known refusal; unknown means available evidence cannot establish the outcome. It is separate from task, stage, and executor state.";
		ctx.tools.register(tool);
	};
	/**
	* Resolve the registered project from the actual calling agent's working directory.
	*/
	const workspace = (exec) => {
		const cwd = exec.agent?.session.header.cwd;
		if (!cwd) throw new Error("AICraft tools require an agent with a project working directory");
		return ctx.aicraft.workspaceForAgent(cwd);
	};
	/**
	* Read the actual caller's standing sandbox policy without promoting a one-call grant.
	*/
	const standingPolicy = (exec) => {
		const policy = ctx.get("sandboxPolicy");
		if (!policy || !exec.agent) throw new Error("AICraft requires the actual agent sandbox policy");
		return policy.resolve({ session: exec.agent.session });
	};
	const callContext = (exec, workspaceId, standing = standingPolicy(exec)) => ctx.aicraft.contextForAgent(workspaceId, exec.agent, exec.callId, standing);
	/**
	* Check the original workspace and obtain any required one-operation write approval.
	*/
	const authorizeWrite = async (exec, name, standing) => {
		exec.signal.throwIfAborted();
		if (resolve(standing.workspaceRoot) !== resolve(exec.agent.session.header.cwd)) throw new Error("AICraft project must match the session workspace");
		if (standing.mode === "read-only") await approveEscalation({
			requestedMode: "workspace-write",
			effectiveMode: standing.mode,
			justification: `${name} changes AICraft data in the current project.`,
			subject: "AICraft operation"
		}, {
			approver: ctx.get("approval"),
			agent: exec.agent,
			callId: exec.callId,
			toolName: name,
			signal: exec.signal
		});
		else if (standing.mode !== "workspace-write" && standing.mode !== "danger-full-access") throw new Error("Unknown DSH sandbox permission mode");
		exec.signal.throwIfAborted();
	};
	/**
	* Apply trusted caller context and write authorization before invoking a shared mutation.
	* Agent calls authorize the project-scoped write capability before entering shared UI operations.
	*/
	const mutate = async (exec, name, call) => {
		exec.signal.throwIfAborted();
		const workspaceId = workspace(exec), standing = standingPolicy(exec);
		const context = callContext(exec, workspaceId, standing);
		await authorizeWrite(exec, name, standing);
		return JSON.stringify(await call(workspaceId, standing, context));
	};
	/**
	* Read caller-specific help from the actual registry definitions.
	*/
	register(defineTool({
		name: "aicraft_help",
		description: "Read the AICraft framework description and other AICraft commands available to this agent. Independent of tasks and assignments; read-only, without starting or continuing work.",
		parameters: {},
		output,
		/**
		* Read the actual caller catalog without task work or write authority.
		*/
		async execute(_args, exec) {
			exec.signal.throwIfAborted();
			const context = callContext(exec, workspace(exec));
			return compactAgentResult(await ctx.aicraft.helpForAgent(context, (agent) => ctx.tools.schemas(agent).flatMap((schema) => {
				const definition = ctx.tools.get(schema.name, agent);
				const description = definition && own.get(definition);
				return schema.name !== "aicraft_help" && description !== void 0 ? [{
					...schema,
					description
				}] : [];
			}), exec.signal), (value) => value);
		}
	}));
	/**
	* Read the open task ID and its ordered stages in this conversation's project.
	*/
	register(defineTool({
		name: "aicraft_project",
		description: "Read the open task ID and its ordered stages in this conversation's project. Use this command as the authoritative source of the current task's route and stage states. Shared process templates are for creating new tasks and do not describe an existing task's current state. Returns openTaskId and every stage in saved process order, each with only id, a short English description, and status: pending (waiting), current (selected for work), done (accepted completion), skipped (skipped), or cancelled (cancelled). Stage status is separate from operationStatus and executor state; finishing an executor does not accept a stage. Returns the full route even without a current stage. If no task is open, returns openTaskId=null and steps=[]. Known read failures return rejected/problem without a successful value. Each call reads fresh data without changing files, preparing assignments, starting or continuing work. Does not return task history or execution details.",
		parameters: {},
		output,
		/**
		* Return the shared reader result for the caller original project.
		*/
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const context = callContext(exec, workspace(exec));
			return compactAgentResult(await ctx.aicraft.projectForAgent(context, exec.signal), (value) => value);
		}
	}));
	/**
	* Read the current stage of the open task in this conversation's project.
	*/
	register(defineTool({
		name: "aicraft_step",
		description: "Read the current stage of the open task in this conversation's project. Returns its stage ID, or null only when the single valid open task has no current stage. Does not substitute the last completed stage. If there is no open task, several open tasks, invalid state, or unavailable state, returns operationStatus=rejected with the concrete reason; these cases are not a successful null result.",
		parameters: {},
		output,
		/**
		* Return only the actual current stage from the shared task reader.
		*/
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const context = callContext(exec, workspace(exec));
			return compactAgentResult(await ctx.aicraft.stepForAgent(context, exec.signal), (value) => value);
		}
	}));
	/**
	* Change stages of the current task.
	*/
	register(defineTool({
		name: "aicraft_move_step",
		description: "Change stages of the current task. complete accepts the current stage; skip marks it skipped; both select the next pending stage. goto selects targetStep and preserves other outcomes. return selects an earlier targetStep and resets later ordinary stages to pending, preserving other skipped and cancelled stages. expectedStep must match the actual current stage; null is allowed only for goto when no stage is current. targetStep is required only for goto and return; use an ID from aicraft_project.steps. Returns the new current stage ID or null. Does not close the task.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"complete",
					"skip",
					"goto",
					"return"
				],
				required: true
			},
			expectedStep: {
				oneOf: [{ type: "string" }, { type: "null" }],
				required: true
			},
			targetStep: { type: "string" }
		},
		output,
		/**
		* Authorize one guarded transition and select its publication-time current stage.
		*/
		async execute(args, exec) {
			return mutate(exec, "aicraft_move_step", async (_id, _standing, context) => JSON.parse(compactAgentResult(await ctx.aicraft.moveStepForAgent(context, args.action, args.expectedStep, args.targetStep, exec.signal), (value) => value.stepStates.find((step) => step.status === "current")?.id ?? null)));
		}
	}));
	/**
	* Close the current open task in this conversation's project.
	*/
	register(defineTool({
		name: "aicraft_close_task",
		description: "Close the current open task in this conversation's project. Preserve materials, execution links and conversations. Returns confirmed only after the change is established; no task or stage details are returned.",
		parameters: {},
		output,
		/**
		* Authorize closure of the selected open task and return its bare confirmation.
		*/
		async execute(args, exec) {
			return mutate(exec, "aicraft_close_task", async (_id, _standing, context) => JSON.parse(compactAgentResult(await ctx.aicraft.closeTaskForAgent(context, exec.signal), () => void 0)));
		}
	}));
	/**
	* Reopen the specified closed task without resetting its stages or materials.
	*/
	register(defineTool({
		name: "aicraft_reopen_task",
		description: "Reopen the specified closed task without resetting its stages or materials. Use the task ID retained from the earlier project response or conversation. Returns confirmed without task or stage details. Does not choose an arbitrary closed task.",
		parameters: { taskId: {
			type: "string",
			required: true
		} },
		output,
		/**
		* Authorize reopening the explicit saved task without changing its stage data.
		*/
		async execute(args, exec) {
			return mutate(exec, "aicraft_reopen_task", async (_id, _standing, context) => JSON.parse(compactAgentResult(await ctx.aicraft.changeTask(context, args.taskId, "reopen", null, exec.signal), () => void 0)));
		}
	}));
	/**
	* Check one execution of the current task without starting work.
	*/
	register(defineTool({
		name: "aicraft_check_run",
		description: "Check one execution of the current task without starting work. Supply exactly one identifier: runId returned by aicraft_start_step, or the attemptId supplied before that start if its reply was lost. Returns runId (saved execution ID), stepId (its task stage), sessionId (its executor conversation), initialAssignmentStatus (completed, failed, interrupted, or unknown for the initial assignment), and conversationActivity (active, inactive, or unknown now). initialAssignmentError is the exact known reason only for a confirmed failed initial assignment; otherwise the field is absent. Later conversation activity changes neither the initial assignment status nor its error. A successful read returns operationStatus=confirmed even when the assignment failed; an unavailable read returns unknown with its concrete problem. After a native DSH failure notification, explicitly call aicraft_check_run to obtain the reason; the same check works if the notification was lost. No automatic polling or custom notifications are added. Inactive does not mean successful completion. No result content, events, or full run record are returned.",
		parameters: {
			runId: { type: "string" },
			attemptId: { type: "string" }
		},
		output,
		/**
		* Select the original attempt and expose only its short observation.
		*/
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const context = callContext(exec, workspace(exec));
			return compactAgentResult(await ctx.aicraft.checkRunForAgent(context, args.runId, args.attemptId, exec.signal), compactRunObservation);
		}
	}));
	/**
	* Start the current stage with the plugin's exact saved assignment and assigned model in a fresh executor conversation.
	*/
	register(defineTool({
		name: "aicraft_start_step",
		description: "Start the current stage with the plugin's exact saved assignment and assigned model in a fresh executor conversation. expectedStep must match the actual current stage. Choose attemptId before the call: 1–128 letters, digits, underscores or hyphens, unique for a new intended attempt within this task. Keep that ID if the reply is lost; it identifies the original attempt and must not be replaced to retry uncertain work. Returns runId and sessionId after the launch is accepted, before completion. DSH normally sends the executor's final text or failure notice to the original calling conversation through native subagent notifications. A notification may resume that same conversation in a later turn; keeping this turn open is unnecessary. When blocked only on the executor, end this turn with a brief waiting update and continue on the notification. Do not use sleep or polling loops. Use aicraft_check_run for an explicit check of the original run if delivery is unavailable or its outcome is uncertain. Inspect the delivered result before separately accepting the stage. Does not accept or advance the stage.",
		parameters: {
			expectedStep: {
				type: "string",
				required: true
			},
			attemptId: {
				type: "string",
				required: true
			}
		},
		output,
		/**
		* Authorize the original guarded launch while preserving standing child permissions.
		*/
		async execute(args, exec) {
			return mutate(exec, "aicraft_start_step", async (_id, _standing, context) => JSON.parse(compactAgentResult(await ctx.aicraft.startStepForAgent(context, args.expectedStep, args.attemptId, exec.signal), (value) => ({
				runId: value.link.id,
				sessionId: value.link.sessionId
			}))));
		}
	}));
}
//#endregion
//#region .build/host/ui-message.js
/**
* Attach presentation metadata at the point that establishes the reason, retaining the original error.
*/
function withUiMessage(value, uiMessage) {
	return Object.assign(value, { uiMessage });
}
/**
* Check owned keys and parameter names while keeping the wire descriptor open to future keys.
*/
function ownMessage(message) {
	return message;
}
/**
* Read explicit metadata through causal wrappers, without interpreting diagnostic prose.
*/
function messageOf(value) {
	const seen = /* @__PURE__ */ new Set();
	let current = value;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const item = current;
		if (item.uiMessage) return item.uiMessage;
		if (item.details?.uiMessage) return item.details.uiMessage;
		current = item.cause;
	}
}
/**
* Preserve an external diagnostic unchanged under a concrete localized explanation.
*/
function externalMessage(key, error) {
	return {
		key,
		details: [error instanceof Error ? error.message : String(error)]
	};
}
//#endregion
//#region .build/host/dsh-integration/diagnostics.js
/**
* FILE: plugin/src/dsh-integration/diagnostics.ts
* DESCRIPTION: Carry operation context and publish diagnostic facts without changing business outcomes
*/
const storage = new AsyncLocalStorage();
const observers = /* @__PURE__ */ new Set();
const rejectedErrors = /* @__PURE__ */ new WeakSet();
const processInstance = randomUUID();
const accepted = /* @__PURE__ */ new WeakSet();
/**
* START_METHOD_diagnosticContext
* Run one action with an isolated causal context; child operations share its sequence.
*/
function diagnosticContext(context, execute) {
	const parent = storage.getStore();
	const value = {
		...parent,
		...context,
		correlationId: context.correlationId ?? parent?.correlationId ?? randomUUID(),
		sequence: context.sequence ?? parent?.sequence ?? { value: 0 }
	};
	return storage.run(value, execute);
}
/**
* START_METHOD_observeDiagnostics
* Subscribe before an action; disposal prevents further delivery to this observer.
*/
function observeDiagnostics(observe) {
	observers.add(observe);
	return () => {
		observers.delete(observe);
	};
}
/**
* START_METHOD_diagnosticEvent
* Publish a boundary fact with source and causal identity, never a criterion verdict.
*/
function diagnosticEvent(type, data = {}, source) {
	const context = storage.getStore();
	if (!context || !observers.size) return;
	const { sequence, ...identity } = context;
	const event = {
		schemaVersion: 2,
		producer: "aicraft.server",
		instanceId: `${processInstance}:${context.correlationId}`,
		seq: ++sequence.value,
		...identity,
		type,
		source: source ?? context.source ?? { path: "src/dsh-integration/diagnostics.ts" },
		data
	};
	for (const observer of observers) try {
		observer(event);
	} catch {}
}
/**
* START_METHOD_diagnosticRejection
* Mark an existing domain refusal without replacing its error identity or stack.
*/
function diagnosticRejection(error) {
	if (typeof error === "object" && error !== null) rejectedErrors.add(error);
	return error;
}
/**
* START_METHOD_diagnosticAccepted
* Record validated inputs at their actual acceptance boundary.
*/
function diagnosticAccepted(data = {}) {
	const context = storage.getStore();
	if (context) {
		for (const key of [
			"runId",
			"sessionId",
			"taskId",
			"stepId",
			"workspaceId"
		]) if (typeof data[key] === "string") context[key] = data[key];
	}
	if (context && !accepted.has(context)) {
		accepted.add(context);
		diagnosticEvent("input.accepted", {
			fields: Object.keys(data),
			encoding: "json-v1",
			sha256: createHash("sha256").update(JSON.stringify(data)).digest("hex")
		});
	}
}
/**
* START_METHOD_diagnosticCommitted
* Record publication after a successful write or rename, excluding staging files.
*/
function diagnosticCommitted(data = {}) {
	diagnosticEvent("persistence.committed", data);
}
/**
* Retain native error stacks and causes in the existing diagnostic format.
*/
function diagnosticFailure(error, seen = /* @__PURE__ */ new WeakSet()) {
	if (!(error instanceof Error)) return {
		name: typeof error,
		message: String(error)
	};
	if (seen.has(error)) return {
		name: error.name,
		circularCause: true
	};
	seen.add(error);
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		..."code" in error && typeof error.code === "string" ? { code: error.code } : {},
		...error.cause === void 0 ? {} : { cause: diagnosticFailure(error.cause, seen) }
	};
}
function finishError(error) {
	const code = error?.code;
	const cancelled = error?.name === "AbortError" || code === "FS_ABORTED";
	const rejected = typeof error === "object" && error !== null && (rejectedErrors.has(error) || error.name === "ZodError" || [
		"FS_STALE_VERSION",
		"FS_NOT_OBSERVED",
		"FS_NOT_TEXT",
		"FS_TOO_LARGE"
	].includes(code ?? ""));
	diagnosticEvent(cancelled ? "operation.cancelled" : rejected ? "operation.rejected" : "operation.failed", { error: diagnosticFailure(error) });
}
/**
* START_METHOD_diagnosticOperation
* Observe a real operation, preserving its exact result and thrown error.
*/
async function diagnosticOperation(source, identity, execute) {
	const parent = storage.getStore();
	if (!parent && !observers.size) return execute();
	return diagnosticContext({
		...identity,
		source,
		operationId: randomUUID(),
		parentOperationId: parent?.operationId
	}, async () => {
		diagnosticEvent("operation.started");
		try {
			const result = await execute();
			diagnosticAccepted();
			diagnosticEvent("operation.completed");
			return result;
		} catch (error) {
			try {
				finishError(error);
			} catch {}
			throw error;
		}
	});
}
/**
* START_METHOD_diagnosticStream
* Keep stream operations in their originating context across next, return and cancellation.
*/
async function* diagnosticStream(source, identity, create) {
	const parent = storage.getStore();
	if (!parent && !observers.size) {
		yield* create();
		return;
	}
	const context = {
		correlationId: parent?.correlationId ?? randomUUID(),
		sequence: parent?.sequence ?? { value: 0 },
		...identity,
		source,
		operationId: randomUUID(),
		parentOperationId: parent?.operationId
	};
	let iterator;
	let ended = false;
	try {
		iterator = diagnosticContext(context, () => {
			diagnosticEvent("operation.started");
			diagnosticAccepted();
			return create()[Symbol.asyncIterator]();
		});
		while (true) {
			const item = await diagnosticContext(context, () => iterator.next());
			if (item.done) break;
			yield item.value;
		}
		diagnosticContext(context, () => diagnosticEvent("operation.completed"));
		ended = true;
	} catch (error) {
		try {
			diagnosticContext(context, () => finishError(error));
		} catch {}
		ended = true;
		throw error;
	} finally {
		if (iterator?.return) await diagnosticContext(context, () => iterator.return());
		if (!ended) diagnosticContext(context, () => diagnosticEvent("operation.cancelled", { reason: "consumer closed stream" }));
	}
}
/**
* START_METHOD_diagnosticPublication
* Observe successful publication at an actual filesystem mutation, never at staging writes.
*/
async function diagnosticPublication(execute, target, kind) {
	diagnosticAccepted({ kind });
	const result = await execute();
	const path = typeof target === "string" ? target : String(target?.displayPath ?? "");
	if (!/(?:^|[\\/])tasks[\\/]\.creating-[^\\/]+(?:[\\/]|$)/.test(path)) diagnosticCommitted({
		path,
		kind
	});
	return result;
}
//#endregion
//#region .build/host/step-execution/application/observe-run.js
/**
* FILE: plugin/src/step-execution/application/observe-run.ts
* DESCRIPTION: Read one original attempt without dispatch, recovery writes or polling
*/
/**
* Only an explicitly established refusal can be reported as rejected.
*/
var OperationRefusal = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
	}
};
/**
* A preparation-side write may have happened even though no Run was registered.
*/
var OperationUncertainty = class extends Error {
	verification;
	constructor(message, verification, options) {
		super(message, options);
		this.verification = verification;
	}
};
/**
* Keep the typed problem, original cause and call identity in the common operation result.
*/
function operationProblem(context, error) {
	const cause = error instanceof Error ? error.cause : void 0;
	return {
		code: error instanceof OperationRefusal ? error.code : "outcome-unknown",
		message: error instanceof Error ? error.message : String(error),
		correlationId: context.callId,
		...messageOf(error) ? { uiMessage: messageOf(error) } : {},
		...cause === void 0 ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }
	};
}
function verification(context, taskId, selector) {
	return {
		workspaceId: context.workspaceId,
		taskId,
		...selector,
		operation: "run"
	};
}
/**
* Select exactly one original run or attempt without substituting a later execution.
*/
async function findRun(store, context, taskId, selector, signal) {
	if (Boolean(selector.runId) === Boolean(selector.attemptId)) throw withUiMessage(new OperationRefusal("invalid-input", "Specify exactly one runId or attemptId"), ownMessage({ key: "reasonSpecifyExactlyOneRunIdOrAttemptId" }));
	return (await store.read(context, taskId, signal)).find((run) => selector.runId !== void 0 ? run.id === selector.runId : run.attemptId === selector.attemptId);
}
/**
* Reject foreign message addresses before touching their conversation sources.
*/
function assertConversation(run, sessionId) {
	if (sessionId !== run.sessionId && sessionId !== run.callerSessionId) throw withUiMessage(new OperationRefusal("access-denied", "The conversation is not linked to this run"), ownMessage({ key: "reasonTheConversationIsNotLinkedToThisRun" }));
}
/** Resolve the original run or attempt and delegate its observation to the conversation reader.
*/
async function observeRun(store, reader, context, taskId, selector, signal, expectedWorkspaceId, messageRef) {
	let lastConfirmedState;
	try {
		if (expectedWorkspaceId !== void 0 && expectedWorkspaceId !== context.workspaceId) throw withUiMessage(new OperationRefusal("state-conflict", "The session project differs from the original workspace"), ownMessage({ key: "reasonTheSessionProjectDiffersFromTheOriginalWorkspace" }));
		const run = await findRun(store, context, taskId, selector, signal);
		if (!run) return {
			operationStatus: "unknown",
			problem: operationProblem(context, withUiMessage(/* @__PURE__ */ new Error("The original attempt is not recorded at this read boundary"), ownMessage({ key: "reasonTheOriginalAttemptIsNotRecordedAtThisReadBoundary" }))),
			verification: {
				...verification(context, taskId, selector),
				workspaceId: expectedWorkspaceId ?? context.workspaceId
			}
		};
		const publishedLink = run.dispatch === void 0 || run.dispatch.phase === "accepted";
		lastConfirmedState = {
			taskId,
			runId: run.id,
			...run.attemptId ? { attemptId: run.attemptId } : {},
			...publishedLink ? {
				stepId: run.stepId,
				sessionId: run.sessionId,
				initialAssignmentStatus: "unknown",
				conversationActivity: "unknown"
			} : {}
		};
		if (messageRef) assertConversation(run, messageRef.sessionId);
		return {
			operationStatus: "confirmed",
			value: await reader.observe(context, run, signal, messageRef)
		};
	} catch (error) {
		const problem = operationProblem(context, error);
		return error instanceof OperationRefusal ? {
			operationStatus: "rejected",
			problem
		} : {
			operationStatus: "unknown",
			problem,
			verification: {
				...verification(context, taskId, selector),
				workspaceId: expectedWorkspaceId ?? context.workspaceId
			},
			...lastConfirmedState === void 0 ? {} : { lastConfirmedState }
		};
	}
}
//#endregion
//#region .build/host/dsh-integration/operation-result.js
/**
* FILE: plugin/src/dsh-integration/operation-result.ts
* DESCRIPTION: Adapt owner-reported publication boundaries to the common Remote and tool result
*/
/**
* Preserve confirmation independently of errors during later refresh or lock release.
*/
async function mutationResult(context, verification, perform) {
	let submitted = false;
	let lastConfirmedState;
	let confirmation;
	try {
		await perform({
			submitting() {
				submitted = true;
			},
			confirmed(value) {
				confirmation = { value };
			},
			lastConfirmed(value) {
				lastConfirmedState = value;
			}
		});
		if (!confirmation) throw withUiMessage(/* @__PURE__ */ new Error("The operation returned without publication confirmation"), ownMessage({ key: "reasonTheOperationReturnedWithoutPublicationConfirmation" }));
		return {
			operationStatus: "confirmed",
			value: confirmation.value
		};
	} catch (error) {
		const problem = operationProblem(context, error);
		if (confirmation) return {
			operationStatus: "confirmed",
			value: confirmation.value,
			refreshIssue: problem
		};
		if (error !== null && typeof error === "object" && "code" in error && ["FS_STALE_VERSION", "FS_NOT_OBSERVED"].includes(String(error.code))) return {
			operationStatus: "rejected",
			problem: {
				...problem,
				code: "version-conflict"
			}
		};
		if (error instanceof OperationRefusal) return {
			operationStatus: "rejected",
			problem
		};
		if (error !== null && typeof error === "object" && "code" in error && ["FS_PERMISSION_DENIED", "FS_SANDBOX_DENIED"].includes(String(error.code))) return {
			operationStatus: "rejected",
			problem: {
				...problem,
				code: "access-denied"
			}
		};
		if (!submitted) return {
			operationStatus: "rejected",
			problem: {
				...problem,
				code: error instanceof OperationRefusal ? error.code : "dependency-unavailable"
			}
		};
		return {
			operationStatus: "unknown",
			problem: {
				...problem,
				code: "outcome-unknown"
			},
			verification,
			...lastConfirmedState === void 0 ? {} : { lastConfirmedState }
		};
	}
}
/**
* Read-only failures cannot be successful empty reads or mutation confirmations.
*/
async function readResult(context, read) {
	try {
		return {
			operationStatus: "confirmed",
			value: await read()
		};
	} catch (error) {
		return {
			operationStatus: "rejected",
			problem: {
				...operationProblem(context, error),
				code: error instanceof OperationRefusal ? error.code : "dependency-unavailable"
			}
		};
	}
}
//#endregion
//#region .build/host/validation.js
/**
* FILE: plugin/src/validation.ts
* DESCRIPTION: Retain schema diagnostics and describe the violated constraint structurally
*/
/**
* Validate at the owner's boundary; custom constraints supply their own descriptors in issue params.
*/
function validate(schema, input) {
	try {
		return schema.parse(input);
	} catch (error) {
		if (!(error instanceof z.ZodError)) throw error;
		const issue = error.issues[0];
		const field = issue?.path.join(".") || "value";
		let uiMessage;
		if (issue?.code === "custom" && issue.params?.uiMessage) uiMessage = issue.params.uiMessage;
		else if (issue?.code === "too_small") uiMessage = {
			key: "validationMinimum",
			params: {
				field,
				minimum: String(issue.minimum)
			}
		};
		else if (issue?.code === "too_big") uiMessage = {
			key: "validationMaximum",
			params: {
				field,
				maximum: String(issue.maximum)
			}
		};
		else if (issue?.code === "invalid_format") uiMessage = {
			key: "validationFormat",
			params: {
				field,
				format: "pattern" in issue ? String(issue.pattern) : issue.format
			}
		};
		else if (issue?.code === "invalid_value") uiMessage = {
			key: "validationChoice",
			params: {
				field,
				values: issue.values.map(String).join(", ")
			}
		};
		else if (issue?.code === "invalid_type") uiMessage = {
			key: "validationType",
			params: {
				field,
				expected: issue.expected
			}
		};
		else uiMessage = {
			key: "validationField",
			params: { field }
		};
		throw withUiMessage(error, {
			...uiMessage,
			details: [error.message]
		});
	}
}
//#endregion
//#region .build/host/work-materials/artifact-files.js
/**
* FILE: plugin/src/work-materials/artifact-files.ts
* DESCRIPTION: Resolve contained paths and scan bounded material trees
*/
const MAX_FILES = 500;
/** Internal knowledge selection shared by discovery and the watch snapshot.
*/
const KNOWLEDGE_ROOT = ".aicraft/knowledge-base";
/**
* Recognize ordinary Markdown files for knowledge selection.
*/
function isKnowledgeFile(name, type) {
	return /\.md$/i.test(name) && type === "file";
}
/**
* START_METHOD_targetFor
* Resolve only AICraft materials inside the registered project, including link targets.
*/
async function targetFor(fs, cwd, path, signal) {
	if (!path.startsWith(".aicraft/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === ".")) throw diagnosticRejection(withUiMessage(new OperationRefusal("access-denied", "Artifact path must be inside .aicraft"), ownMessage({ key: "reasonArtifactPathMustBeInsideAicraft" })));
	const root = await fs.resolve(cwd, { signal });
	const target = await fs.resolve(path, {
		cwd,
		signal
	});
	if (!fs.contains(root, target)) throw diagnosticRejection(withUiMessage(new OperationRefusal("access-denied", "Artifact is outside the selected project"), ownMessage({ key: "reasonArtifactIsOutsideTheSelectedProject" })));
	const aicraft = await fs.resolve(".aicraft", {
		cwd,
		signal
	});
	if (!fs.contains(root, aicraft) || !fs.contains(aicraft, target)) throw diagnosticRejection(withUiMessage(new OperationRefusal("access-denied", "Artifact is outside .aicraft"), ownMessage({ key: "reasonArtifactIsOutsideAicraft" })));
	return target;
}
/** Share bounded discovery: shallow knowledge selection, recursive stage materials.
* Native DSH list failures propagate before selection.
*/
function createArtifactScanner(fs, cwd, signal, maxFiles = MAX_FILES, firstOnly = false) {
	let count = 0;
	const scan = async (path, depth = 0) => {
		signal.throwIfAborted();
		if (depth > 20) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Artifact directory nesting is too deep"), ownMessage({ key: "reasonArtifactDirectoryNestingIsTooDeep" })));
		const info = await fs.lstat(path, { cwd }, signal);
		if (!info || info.type === "symlink" || info.type === "other") return [];
		const target = await targetFor(fs, cwd, path, signal);
		if (path === ".aicraft/knowledge-base") {
			if (info.type !== "directory") return [];
			const files = [];
			for (const entry of await fs.listDir(target, signal)) {
				const child = `${path}/${entry.name}`;
				const metadata = await fs.lstat(child, { cwd }, signal);
				if (!isKnowledgeFile(entry.name, metadata?.type)) continue;
				await targetFor(fs, cwd, child, signal);
				if (++count > maxFiles) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Too many artifacts to display (limit: 500 files)"), ownMessage({ key: "reasonTooManyArtifactsToDisplayLimit500Files" })));
				files.push(child);
				if (firstOnly) return files;
			}
			return files.sort((a, b) => a.localeCompare(b));
		}
		if (info.type === "file") {
			if (++count > maxFiles) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Too many artifacts to display (limit: 500 files)"), ownMessage({ key: "reasonTooManyArtifactsToDisplayLimit500Files" })));
			return [path];
		}
		const files = [];
		for (const entry of await fs.listDir(target, signal)) {
			if (entry.name === ".git" || entry.name === ".gitkeep" || entry.name.startsWith(".creating-")) continue;
			const child = `${path}/${entry.name}`;
			if ((await fs.lstat(child, { cwd }, signal))?.type === "symlink") continue;
			files.push(...await scan(child, depth + 1));
			if (firstOnly && files.length) return files;
		}
		return files.sort((a, b) => a.localeCompare(b));
	};
	return scan;
}
/**
* START_METHOD_artifactSummary
* Artifact discovery failures must not invalidate otherwise valid task state.
*/
async function artifactSummary(fs, cwd, path, signal) {
	try {
		return {
			artifactCount: (await createArtifactScanner(fs, cwd, signal, Infinity)(path)).length,
			artifactIssue: null
		};
	} catch (error) {
		signal.throwIfAborted();
		return {
			artifactCount: null,
			artifactIssue: error instanceof Error ? error.message : String(error),
			artifactIssueMessage: messageOf(error) ?? externalMessage("materialsReadFailed", error)
		};
	}
}
/**
* START_METHOD_hasKnowledgeMaterials
* Detect a first usable knowledge material without loading the corpus.
*/
async function hasKnowledgeMaterials(fs, cwd, signal) {
	return (await createArtifactScanner(fs, cwd, signal, Infinity, true)(KNOWLEDGE_ROOT)).length > 0;
}
//#endregion
//#region .build/host/step-execution/schemas.js
/**
* FILE: plugin/src/step-execution/schemas.ts
* DESCRIPTION: Validate the owning module data and inputs
*/
const uiMessageSchema = z.object({
	key: z.string(),
	params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
	details: z.array(z.string()).optional()
}).transform((value) => value);
/**
* Validate the caller-supplied attempt identifier before lookup or publication.
*/
const attemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/**
* Explicit process assignment, resolved through DSH's provider registry.
*/
const modelAssignmentSchema = z.object({
	provider: z.string().trim().min(1),
	model: z.string().trim().min(1),
	reasoningEffort: z.string().trim().min(1).nullable().default(null)
});
/**
* Durable execution records; old task files may have no runs yet.
*/
const runSchema = z.object({
	id: z.string(),
	stepId: z.string(),
	sessionId: z.string(),
	status: z.enum([
		"starting",
		"running",
		"completed",
		"failed",
		"interrupted"
	]),
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
	outputPath: z.string(),
	model: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().nullable()
	}),
	error: z.string().nullable(),
	errorMessage: uiMessageSchema.optional(),
	taskId: z.string().optional(),
	attemptId: attemptIdSchema.optional(),
	callerSessionId: z.string().nullable().optional(),
	request: z.object({
		stepId: z.string(),
		modelOverride: z.object({
			provider: z.string(),
			model: z.string(),
			reasoningEffort: z.string().nullable()
		}).nullable()
	}).optional(),
	dispatch: z.object({
		phase: z.enum([
			"registered",
			"submitting",
			"accepted",
			"rejected"
		]),
		messageId: z.string().nullable(),
		reason: z.string().nullable(),
		reasonMessage: uiMessageSchema.optional()
	}).optional(),
	initialTurn: z.object({
		turn: z.number().int().nonnegative().nullable(),
		messageId: z.string().nullable()
	}).optional(),
	promptVersion: z.string().optional(),
	promptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	executionBackend: z.object({
		kind: z.enum(["standalone", "spawn-in-process"]),
		providerName: z.string().nullable()
	}).optional()
}).superRefine((run, ctx) => {
	const fields = [
		"taskId",
		"attemptId",
		"callerSessionId",
		"request",
		"dispatch",
		"initialTurn",
		"promptVersion",
		"promptSha256",
		"executionBackend"
	];
	if (fields.some((field) => run[field] !== void 0) && fields.some((field) => run[field] === void 0)) ctx.addIssue({
		code: "custom",
		message: "Attempt records require all durable linkage fields",
		params: { uiMessage: { key: "constraintAttemptRecordsRequireAllDurableLinkageFields" } }
	});
	if (run.request && run.request.stepId !== run.stepId) ctx.addIssue({
		code: "custom",
		message: "Run request must name the saved step",
		params: { uiMessage: { key: "constraintRunRequestMustNameTheSavedStep" } }
	});
	if (run.dispatch?.phase === "accepted" && !run.dispatch.messageId) ctx.addIssue({
		code: "custom",
		message: "Accepted dispatch requires its native message ID",
		params: { uiMessage: { key: "constraintAcceptedDispatchRequiresItsNativeMessageID" } }
	});
	if (run.initialTurn?.messageId != null && run.dispatch?.messageId != null && run.initialTurn.messageId !== run.dispatch.messageId) ctx.addIssue({
		code: "custom",
		message: "Initial native message links must agree",
		params: { uiMessage: { key: "constraintInitialNativeMessageLinksMustAgree" } }
	});
	if (run.executionBackend?.kind === "spawn-in-process" && (!run.callerSessionId || run.executionBackend.providerName !== "spawn")) ctx.addIssue({
		code: "custom",
		message: "Native child execution requires its actual caller and exact spawn backend",
		params: { uiMessage: { key: "constraintNativeChildExecutionRequiresItsActualCallerAndExactSpawnBackend" } }
	});
	if (run.executionBackend?.kind === "standalone" && run.callerSessionId != null) ctx.addIssue({
		code: "custom",
		message: "Standalone panel runs do not acquire a guessed caller",
		params: { uiMessage: { key: "constraintStandalonePanelRunsDoNotAcquireAGuessedCaller" } }
	});
});
//#endregion
//#region .build/host/project-settings/templates.js
/**
* START_METHOD_defaultStepModel
* Explicit initial assignment; never inherits DSH's mutable default selection.
*/
function defaultStepModel() {
	return {
		provider: "deepseek-official",
		model: "deepseek-flash",
		reasoningEffort: null
	};
}
/**
* Share the ordered route and English stage purposes across the two displayed languages.
*/
const steps = [
	[
		"analysis",
		"analyst",
		"Анализ / планирование",
		"Analysis / planning",
		"Analyze the request and plan the work."
	],
	[
		"plan-review",
		"plan-reviewer",
		"Ревьюер плана",
		"Plan review",
		"Review the analysis and implementation plan."
	],
	[
		"development",
		"developer",
		"Разработка",
		"Development",
		"Implement the approved plan."
	],
	[
		"testing",
		"qa",
		"Тестирование",
		"Testing",
		"Test the implementation against the requirements."
	],
	[
		"review",
		"reviewer",
		"Ревью реализации",
		"Implementation review",
		"Review the implementation and its evidence."
	],
	[
		"delivery",
		"release-manager",
		"Подготовка поставки",
		"Delivery preparation",
		"Prepare the accepted result for delivery."
	]
];
/**
* START_METHOD_processTemplate
* Return an editable process copy; bundled templates are never written to the project.
*/
function processTemplate(language) {
	return {
		language,
		name: language === "ru" ? "Новая функциональность" : "New feature",
		steps: steps.map(([id, role, ru, en, description]) => ({
			id,
			title: language === "ru" ? ru : en,
			description,
			role,
			model: defaultStepModel()
		}))
	};
}
const roles = [
	[
		"analyst",
		"Аналитик",
		"Analyst",
		`Подготовь минимальный достаточный анализ и план выполнения задачи.

Исследуй проект с помощью предоставленных инструментов и применимых
навыков. Если специальных инструментов не предусмотрено, используй
файлы исходных кодов проекта. Проверяй только затронутые объекты
и необходимые зависимости. Не придумывай пути, имена и возможности
инструментов.

Выбери самое простое решение, полностью покрывающее требования.
В отчёте укажи:
- решение и причину выбора;
- подтверждённые точки изменения;
- последовательность работ с ожидаемым результатом каждого действия;
- способы проверки;
- существенные вопросы, допущения и риски.

Код и конфигурацию не изменяй.`,
		`Prepare the minimum sufficient analysis and implementation plan.

Inspect the project using the provided tools and applicable skills. If no specialized tools are provided, use the project source files. Check only affected objects and necessary dependencies. Do not invent paths, names or tool capabilities.

Choose the simplest solution that fully covers the requirements. In the report state:
- the solution and why it was chosen;
- confirmed change locations;
- the work sequence and expected result of each action;
- verification methods;
- significant questions, assumptions and risks.

Do not change code or configuration.`
	],
	[
		"plan-reviewer",
		"Ревьюер плана",
		"Plan reviewer",
		`Проверь анализ и план на соответствие постановке, полноту
и выполнимость.

При каждом ревью, включая повторное после исправлений, полностью и
независимо проверь весь согласованный анализ и план текущей версии.
Заново установи обязательства по постановке и правилам проекта
и собери собственные доказательства. Предыдущие результаты, отчёты
и одобрения их не заменяют. Прежние замечания и исправления проверяй
по ходу полного ревью; ими нельзя ограничивать его объём.
Доведи ревью до итогового вывода. Незавершённая работа сама по себе
не является блокером или основанием остановиться. Остановка до
завершения допустима по явной команде пользователя или при реальном
блокере по правилам проекта.

Проверяй факты и зависимости с помощью предоставленных инструментов
и применимых навыков. Если специальных инструментов не предусмотрено,
используй файлы исходных кодов проекта.

Оцени достаточность точек изменения, порядок работ и способы проверки.
Выяви пропуски требований, необоснованные допущения и лишние работы.

В отчёте укажи замечания, их основания и необходимые исправления.
Заверши выводом: план готов к реализации или требует доработки.
Код, конфигурацию и проверяемый план не изменяй.`,
		`Review the analysis and plan for compliance with requirements, completeness and feasibility.

For every review, including after corrections, independently review the entire agreed analysis and plan on the current version. Establish obligations afresh from the requirements and project rules and collect your own evidence. Previous results, reports and approvals do not replace it. Verify earlier findings and corrections during the full review; they must not limit its scope. Carry the review through to a final conclusion. Unfinished work alone is not a blocker or a reason to stop. Stop before completion only on an explicit user instruction or for a real blocker under project rules.

Verify facts and dependencies using the provided tools and applicable skills. If no specialized tools are provided, use the project source files.

Assess change locations, work order and verification methods. Identify missing requirements, unsupported assumptions and unnecessary work.

Report findings, their evidence and required corrections. Conclude whether the plan is ready for implementation or needs revision. Do not change code, configuration or the plan under review.`
	],
	[
		"developer",
		"Разработчик",
		"Developer",
		`Реализуй согласованное изменение по постановке, анализу и результатам
ревью плана.

Код и конфигурацию изменяй с помощью предоставленных инструментов.
Если специальных инструментов не предусмотрено, изменяй файлы
исходных кодов проекта. Применяй предусмотренные проектом навыки
и соблюдай установленный порядок изменения и проверки объектов.

Внеси минимальное полное изменение во все затронутые места.
Не добавляй функции на будущее и сопутствующий рефакторинг.
Выполни необходимые проверки изменённого поведения.

В отчёте укажи:
- что реализовано;
- какие объекты или файлы изменены;
- что проверено и с каким результатом;
- что осталось невыполненным и почему.`,
		`Implement the agreed change using the requirements, analysis and plan review results.

Change code and configuration using the provided tools. If no specialized tools are provided, edit the project source files. Apply project skills and follow its change and verification procedures.

Make the minimum complete change in all affected locations. Do not add future features or unrelated refactoring. Run the necessary checks of the changed behavior.

In the report state:
- what was implemented;
- which objects or files changed;
- what was checked and the results;
- what remains incomplete and why.`
	],
	[
		"qa",
		"QA",
		"QA",
		`Проверь реализацию по постановке, согласованному плану и условиям
приёмки.

Выполняй проверки с помощью предоставленных инструментов и применимых
навыков тестирования. Если специальных инструментов не предусмотрено,
используй доступные средства запуска и проверки проекта. Чтение
исходных кодов не заменяет проверку работающего поведения.

Проверь изменённое поведение, существенные граничные случаи
и затронутые существующие сценарии.

В отчёте укажи выполненные проверки и результаты. Для дефектов приведи
условия воспроизведения, ожидаемое и фактическое поведение.
Отдельно обозначь невыполненные проверки и причины.
Заверши выводом о выполнении условий приёмки.

Код и конфигурацию самостоятельно не исправляй.`,
		`Verify the implementation against requirements, the agreed plan and acceptance criteria.

Perform checks using the provided tools and applicable testing skills. If no specialized tools are provided, use the available project execution and verification facilities. Reading source code does not replace testing running behavior.

Check the changed behavior, significant edge cases and affected existing scenarios.

Report completed checks and results. For defects give reproduction conditions, expected and actual behavior. Identify checks not performed and why. Conclude whether acceptance criteria are met.

Do not fix code or configuration yourself.`
	],
	[
		"reviewer",
		"Ревьюер",
		"Reviewer",
		`Сопоставь реализацию с постановкой, согласованным планом
и правилами проекта.

При каждом ревью, включая повторное после исправлений, полностью и
независимо проверь весь согласованный объём задачи на текущей версии.
Заново установи обязательства по постановке и правилам проекта,
исследуй реализацию и зависимости, выполни необходимые проверки
и оцени их свидетельства. Предыдущие результаты, отчёты и одобрения
не заменяют собственных доказательств. Прежние замечания и исправления
проверяй по ходу полного ревью; ими нельзя ограничивать его объём.
Доведи ревью до итогового вывода. Незавершённая работа сама по себе
не является блокером или основанием остановиться. Остановка до
завершения допустима по явной команде пользователя или при реальном
блокере по правилам проекта.

Исследуй изменения и необходимые зависимости с помощью предоставленных
инструментов и применимых навыков. Если специальных инструментов
не предусмотрено, используй файлы исходных кодов проекта и доступное
сравнение изменений.

Проверь корректность, полноту решения, совместимость
и достаточность проверок. Отделяй подтверждённые дефекты
от предположений и рекомендаций.

В отчёте укажи проблемы в порядке значимости, затронутые объекты
или файлы, последствия и основания замечаний.
Заверши выводом: замечаний нет или требуются исправления.

Код и конфигурацию самостоятельно не исправляй.`,
		`Compare the implementation with requirements, the agreed plan and project rules.

For every review, including after corrections, independently review the entire agreed task scope on the current version. Establish obligations afresh from the requirements and project rules, inspect the implementation and dependencies, perform the necessary checks and assess their evidence. Previous results, reports and approvals do not replace your own evidence. Verify earlier findings and corrections during the full review; they must not limit its scope. Carry the review through to a final conclusion. Unfinished work alone is not a blocker or a reason to stop. Stop before completion only on an explicit user instruction or for a real blocker under project rules.

Inspect changes and necessary dependencies using the provided tools and applicable skills. If no specialized tools are provided, use the project source files and available change comparisons.

Check correctness, completeness, compatibility and verification coverage. Separate confirmed defects from assumptions and recommendations.

Report issues in order of significance, affected objects or files, consequences and supporting evidence. Conclude whether corrections are required.

Do not fix code or configuration yourself.`
	],
	[
		"release-manager",
		"Подготовка поставки",
		"Release manager",
		`Подготовь результат к передаче пользователю.

Обнови необходимую документацию и подготовь предусмотренные процессом
артефакты с помощью предоставленных инструментов и применимых навыков.
Если специальных инструментов не предусмотрено, используй файлы
документации и штатные средства сборки и упаковки проекта.

Проверь соответствие документации выполненным изменениям,
состав артефактов и результаты обязательных проверок.

В отчёте укажи состав поставки, порядок установки или использования,
выполненные проверки, известные ограничения и оставшиеся действия.

Коммиты, отправку изменений и публикацию выполняй только
по отдельному поручению.`,
		`Prepare the result for delivery to the user.

Update necessary documentation and prepare process deliverables using the provided tools and applicable skills. If no specialized tools are provided, use documentation files and standard project build and packaging facilities.

Check that documentation matches the completed changes, the deliverables and mandatory verification results.

Report the delivery contents, installation or usage instructions, completed checks, known limitations and remaining actions.

Create commits, push changes or publish only when separately instructed.`
	]
];
/**
* START_METHOD_templateRoleInstructions
* Initial role instructions; existing project instructions always take precedence.
*/
function templateRoleInstructions(language) {
	return Object.fromEntries(roles.map(([id, ruName, enName, ru, en]) => [id, `${language === "ru" ? ruName : enName}. ${language === "ru" ? ru : en}\n`]));
}
//#endregion
//#region .build/host/project-settings/schemas.js
/**
* FILE: plugin/src/project-settings/schemas.ts
* DESCRIPTION: Validate the owning module data and inputs
*/
/**
* Validate editable process fields while retaining additional route metadata.
*/
const processDraftSchema = z.object({
	language: z.enum(["ru", "en"]).optional(),
	name: z.string().min(1),
	steps: z.array(z.object({
		id: z.string().regex(/^[a-z][a-z0-9-]*$/),
		title: z.string().min(1),
		description: z.string().refine((text) => text.trim().length > 0, { params: { uiMessage: { key: "descriptionRequired" } } }).optional(),
		role: z.string().regex(/^[a-z][a-z0-9-]*$/),
		model: modelAssignmentSchema.nullable().optional().transform((model) => model ?? defaultStepModel())
	}).passthrough())
}).passthrough().superRefine((process, ctx) => {
	const ids = process.steps.map((step) => step.id);
	if (new Set(ids).size !== ids.length) ctx.addIssue({
		code: "custom",
		message: "Process step IDs must be unique",
		params: { uiMessage: { key: "constraintProcessStepIDsMustBeUnique" } }
	});
});
/** Executable task routes must contain at least one step. */
const processSchema = processDraftSchema.refine((process) => process.steps.length > 0, {
	message: "Add at least one step before creating a task.",
	path: ["steps"],
	params: { uiMessage: { key: "constraintAddAtLeastOneStepBeforeCreatingATask" } }
});
//#endregion
//#region .build/host/task-management/schemas.js
/**
* FILE: plugin/src/task-management/schemas.ts
* DESCRIPTION: Validate the owning module data and inputs
*/
/** Agreed task state; process snapshots and executor links live separately. */
const stateSchema = z.object({
	taskType: z.string().trim().min(1),
	taskIdentifier: z.string().trim().min(1),
	taskTitle: z.string().trim().min(1).optional(),
	status: z.enum([
		"open",
		"completed",
		"cancelled"
	]),
	updatedAt: z.iso.datetime().optional(),
	createdBranch: z.string().optional(),
	stepStates: z.array(z.object({
		id: z.string().min(1),
		status: z.enum([
			"done",
			"current",
			"pending",
			"skipped",
			"cancelled"
		])
	})).min(1)
}).strict().superRefine((state, ctx) => {
	const ids = state.stepStates.map((step) => step.id);
	if (new Set(ids).size !== ids.length) ctx.addIssue({
		code: "custom",
		message: "Step IDs must be unique",
		params: { uiMessage: { key: "constraintStepIDsMustBeUnique" } }
	});
	if (state.stepStates.filter((step) => step.status === "current").length > 1) ctx.addIssue({
		code: "custom",
		message: "Only one step may be current",
		params: { uiMessage: { key: "constraintOnlyOneStepMayBeCurrent" } }
	});
});
const requestSchema = z.object({
	taskIdentifier: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/, "Task ID must contain 1–128 letters, digits, hyphens or underscores, starting with a letter or digit.").refine((id) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id), {
		message: "This Task ID is reserved by Windows. Choose another ID.",
		params: { uiMessage: { key: "reservedTaskId" } }
	}),
	title: z.string().trim().min(1),
	processId: z.string().regex(/^[a-z][a-z0-9-]*$/),
	requestText: z.string().trim().min(1)
});
//#endregion
//#region .build/host/task-management/state.js
/**
* FILE: plugin/src/task-management/state.ts
* DESCRIPTION: Serialize task state and derive the selected step
*/
/** Resolve selection from saved stage states, falling back to the last completed stage. */
function currentStepOf(state) {
	return state.stepStates.find((step) => step.status === "current")?.id ?? state.stepStates.findLast((step) => step.status === "done")?.id ?? null;
}
/**
* Return only the actual current stage, independently of the panel's last-done selection.
*/
function actualCurrentStep(state) {
	return state.stepStates.find((step) => step.status === "current")?.id ?? null;
}
/**
* Serialize only agreed state fields, updating the plugin write timestamp.
*/
function serializeState(state) {
	const { taskType, taskIdentifier, taskTitle, status, createdBranch, stepStates } = state;
	return JSON.stringify(validate(stateSchema, {
		taskType,
		taskIdentifier,
		taskTitle,
		status,
		createdBranch,
		stepStates,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}), null, 2) + "\n";
}
//#endregion
//#region .build/host/task-management/types.js
/** Shared explanation for a merged branch with more than one open task. */
const AMBIGUOUS_TASKS_MESSAGE = "Only one open task is allowed per branch. Currently:";
//#endregion
//#region .build/host/task-management/queries.js
/**
* FILE: plugin/src/task-management/queries.ts
* DESCRIPTION: Read task data without modifying project files
*/
/**
* START_METHOD_assertProjectWritable
* Recheck under the caller's writer lock; a merged task set is view-only.
*/
async function assertProjectWritable(fs, cwd, signal) {
	return diagnosticOperation({
		path: "src/task-management/queries.ts",
		method: "assertProjectWritable"
	}, { projectPath: cwd }, async () => {
		if ((await readTaskSnapshot(fs, cwd, signal)).kind === "ambiguous") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", AMBIGUOUS_TASKS_MESSAGE), ownMessage({ key: "ambiguousTasks" })));
	});
}
/**
* START_METHOD_readTaskState
* Read task data without writing or migrating project files.
*/
async function readTaskState(fs, cwd, taskId, signal) {
	return diagnosticOperation({
		path: "src/task-management/queries.ts",
		method: "readTaskState"
	}, {
		projectPath: cwd,
		taskId
	}, async () => {
		const read = async (path) => fs.readText(await targetFor(fs, cwd, path, signal), signal);
		const root = `.aicraft/tasks/${taskId}`;
		const state = parseState(await read(`${root}/state.json`));
		if (state.taskIdentifier !== taskId) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "taskIdentifier must match the task directory"), ownMessage({ key: "reasonTaskIdentifierMustMatchTheTaskDirectory" })));
		if (!/^[a-z][a-z0-9-]*$/.test(state.taskType)) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "taskType must name a process file"), ownMessage({ key: "reasonTaskTypeMustNameAProcessFile" })));
		const saved = await fs.stat(await targetFor(fs, cwd, `${root}/process.json`, signal), signal);
		const errors = [];
		const route = parse(await read(saved ? `${root}/process.json` : `.aicraft/config/processes/${state.taskType}.jsonc`), errors, { allowTrailingComma: true });
		if (errors.length) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Task process contains invalid JSONC"), ownMessage({ key: "reasonTaskProcessContainsInvalidJSONC" })));
		let process;
		try {
			process = validate(processSchema, route);
		} catch (error) {
			throw new OperationRefusal("state-conflict", error instanceof Error ? error.message : String(error), { cause: error });
		}
		const ids = process.steps.map((step) => step.id);
		if (state.stepStates.length !== ids.length || state.stepStates.some((step) => !ids.includes(step.id))) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "stepStates must match the process steps"), ownMessage({ key: "reasonStepStatesMustMatchTheProcessSteps" })));
		const title = state.taskTitle ?? ((await read(`${root}/request.md`)).match(/^#\s+(.+)$/m)?.[1]?.trim() || state.taskIdentifier);
		return {
			...state,
			taskTitle: title,
			process,
			title
		};
	});
}
/**
* START_METHOD_readTaskSnapshot
* Read the current task without modifying project files.
* @param fs - DSH filesystem provider.
* @param cwd - Project directory in the provider's execution world.
* @param signal - Caller cancellation.
* @returns A task, an empty project, or explicit invalid/ambiguous state.
*/
async function readTaskSnapshot(fs, cwd, signal, validateHistory = true) {
	return diagnosticOperation({
		path: "src/task-management/queries.ts",
		method: "readTaskSnapshot"
	}, { projectPath: cwd }, async () => {
		const target = await targetFor(fs, cwd, ".aicraft/tasks", signal);
		const info = await fs.stat(target, signal);
		if (!info) return {
			kind: "empty",
			tasks: [],
			allTasks: [],
			issues: []
		};
		if (info.type !== "directory") return {
			kind: "invalid",
			tasks: [],
			allTasks: [],
			issues: [{
				code: "state-conflict",
				message: ".aicraft/tasks must be a directory",
				uiMessage: { key: "taskDirectoryRequired" }
			}]
		};
		const tasks = [];
		const issues = [];
		for (const entry of await fs.listDir(target, signal)) {
			if (entry.type !== "directory" || entry.name.startsWith(".")) continue;
			signal.throwIfAborted();
			const label = `.aicraft/tasks/${entry.name}/state.json`;
			try {
				const state = await readTaskState(fs, cwd, entry.name, signal);
				if (validateHistory) await readRuns(fs, cwd, entry.name, signal);
				const currentStep = currentStepOf(state);
				const steps = await Promise.all(state.process.steps.map(async (step) => ({
					...step,
					model: step.model,
					status: state.stepStates.find((item) => item.id === step.id).status
				})));
				tasks.push({
					id: entry.name,
					title: state.title,
					status: state.status,
					updatedAt: state.updatedAt ?? null,
					processName: state.process.name,
					currentStep,
					createdBranch: state.createdBranch ?? null,
					steps
				});
			} catch (error) {
				signal.throwIfAborted();
				issues.push(taskReadIssue(error, `${label}: `));
			}
		}
		tasks.sort((a, b) => (b.updatedAt ? Date.parse(b.updatedAt) : -Infinity) - (a.updatedAt ? Date.parse(a.updatedAt) : -Infinity) || a.id.localeCompare(b.id));
		if (issues.length) return {
			kind: "invalid",
			tasks: [],
			allTasks: tasks,
			issues
		};
		const open = tasks.filter((task) => task.status === "open");
		return {
			kind: open.length === 0 ? "empty" : open.length === 1 ? "task" : "ambiguous",
			tasks: open,
			allTasks: tasks,
			issues: []
		};
	}).catch((error) => {
		signal.throwIfAborted();
		const issue = taskReadIssue(error);
		throw withUiMessage(new OperationRefusal(issue.code, issue.message, { cause: error }), issue.uiMessage ?? externalMessage("invalidTaskState", error));
	});
}
/**
* Classify invalid saved state at the parser boundary, keeping filesystem failures outside it.
*/
function parseState(text) {
	try {
		return validate(stateSchema, JSON.parse(text));
	} catch (error) {
		throw new OperationRefusal("state-conflict", error instanceof Error ? error.message : String(error), { cause: error });
	}
}
/**
* Classify typed source failures and data-validation failures without parsing exception prose.
*/
function taskReadIssue(error, prefix = "") {
	return {
		code: error instanceof OperationRefusal && ["access-denied", "state-conflict"].includes(error.code) ? error.code : error instanceof SyntaxError || error instanceof z.ZodError ? "state-conflict" : error !== null && typeof error === "object" && "code" in error && ["FS_PERMISSION_DENIED", "FS_SANDBOX_DENIED"].includes(String(error.code)) ? "access-denied" : "dependency-unavailable",
		uiMessage: messageOf(error) ? {
			...messageOf(error),
			details: [prefix, ...messageOf(error)?.details ?? []].filter(Boolean)
		} : externalMessage("invalidTaskState", error),
		message: prefix + (error instanceof Error ? error.message : String(error)),
		cause: error
	};
}
//#endregion
//#region .build/host/step-execution/domain/run-state.js
/**
* FILE: plugin/src/step-execution/domain/run-state.ts
* DESCRIPTION: Apply immutable attempt identity and dispatch knowledge without platform dependencies
*/
const sameModel = (left, right) => left === null || right === null ? left === right : left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
/**
* A retry compares the original explicit request, never the current model or prompt.
*/
function sameAttempt(run, callerSessionId, request) {
	return run.request !== void 0 && run.callerSessionId === callerSessionId && run.request.stepId === request.stepId && sameModel(run.request.modelOverride, request.modelOverride);
}
/**
* Preserve known acceptance and all original links when recording later facts.
*/
function advanceDispatch(run, next) {
	const current = run.dispatch;
	if (!current) throw withUiMessage(/* @__PURE__ */ new Error("Legacy records cannot acquire guessed dispatch facts"), ownMessage({ key: "reasonLegacyRecordsCannotAcquireGuessedDispatchFacts" }));
	if (!{
		registered: [
			"registered",
			"submitting",
			"rejected"
		],
		submitting: [
			"submitting",
			"accepted",
			"rejected"
		],
		accepted: ["accepted"],
		rejected: ["rejected"]
	}[current.phase].includes(next.phase)) throw withUiMessage(/* @__PURE__ */ new Error("Dispatch facts cannot be reversed"), ownMessage({ key: "reasonDispatchFactsCannotBeReversed" }));
	if (current.messageId !== null && current.messageId !== next.messageId) throw withUiMessage(/* @__PURE__ */ new Error("The initial message link is immutable"), ownMessage({ key: "reasonTheInitialMessageLinkIsImmutable" }));
	if (current.reason !== null && current.reason !== next.reason) throw withUiMessage(/* @__PURE__ */ new Error("An established dispatch reason is immutable"), ownMessage({ key: "reasonAnEstablishedDispatchReasonIsImmutable" }));
	if (next.phase === "accepted" && !next.messageId) throw withUiMessage(/* @__PURE__ */ new Error("Acceptance requires the native message identity"), ownMessage({ key: "reasonAcceptanceRequiresTheNativeMessageIdentity" }));
	if (next.phase === "rejected" && !next.reason) throw withUiMessage(/* @__PURE__ */ new Error("Rejection requires an established reason"), ownMessage({ key: "reasonRejectionRequiresAnEstablishedReason" }));
	return {
		...run,
		dispatch: { ...next }
	};
}
/**
* Reject a stale writer attempting to change the original request or saved links.
*/
function assertRunIdentity(previous, next) {
	if ([
		"id",
		"taskId",
		"stepId",
		"sessionId",
		"attemptId",
		"callerSessionId",
		"promptVersion",
		"promptSha256",
		"outputPath",
		"startedAt"
	].some((field) => previous[field] !== next[field]) || !sameModel(previous.model, next.model) || previous.executionBackend?.kind !== next.executionBackend?.kind || previous.executionBackend?.providerName !== next.executionBackend?.providerName || previous.initialTurn?.messageId != null && previous.initialTurn.messageId !== next.initialTurn?.messageId || previous.initialTurn?.turn != null && previous.initialTurn.turn !== next.initialTurn?.turn || (previous.request ? !sameAttempt(next, previous.callerSessionId ?? null, previous.request) : next.request !== void 0)) throw withUiMessage(/* @__PURE__ */ new Error("The original run identity is immutable"), ownMessage({ key: "reasonTheOriginalRunIdentityIsImmutable" }));
}
//#endregion
//#region .build/host/step-execution/history.js
/**
* FILE: plugin/src/step-execution/history.ts
* DESCRIPTION: Read durable executor history independently of task state
*/
/**
* START_METHOD_readRuns
* Executor history is independent of the task state schema.
*/
async function readRuns(fs, cwd, taskId, signal) {
	return diagnosticOperation({
		path: "src/step-execution/history.ts",
		method: "readRuns"
	}, {
		projectPath: cwd,
		taskId
	}, async () => {
		if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw withUiMessage(new OperationRefusal("invalid-input", "Invalid task identifier"), ownMessage({ key: "reasonInvalidTaskIdentifier" }));
		const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/runs.json`, signal);
		const runs = await fs.stat(target, signal) ? validate(z.array(runSchema), JSON.parse(await fs.readText(target, signal))) : [];
		const attempts = /* @__PURE__ */ new Set();
		for (const run of runs) {
			if (run.taskId !== void 0 && run.taskId !== taskId) throw withUiMessage(/* @__PURE__ */ new Error("Executor history belongs to a different task"), ownMessage({ key: "reasonExecutorHistoryBelongsToADifferentTask" }));
			if (run.attemptId !== void 0) {
				if (attempts.has(run.attemptId)) throw withUiMessage(/* @__PURE__ */ new Error("Executor history contains duplicate attempt IDs"), ownMessage({ key: "reasonExecutorHistoryContainsDuplicateAttemptIDs" }));
				attempts.add(run.attemptId);
			}
		}
		return runs;
	});
}
/**
* Persist only established facts under the existing project lock.
*/
function createRunStore(fs, waitMs) {
	return {
		read: (context, taskId, signal) => readRuns(fs, context.projectRoot, taskId, signal),
		/**
		* Hold the existing project lock across attempt lookup and publication; lock release can still fail.
		*/
		transaction: (context, taskId, signal, operation) => diagnosticOperation({ path: "src/step-execution/history.ts" }, {
			workspaceId: context.workspaceId,
			projectPath: context.projectRoot,
			taskId
		}, () => withFileLock(join(context.projectRoot, ".aicraft"), async () => {
			signal.throwIfAborted();
			return operation({
				read: () => readRuns(fs, context.projectRoot, taskId, signal),
				/**
				* Publish validated run facts without changing the original attempt links.
				*/
				async save(run) {
					validate(runSchema, run);
					if (run.taskId !== void 0 && run.taskId !== taskId) throw withUiMessage(/* @__PURE__ */ new Error("The run must belong to the original task"), ownMessage({ key: "reasonTheRunMustBelongToTheOriginalTask" }));
					const target = await targetFor(fs, context.projectRoot, `.aicraft/tasks/${taskId}/runs.json`);
					const info = await fs.stat(target);
					const runs = await readRuns(fs, context.projectRoot, taskId);
					const index = runs.findIndex((item) => item.id === run.id);
					if (index >= 0) {
						assertRunIdentity(runs[index], run);
						if (run.dispatch) advanceDispatch(runs[index], run.dispatch);
						runs[index] = run;
					} else {
						if (run.taskId === void 0) throw withUiMessage(/* @__PURE__ */ new Error("New records require their original task identity"), ownMessage({ key: "reasonNewRecordsRequireTheirOriginalTaskIdentity" }));
						if (runs.some((item) => item.attemptId === run.attemptId)) throw withUiMessage(/* @__PURE__ */ new Error("The original attempt is already registered"), ownMessage({ key: "reasonTheOriginalAttemptIsAlreadyRegistered" }));
						runs.push(run);
					}
					if ((await readTaskSnapshot(fs, context.projectRoot, new AbortController().signal, false)).kind === "ambiguous") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Run history cannot be changed while multiple tasks are open"), ownMessage({ key: "reasonRunHistoryCannotBeChangedWhileMultipleTasksAreOpen" })));
					diagnosticAccepted({
						runId: run.id,
						taskId,
						sessionId: run.sessionId
					});
					const text = JSON.stringify(runs, null, 2) + "\n";
					const prepared = new TextEncoder().encode(text);
					await diagnosticPublication(async () => {
						try {
							await fs.writeText(target, text, info ? {
								kind: "replaceIfVersion",
								version: info.version
							} : { kind: "createIfAbsent" }, void 0, {
								mode: "workspace-write",
								workspaceRoot: context.projectRoot
							});
						} catch (error) {
							if (error !== null && typeof error === "object" && "code" in error) {
								const code = String(error.code);
								if ([
									"FS_STALE_VERSION",
									"FS_NOT_OBSERVED",
									"FS_PERMISSION_DENIED",
									"FS_SANDBOX_DENIED"
								].includes(code)) throw new OperationRefusal(code === "FS_STALE_VERSION" || code === "FS_NOT_OBSERVED" ? "version-conflict" : "access-denied", error instanceof Error ? error.message : String(error), { cause: error });
							}
							try {
								const bytes = await fs.readBytes(target, signal, prepared.length + 1);
								if (bytes.length === prepared.length && bytes.every((byte, index) => byte === prepared[index])) return;
							} catch {}
							throw error;
						}
					}, target, "writeText");
				}
			});
		}, { waitMs }))
	};
}
//#endregion
//#region .build/host/work-materials/materials.js
/**
* FILE: plugin/src/work-materials/materials.ts
* DESCRIPTION: List, read and version-save permitted project documents
*/
const MAX_BYTES = 2 * 1024 * 1024;
/**
* START_METHOD_listMaterials
* List task and project documents without reading their contents or requiring a chat.
*/
async function listMaterials(fs, cwd, taskId, signal) {
	return diagnosticOperation({
		path: "src/work-materials/materials.ts",
		method: "listMaterials"
	}, {
		projectPath: cwd,
		taskId
	}, async () => {
		const groups = [];
		const scan = createArtifactScanner(fs, cwd, signal);
		const group = async (id, title, path, base) => {
			try {
				const files = (await scan(path)).map((path) => ({
					path,
					name: path.slice(base.length + 1)
				}));
				groups.push({
					id,
					title,
					files,
					issue: null,
					...id === "request" ? { titleMessage: { key: "requestGroup" } } : id === "knowledge" ? { titleMessage: { key: "knowledgeGroup" } } : {}
				});
			} catch (error) {
				signal.throwIfAborted();
				groups.push({
					id,
					title,
					files: [],
					issue: error instanceof Error ? error.message : String(error),
					issueMessage: messageOf(error) ?? externalMessage("materialsReadFailed", error),
					...id === "request" ? { titleMessage: { key: "requestGroup" } } : id === "knowledge" ? { titleMessage: { key: "knowledgeGroup" } } : {}
				});
			}
		};
		if (taskId !== null) {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Invalid task identifier"), ownMessage({ key: "reasonInvalidTaskIdentifier" })));
			const base = `.aicraft/tasks/${taskId}`;
			await targetFor(fs, cwd, base, signal);
			for (const name of [
				"state.json",
				"request.md",
				"process.json",
				"runs.json"
			]) await targetFor(fs, cwd, `${base}/${name}`, signal);
			const stateTarget = await targetFor(fs, cwd, `${base}/state.json`, signal);
			const state = validate(stateSchema, JSON.parse(await fs.readText(stateTarget, signal)));
			if (!await fs.stat(await targetFor(fs, cwd, `${base}/process.json`, signal), signal)) await targetFor(fs, cwd, `.aicraft/config/processes/${state.taskType}.jsonc`, signal);
			const task = await readTaskState(fs, cwd, taskId, signal);
			await group("request", "Постановка", `${base}/request.md`, base);
			for (const step of task.process.steps) {
				const prefix = `${base}/${step.id}`;
				await group(`step:${step.id}`, step.title, prefix, prefix);
			}
		}
		await group("knowledge", "Знания проекта", KNOWLEDGE_ROOT, KNOWLEDGE_ROOT);
		return groups;
	});
}
/**
* START_METHOD_readMaterial
* Read bounded UTF-8 content; unsupported or binary files never render as HTML.
*/
async function readMaterial(fs, cwd, path, signal) {
	return diagnosticOperation({
		path: "src/work-materials/materials.ts",
		method: "readMaterial"
	}, { projectPath: cwd }, async () => {
		const target = await targetFor(fs, cwd, path, signal);
		const info = await fs.lstat(path, { cwd }, signal);
		if (info?.type !== "file") throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Artifact must be a regular file"), ownMessage({ key: "reasonArtifactMustBeARegularFile" })));
		if (info.size !== void 0 && info.size > MAX_BYTES) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Artifact is too large (limit: 2 MiB)"), ownMessage({ key: "reasonArtifactIsTooLargeLimit2MiB" })));
		const before = await fs.stat(target, signal);
		if (before?.type !== "file") throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Artifact must be a regular file"), ownMessage({ key: "reasonArtifactMustBeARegularFile" })));
		const bytes = await fs.readBytes(target, signal, MAX_BYTES);
		if ((await fs.stat(target, signal))?.version !== before.version) throw diagnosticRejection(withUiMessage(new OperationRefusal("version-conflict", "The file changed while reading; reload it"), ownMessage({ key: "reasonTheFileChangedWhileReadingReloadIt" })));
		if (bytes.length > MAX_BYTES) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Artifact is too large (limit: 2 MiB)"), ownMessage({ key: "reasonArtifactIsTooLargeLimit2MiB" })));
		let text;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "This file cannot be displayed as UTF-8 text"), ownMessage({ key: "reasonThisFileCannotBeDisplayedAsUTF8Text" })));
		}
		if (text.includes("\0")) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Binary files are not supported by this viewer"), ownMessage({ key: "reasonBinaryFilesAreNotSupportedByThisViewer" })));
		return {
			path,
			text,
			version: before.version,
			format: /\.(md|markdown)$/i.test(path) ? "markdown" : "text"
		};
	});
}
/**
* START_METHOD_saveMaterial
* Save versioned Markdown and reconcile a lost receipt once under the original lock.
*/
async function saveMaterial(fs, cwd, path, text, version, lockWaitMs, signal, progress) {
	return diagnosticOperation({
		path: "src/work-materials/materials.ts",
		method: "saveMaterial"
	}, { projectPath: cwd }, async () => {
		if (!/\.md$/i.test(path)) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Only .md files can be edited"), ownMessage({ key: "reasonOnlyMdFilesCanBeEdited" })));
		if (!version) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "The original file version is required"), ownMessage({ key: "reasonTheOriginalFileVersionIsRequired" })));
		if (text.includes("\0")) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Markdown must not contain NUL bytes"), ownMessage({ key: "reasonMarkdownMustNotContainNULBytes" })));
		const prepared = new TextEncoder().encode(text);
		if (prepared.length > MAX_BYTES) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "Artifact is too large (limit: 2 MiB)"), ownMessage({ key: "reasonArtifactIsTooLargeLimit2MiB" })));
		return withFileLock(join(cwd, ".aicraft"), async () => {
			const target = await targetFor(fs, cwd, path, signal);
			await assertProjectWritable(fs, cwd, signal);
			const current = await fs.lstat(path, { cwd }, signal);
			if (current?.type !== "file") throw diagnosticRejection(withUiMessage(new OperationRefusal(current ? "invalid-input" : "not-found", "Artifact must be an existing regular file"), ownMessage({ key: "reasonArtifactMustBeAnExistingRegularFile" })));
			if (current.version !== version) throw diagnosticRejection(withUiMessage(new OperationRefusal("version-conflict", "The file changed outside the editor. Your changes have not been saved; reload the file to continue."), ownMessage({ key: "reasonTheFileChangedOutsideTheEditorYourChangesHaveNotBeenSavedReloa" })));
			diagnosticAccepted({
				path,
				text,
				version
			});
			progress?.submitting();
			const document = await diagnosticPublication(async () => {
				try {
					return {
						path,
						text,
						version: (await fs.writeText(target, text, {
							kind: "replaceIfVersion",
							version
						}, signal, {
							mode: "workspace-write",
							workspaceRoot: cwd
						})).version,
						format: "markdown"
					};
				} catch (error) {
					if (error !== null && typeof error === "object" && "code" in error && [
						"FS_STALE_VERSION",
						"FS_NOT_OBSERVED",
						"FS_PERMISSION_DENIED",
						"FS_SANDBOX_DENIED"
					].includes(String(error.code))) throw error;
					try {
						signal.throwIfAborted();
						if ((await targetFor(fs, cwd, path, signal)).targetKey !== target.targetKey) throw error;
						if ((await fs.lstat(path, { cwd }, signal))?.type !== "file") throw error;
						const before = await fs.stat(target, signal);
						if (before?.type !== "file" || !before.version || before.size !== void 0 && before.size > MAX_BYTES) throw error;
						const bytes = await fs.readBytes(target, signal, MAX_BYTES);
						const after = await fs.stat(target, signal);
						const finalTarget = await targetFor(fs, cwd, path, signal);
						const finalEntry = await fs.lstat(path, { cwd }, signal);
						signal.throwIfAborted();
						if (after?.type !== "file" || after.version !== before.version || finalTarget.targetKey !== target.targetKey || finalEntry?.type !== "file" || finalEntry.version !== after.version || bytes.length !== prepared.length || !bytes.every((byte, index) => byte === prepared[index])) throw error;
						return {
							path,
							text,
							version: after.version,
							format: "markdown"
						};
					} catch {
						throw error;
					}
				}
			}, target, "writeText");
			progress?.confirmed(document);
			return document;
		}, { waitMs: lockWaitMs });
	});
}
//#endregion
//#region .build/host/execution-accounting/pricing.js
/** Verified snapshots; retain older periods and bump ACCOUNTING_VERSION when prices/rules change. */
const ACCOUNTING_VERSION = 2026101504;
const prices = [{
	provider: "deepseek-official",
	models: [
		"deepseek-flash",
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp"
	],
	from: Date.parse("2026-09-10T04:00:00Z"),
	input: 150,
	cache: 3,
	output: 600
}, {
	provider: "deepseek-official",
	models: ["deepseek-v4-pro"],
	from: Date.parse("2026-08-16T16:00:00Z"),
	input: 660,
	cache: 22,
	output: 1980
}];
const holidays2026 = [
	["01-01", "01-03"],
	["02-15", "02-23"],
	["04-04", "04-06"],
	["05-01", "05-05"],
	["06-19", "06-21"],
	["09-25", "09-27"],
	["10-01", "10-07"]
];
/** Price one request by its actual route and recorded local start, never by today's clock. */
function priceRequest(provider, model, startedAt, usage) {
	if (provider === "lmstudio") return { kind: "local" };
	const price = prices.find((p) => p.provider === provider && p.models.includes(model));
	if (!price || !Number.isFinite(startedAt) || startedAt < price.from || usage.cacheRead === null || usage.cacheWrite !== 0) return { kind: "unknown" };
	const peak = isPeakTime(startedAt);
	if (peak === null) return { kind: "unknown" };
	const multiplier = peak ? 2 : 1;
	const result = {
		kind: "priced",
		uncached: usage.input * price.input * multiplier,
		cache: usage.cacheRead * price.cache * multiplier,
		output: usage.output * price.output * multiplier
	};
	return [
		result.uncached,
		result.cache,
		result.output
	].every(Number.isSafeInteger) ? result : { kind: "unknown" };
}
/** UTC weekday/window rules with the explicitly supplied Chinese holiday calendar. */
function isPeakTime(startedAt) {
	const date = new Date(startedAt), minute = date.getUTCHours() * 60 + date.getUTCMinutes();
	let peak = date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && (minute >= 60 && minute < 240 || minute >= 360 && minute < 600);
	if (peak) {
		const chinaDay = new Date(startedAt + 8 * 36e5).toISOString().slice(0, 10);
		if (!chinaDay.startsWith("2026-")) return null;
		const day = chinaDay.slice(5);
		if (holidays2026.some(([from, to]) => day >= from && day <= to)) peak = false;
	}
	return peak;
}
//#endregion
//#region .build/host/execution-accounting/accounting.js
const count = z.number().int().nonnegative();
const routeSchema = z.object({
	provider: z.string(),
	model: z.string()
});
const totalsSchema = z.object({
	input: count,
	output: count,
	total: count,
	cacheRead: count,
	requests: count,
	unknownUsage: count,
	unknownCache: count,
	unknownPrice: count,
	priced: count,
	local: count,
	uncachedCost: count,
	cacheCost: count,
	outputCost: count
});
const zeroTotals = () => ({
	input: 0,
	output: 0,
	total: 0,
	cacheRead: 0,
	requests: 0,
	unknownUsage: 0,
	unknownCache: 0,
	unknownPrice: 0,
	priced: 0,
	local: 0,
	uncachedCost: 0,
	cacheCost: 0,
	outputCost: 0
});
const usageSchema = z.object({
	inputTokens: count,
	outputTokens: count,
	totalTokens: count.optional(),
	cacheReadTokens: count.optional(),
	cacheWriteTokens: count.optional()
});
const bucketSchema = z.object({
	provider: z.string(),
	model: z.string(),
	period: z.enum([
		"peak",
		"off-peak",
		"unavailable"
	]),
	totals: totalsSchema
});
const attemptSchema = z.object({
	start: count,
	turn: count,
	step: count,
	route: routeSchema.nullable(),
	sample: usageSchema.nullable(),
	charged: totalsSchema.nullable(),
	chargedKey: z.string().nullable()
});
const accountingSchema = z.object({
	boundary: count,
	tracked: z.boolean(),
	route: routeSchema.nullable(),
	totals: totalsSchema,
	buckets: z.array(bucketSchema),
	attempt: attemptSchema.nullable(),
	intervals: z.array(z.tuple([count, count])),
	openSince: count.nullable(),
	children: z.array(z.object({
		id: z.string(),
		local: z.boolean(),
		provider: z.string()
	}))
});
const record = (value) => typeof value === "object" && value !== null ? value : {};
/** Keep missing cache-hit reporting unknown; an exact total still supplies the full input count. */
function contribution(attempt) {
	const result = zeroTotals();
	result.requests = 1;
	const unavailable = () => {
		result.unknownUsage = 1;
		result.unknownCache = 1;
		if (attempt.route?.provider === "lmstudio") result.local = 1;
		else result.unknownPrice = 1;
		return result;
	};
	const u = attempt.sample;
	if (!u) return unavailable();
	let read = u.cacheReadTokens ?? null, write = u.cacheWriteTokens ?? null;
	const prompt = u.totalTokens === void 0 ? null : u.totalTokens - u.outputTokens;
	if (prompt !== null && prompt < u.inputTokens + (read ?? 0) + (write ?? 0)) return unavailable();
	if (prompt !== null && read !== null && write === null && prompt === u.inputTokens + read) write = 0;
	if (prompt !== null && read !== null && write !== null && prompt !== u.inputTokens + read + write) return unavailable();
	result.input = prompt ?? u.inputTokens + (read ?? 0) + (write ?? 0);
	result.output = u.outputTokens;
	result.total = result.input + result.output;
	result.cacheRead = read ?? 0;
	if (prompt === null && (read === null || write === null)) result.unknownUsage = 1;
	if (read === null || prompt === null && write === null) result.unknownCache = 1;
	const price = attempt.route ? priceRequest(attempt.route.provider, attempt.route.model, attempt.start, {
		input: u.inputTokens,
		cacheRead: read,
		cacheWrite: write,
		output: u.outputTokens
	}) : { kind: "unknown" };
	if (price.kind === "local") result.local = 1;
	else if (price.kind === "priced") {
		result.priced = 1;
		result.uncachedCost = price.uncached;
		result.cacheCost = price.cache;
		result.outputCost = price.output;
	} else result.unknownPrice = 1;
	return result;
}
function addTotals(a, b) {
	return Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + b[key]]));
}
function charge(state) {
	if (!state.attempt) return state;
	const next = contribution(state.attempt), previous = state.attempt.charged ?? zeroTotals();
	const totals = Object.fromEntries(Object.keys(next).map((k) => [k, state.totals[k] - previous[k] + next[k]]));
	const route = state.attempt.route ?? {
		provider: "unknown",
		model: "unknown"
	};
	const peak = next.priced ? isPeakTime(state.attempt.start) : null;
	const period = peak === null ? "unavailable" : peak ? "peak" : "off-peak";
	const key = JSON.stringify([
		route.provider,
		route.model,
		period
	]);
	const buckets = state.buckets.map((b) => ({
		...b,
		totals: { ...b.totals }
	}));
	const adjust = (bucketKey, amount, sign) => {
		let bucket = buckets.find((b) => JSON.stringify([
			b.provider,
			b.model,
			b.period
		]) === bucketKey);
		if (!bucket) {
			bucket = {
				...route,
				period,
				totals: zeroTotals()
			};
			buckets.push(bucket);
		}
		for (const k of Object.keys(amount)) bucket.totals[k] += sign * amount[k];
	};
	if (state.attempt.chargedKey) adjust(state.attempt.chargedKey, previous, -1);
	adjust(key, next, 1);
	return {
		...state,
		totals,
		buckets: buckets.filter((b) => b.totals.requests > 0),
		attempt: {
			...state.attempt,
			charged: next,
			chargedKey: key
		}
	};
}
function sampleOf(data) {
	let sample = data.usage;
	if (!sample && Array.isArray(data.stream)) for (const item of data.stream) {
		const chunk = record(record(item).chunk);
		if (chunk.type === "usage") sample = chunk.usage;
	}
	const parsed = usageSchema.safeParse(sample);
	return parsed.success ? parsed.data : null;
}
/** One immutable native DSH projection; fork prefixes contribute routing context only. */
const accountingProjection = {
	key: "aicraftAccounting",
	stateVersion: ACCOUNTING_VERSION,
	stateSchema: accountingSchema,
	init: (_header, boundary) => ({
		boundary,
		tracked: false,
		route: null,
		totals: zeroTotals(),
		buckets: [],
		attempt: null,
		intervals: [],
		openSince: null,
		children: []
	}),
	apply: (state, event) => {
		const data = record(event.data), type = String(event.type);
		if (type === "request/header") {
			const parsed = routeSchema.safeParse(record(data.header).config);
			if (!parsed.success) return state;
			return {
				...state,
				route: parsed.data,
				attempt: state.attempt && !state.attempt.charged ? {
					...state.attempt,
					route: parsed.data
				} : state.attempt
			};
		}
		if (event.seq < state.boundary) return state;
		if (type === "aicraft/accounting") return {
			...state,
			tracked: true
		};
		if (type === "aicraft/delegation") {
			if (state.children.some((c) => c.id === data.id)) return state;
			return {
				...state,
				children: [...state.children, {
					id: String(data.id),
					local: data.local === true,
					provider: String(data.provider)
				}]
			};
		}
		if (type === "turn/start") return {
			...state,
			openSince: event.time
		};
		if (type === "step/start" || type === "llm/retry-started") return {
			...state.attempt && !state.attempt.charged ? charge(state) : state,
			attempt: {
				start: event.time,
				turn: Number(data.turn),
				step: Number(data.step),
				route: state.route,
				sample: null,
				charged: null,
				chargedKey: null
			}
		};
		if ((type === "assistant/attempt" || type === "assistant/message") && state.attempt) {
			const parsed = routeSchema.safeParse(record(data.message).source);
			const attempt = {
				...state.attempt,
				sample: sampleOf(data) ?? state.attempt.sample,
				route: parsed.success ? parsed.data : state.attempt.route
			};
			return charge({
				...state,
				attempt
			});
		}
		if (type === "llm/retry") return state.attempt && !state.attempt.charged ? charge(state) : state;
		if (type === "step/end") return {
			...state.attempt && !state.attempt.charged ? charge(state) : state,
			attempt: null
		};
		if (type === "turn/end") return {
			...state.attempt && !state.attempt.charged ? charge(state) : state,
			attempt: null,
			openSince: null,
			intervals: state.openSince === null ? state.intervals : [...state.intervals, [state.openSince, Math.max(state.openSince, event.time)]]
		};
		return state;
	},
	wire: {
		viewSchema: accountingSchema,
		view: (state) => state
	}
};
/** Union root activity intervals; concurrent executor chats must not double elapsed task time. */
function intervalUnion(intervals) {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
	let total = 0, end = -Infinity;
	for (const [from, to] of sorted) {
		total += Math.max(0, to - Math.max(from, end));
		end = Math.max(end, to);
	}
	return total;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-util-values@0.2.2-rc.3_@deepseek-ai+cordis@4.1.0/node_modules/@deepseek-ai/dsh-util-values/lib/index.js
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
(class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
});
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.2.2-rc.3_@deepseek-ai+cordis@4.1.0_@deepseek-ai+dsh-error@0._8cdd61b1154f5d685261866b42f1df49/node_modules/@deepseek-ai/dsh-session/lib/index.js
/**
* Admit a numeric value as an existing Session event position.
* @param value - non-negative safe integer admitted by the owning log operation.
* @returns the same number with the Session-sequence brand.
*/
function SessionSeq(value) {
	if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
	return brandNumber(value);
}
/**
* Admit a numeric value as a Session log offset.
* @param value - non-negative safe integer used as a gap or prefix length.
* @returns the same number with the Session-log-offset brand.
*/
function SessionLogOffset(value) {
	if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)}`);
	return brandNumber(value);
}
/**
* Deep structural equality over the session-event JSON value domain
* (null/boolean/number/string, arrays, plain objects). Replaces
* `node:util`'s isDeepStrictEqual to keep this module browser-safe.
*/
function isDeepEqualJson(a, b) {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => isDeepEqualJson(item, b[i]));
	}
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aKeys = Object.keys(a);
	const bRecord = b;
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualJson(a[key], bRecord[key]));
}
/**
* Pending tool-result recovery shared by failed live steps, interrupted logs,
* and fork seeds. Tail repair preserves closed steps and supplies only missing
* tool results and lifecycle boundaries, with cause-specific retry guidance.
* @module @deepseek-ai/dsh-session/repair
*/
/** Recovery code for an assistant tool request that never reached a recorded call start. */
const TOOL_NOT_STARTED = "TOOL_NOT_STARTED";
/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN";
/** Model-visible wording of the synthetic error tool results, keyed by cause. */
const CLOSER_TEXT = {
	interrupted: {
		started: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.",
		notStarted: "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed."
	},
	forked: {
		started: "The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.",
		notStarted: "The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly."
	}
};
/**
* Return deterministic synthetic events that close an open tail turn. Unmatched
* calls receive error results first, followed by an open `step/end` and a
* cause-specific `turn/end`; sequences continue the log and timestamps reuse the
* last real event. A balanced or empty log returns no events.
*
* @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
* @param cause - the owning close operation: selects result wording and the turn-ending reason.
* @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
*/
function openTurnClosers(events, cause) {
	let openTurn = null;
	let openStep = null;
	const recovery = new ToolCallRecovery(cause);
	for (const event of events) {
		recovery.observe(event);
		switch (event.type) {
			case "turn/start":
				openTurn = event.data.turn;
				openStep = null;
				break;
			case "turn/end":
				openTurn = null;
				openStep = null;
				break;
			case "step/start":
				openStep = event.data.step;
				break;
			case "step/end":
				openStep = null;
				break;
			default: break;
		}
	}
	const last = events.at(-1);
	if (openTurn === null || last === void 0) return [];
	const closers = recovery.results();
	let seq = last.seq + closers.length + 1;
	const time = last.time;
	if (openStep !== null) closers.push({
		type: "step/end",
		seq: SessionSeq(seq++),
		time,
		data: {
			turn: openTurn,
			step: openStep
		}
	});
	closers.push({
		type: "turn/end",
		seq: SessionSeq(seq++),
		time,
		data: {
			turn: openTurn,
			reason: { kind: cause.kind }
		}
	});
	return closers;
}
/**
* Track unanswered assistant tool requests from one Session's committed events.
* Observe from the start of the owned step or replay prefix, and recover before
* its step closes. This state retains pending identities, not event history.
*/
var ToolCallRecovery = class {
	cause;
	pendingCalls = /* @__PURE__ */ new Map();
	last;
	/** @param cause - defaults to interrupted live/crash recovery; fork-seed construction supplies its own cause. */
	constructor(cause = { kind: "interrupted" }) {
		this.cause = cause;
	}
	/**
	* Consume the next committed event; closed steps and turn boundaries discard pending requests.
	* @param event - the next event from the same Session, in sequence order.
	*/
	observe(event) {
		this.last = {
			seq: event.seq,
			time: event.time
		};
		switch (event.type) {
			case "turn/start":
			case "turn/end":
			case "step/end":
				this.pendingCalls.clear();
				break;
			case "assistant/message":
				for (const block of event.data.message.content) if (block.type === "tool-call") this.pendingCalls.set(block.id, {
					turn: event.data.turn,
					step: event.data.step
				});
				break;
			case "tool/call": {
				const entry = this.pendingCalls.get(event.data.callId);
				if (entry) entry.callSeq = event.seq;
				break;
			}
			case "tool/result": {
				const callId = event.data.message.source.callId;
				const entry = this.pendingCalls.get(callId);
				if (event.surfaceOp === "append" && entry !== void 0 && entry.turn === event.data.turn && entry.step === event.data.step) this.pendingCalls.delete(callId);
				break;
			}
			default: break;
		}
	}
	/**
	* Build conservative error results in assistant order without changing tracked state.
	* Sequences follow the latest observed event and timestamps reuse its time.
	* Callers commit the results and observe those commits before recovering again.
	* @returns pending tool-result events, empty when no request remains unanswered.
	*/
	results() {
		if (this.last === void 0) return [];
		let seq = this.last.seq + 1;
		const time = this.last.time;
		const results = [];
		const text = CLOSER_TEXT[this.cause.kind];
		for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
			const started = callSeq !== void 0;
			const message = deepFreeze({
				id: brandString(`${this.cause.kind}-tool-result-${callId}-${seq}`),
				role: "tool",
				toolCallId: callId,
				isError: true,
				source: {
					kind: "tool",
					callId
				},
				content: [{
					type: "text",
					text: started ? text.started : text.notStarted
				}]
			});
			results.push({
				type: "tool/result",
				seq: SessionSeq(seq++),
				time,
				data: {
					turn,
					step,
					message,
					error: started ? {
						name: "ToolOutcomeUnknownError",
						code: TOOL_OUTCOME_UNKNOWN
					} : {
						name: "ToolNotStartedError",
						code: TOOL_NOT_STARTED
					}
				},
				surfaceOp: "append",
				...started ? { sourceEventSeqs: [callSeq] } : {}
			});
		}
		return results;
	}
};
/**
* Crash-recovery entry point: synthetic closers that balance a persisted log
* whose tail turn was interrupted. Used by crash-recovery callers; fork
* seeds receive their `forked`-cause closers through `buildForkSeed` in
* `./fork.ts`.
*
* @param events - the persisted log to scan, possibly ending inside an open turn.
* @returns the synthetic `interrupted` closer events to append after `events`; empty when the log is already balanced.
*/
function interruptedTurnClosers(events) {
	return openTurnClosers(events, { kind: "interrupted" });
}
//#endregion
//#region .build/host/execution-accounting/session-source.js
/**
* FILE: plugin/src/execution-accounting/session-source.ts
* DESCRIPTION: Read version-guarded project-local session folds without retaining cold logs
*/
var __addDisposableResource$1 = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources$1 = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
var SourceChanged = class extends Error {};
const version = "0.2.2-rc.3";
const providerName = "@deepseek-ai/dsh-session-persistence-jsonl";
const absent = (error) => record(error).code === "ENOENT";
const physicalRevision = (info) => [
	info.dev,
	info.ino,
	info.size,
	info.mtimeNs,
	info.ctimeNs
].join(":");
/**
* Encode UTF-16 units as the pinned JSONL layout does, including isolated surrogates.
*/
function encodeSessionSegment(value) {
	if (!value) throw withUiMessage(/* @__PURE__ */ new Error("Empty session path segment"), ownMessage({ key: "reasonEmptySessionPathSegment" }));
	if (value === "." || value === "..") return "~002E".repeat(value.length);
	let output = "";
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		output += /^[A-Za-z0-9._-]$/.test(char) ? char : "~" + value.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
	}
	return output;
}
/**
* The readable project key is lossy; it must never replace header cwd validation.
*/
function sessionProjectKey(cwd) {
	if (!cwd) throw withUiMessage(/* @__PURE__ */ new Error("Empty session project path"), ownMessage({ key: "reasonEmptySessionProjectPath" }));
	return `--${(encodeSessionSegment(cwd.replace(/[\\/:]+/g, "-")).replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
const sameStamp = (a, b) => !!a && !!b && a.owner === b.owner && a.revision === b.revision && a.key === b.key;
const asBackend = (value) => value;
/** One-shot source; the controller owns the only LRU and admission queue. */
var SessionSource = class {
	ctx;
	constructor(ctx) {
		this.ctx = ctx;
	}
	backend() {
		return asBackend(this.ctx.get("sessionPersistence"));
	}
	live(id) {
		return this.ctx.get("sessions")?.get(id);
	}
	check(id, selected, signal) {
		signal.throwIfAborted();
		const live = this.live(id), backend = this.backend();
		if (live !== selected.live || backend?.identity !== selected.backend?.identity || JSON.stringify([backend?.root, backend?.compression]) !== selected.address) throw new SourceChanged();
	}
	/** Resolve metadata from the provider's own Loader tree and verify the loaded module identity. */
	async compatible(storage) {
		try {
			if (storage.name !== "session-persistence-jsonl" || typeof storage.readStoredLog !== "function" || typeof storage.root !== "string" || !isAbsolute(storage.root) || !["none", "zstd"].includes(storage.compression)) return false;
			const origin = Object.getOwnPropertyDescriptor(storage, "ctx")?.value;
			const entry = record(origin?.fiber?.entry), options = record(entry.options);
			const anchor = record(record(record(entry.parent).tree).ctx).baseUrl;
			const resolver = this.ctx.get("pluginPackages");
			if (!resolver || options.name !== providerName || typeof anchor !== "string" || !entry.moduleNamespace) return false;
			const pkg = resolver.packageOf(providerName, anchor);
			if (pkg?.name !== providerName || pkg.version !== version) return false;
			const core = resolver.packageOf("@deepseek-ai/dsh-session", pathToFileURL(pkg.manifestPath).href);
			if (core?.name !== "@deepseek-ai/dsh-session" || core.version !== version) return false;
			const main = pkg.manifest.main;
			if (typeof main !== "string" || !main.startsWith("lib/")) return false;
			return await import(__rewriteRelativeImportExtension(pathToFileURL(join(pkg.dir, main)).href)) === entry.moduleNamespace;
		} catch {
			return false;
		}
	}
	async select(cwd, id, signal, direct) {
		signal.throwIfAborted();
		const backend = this.backend(), live = this.live(id);
		const selected = {
			mode: live ? "live" : "ordinary",
			backend,
			live,
			address: JSON.stringify([backend?.root, backend?.compression])
		};
		const checked = async (work) => {
			try {
				return await work;
			} finally {
				this.check(id, selected, signal);
			}
		};
		if (live) {
			selected.stamp = {
				owner: live,
				revision: live.seq,
				key: JSON.stringify([
					"live",
					cwd,
					id
				])
			};
			return selected;
		}
		if (backend && direct && await checked(this.compatible(backend))) {
			const root = normalize(backend.root), project = join(root, sessionProjectKey(cwd));
			const directory = join(project, encodeSessionSegment(id));
			const suffix = backend.compression === "zstd" ? ".zstd" : "";
			const path = join(directory, `session.v4.jsonl${suffix}`);
			const rel = relative(root, path);
			if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))) try {
				const legacy = await checked(readdir(project));
				const encoded = encodeSessionSegment(id);
				if (!legacy.includes(encoded + ".jsonl") && !legacy.includes(encoded + ".jsonl.zstd")) {
					const names = await checked(readdir(directory));
					const generations = names.filter((name) => name === "session.jsonl" || name === "session.jsonl.zstd" || /^session\.v[1-9][0-9]*\.jsonl(?:\.zstd)?$/.test(name));
					const opposite = generations.some((name) => name.endsWith(".zstd") !== (suffix === ".zstd"));
					const highest = Math.max(...generations.map((name) => Number(/^session\.v([1-9][0-9]*)\./.exec(name)?.[1] ?? 0)));
					if (!opposite && highest === 4 && names.includes(`session.v4.jsonl${suffix}`)) {
						const realRoot = await checked(realpath(root)), realFile = await checked(realpath(path));
						if (realRoot === root && realFile === path) {
							const info = await checked(stat(path, { bigint: true }));
							if (info.isFile()) return {
								...selected,
								mode: "direct",
								path,
								stamp: {
									owner: backend.identity,
									revision: physicalRevision(info),
									key: JSON.stringify([
										"direct",
										cwd,
										id,
										root,
										backend.compression,
										path
									])
								}
							};
						}
					}
				}
			} catch (error) {
				if (!absent(error)) throw error;
			}
		}
		if (backend) {
			const info = await checked(this.ctx.get("sessionPersistence").stat(id, { signal }));
			if (info?.revision !== void 0) selected.stamp = {
				owner: backend.identity,
				revision: info.revision,
				key: JSON.stringify([
					"ordinary",
					cwd,
					id
				])
			};
		}
		return selected;
	}
	packet(values, live) {
		const value = record(values), parsed = accountingSchema.safeParse(value.aicraftAccounting);
		return parsed.success ? {
			state: parsed.data,
			stats: record(value.sessionStats),
			catalog: value.subagentCatalog,
			live
		} : null;
	}
	/** Prepare and fold from zero; persistent DSH checkpoints cannot identify a replaced physical file. */
	async direct(cwd, id, selected, signal) {
		return diagnosticOperation({ path: "src/execution-accounting/session-source.ts" }, { sessionId: id }, async () => {
			const raw = record(await selected.backend.readStoredLog(selected.path, id, signal));
			this.check(id, selected, signal);
			const meta = record(raw.meta), events = raw.events;
			const boundary = raw.inheritedEventCount;
			if (raw.status !== "current" || meta.id !== id || meta.version !== 4 || !Array.isArray(events) || raw.eventState !== "shared-frozen" || !Number.isSafeInteger(boundary) || boundary < 0 || boundary > events.length || !meta.isSeeded && boundary !== 0) throw withUiMessage(/* @__PURE__ */ new Error("Invalid stored session snapshot"), ownMessage({ key: "reasonInvalidStoredSessionSnapshot" }));
			if (raw.revision !== selected.stamp?.revision) throw new SourceChanged();
			if (typeof meta.cwd !== "string" || !isAbsolute(meta.cwd)) throw withUiMessage(/* @__PURE__ */ new Error("Stored session has no valid project"), ownMessage({ key: "reasonStoredSessionHasNoValidProject" }));
			if (normalize(meta.cwd) !== normalize(cwd)) {
				const actual = await realpath(meta.cwd), expected = await realpath(cwd);
				this.check(id, selected, signal);
				if (actual !== expected) throw withUiMessage(/* @__PURE__ */ new Error("Stored session belongs to another project"), ownMessage({ key: "reasonStoredSessionBelongsToAnotherProject" }));
			}
			const balanced = [...events, ...interruptedTurnClosers(events)];
			const prepared = this.ctx.get("sessions").prepare(id, {
				meta: structuredClone(meta),
				seed: balanced,
				inheritedEventCount: SessionLogOffset(boundary),
				eventState: "shared-frozen"
			});
			const snapshot = this.ctx.sessionProjections.hydrate(prepared, {}, balanced, SessionLogOffset(0));
			this.check(id, selected, signal);
			return this.packet(snapshot.values, false);
		});
	}
	/** Read or validate a compact packet with one shared retry budget for source and physical changes. */
	async read(cwd, value, signal, cached) {
		const id = brandString(value);
		cwd = normalize(cwd);
		let allowDirect = true;
		for (let attempt = 0; attempt < 2; attempt++) {
			let selected;
			try {
				selected = await this.select(cwd, id, signal, allowDirect);
				let packet;
				let stamp = selected.stamp;
				if (sameStamp(stamp, cached?.stamp)) packet = cached.packet;
				else if (selected.mode === "direct") packet = await this.direct(cwd, id, selected, signal);
				else {
					const env_1 = {
						stack: [],
						error: void 0,
						hasError: false
					};
					try {
						const observation = __addDisposableResource$1(env_1, await this.ctx.sessionQuery.observeSession(id, { signal }), false);
						this.check(id, selected, signal);
						packet = this.packet(observation.projections?.values, observation.source === "live");
						const current = this.live(id);
						stamp = observation.source === "live" && current && current.seq === observation.cursor + 1 ? {
							owner: current,
							revision: current.seq,
							key: JSON.stringify([
								"live",
								cwd,
								id
							])
						} : observation.source === "prepared" && selected.backend && observation.revision ? {
							owner: selected.backend.identity,
							revision: observation.revision,
							key: JSON.stringify([
								"ordinary",
								cwd,
								id
							])
						} : void 0;
					} catch (e_1) {
						env_1.error = e_1;
						env_1.hasError = true;
					} finally {
						__disposeResources$1(env_1);
					}
				}
				const after = await this.select(cwd, id, signal, allowDirect);
				this.check(id, selected, signal);
				if (stamp && !sameStamp(stamp, after.stamp)) throw new SourceChanged();
				signal.throwIfAborted();
				return {
					packet,
					stamp
				};
			} catch (error) {
				signal.throwIfAborted();
				let changed = error instanceof SourceChanged || absent(error);
				if (selected) try {
					this.check(id, selected, signal);
				} catch {
					changed = true;
				}
				if (!changed && selected?.mode === "direct" && record(error).name === "SessionFormatUnsupportedError") {
					allowDirect = false;
					changed = true;
				}
				if (!changed || attempt === 1) throw error;
			}
		}
		throw withUiMessage(/* @__PURE__ */ new Error("Session source remained unstable"), ownMessage({ key: "reasonSessionSourceRemainedUnstable" }));
	}
};
//#endregion
//#region .build/host/execution-accounting/statistics.js
const trackingSchema = z.object({
	version: z.literal(1),
	sessions: z.array(z.object({
		id: z.string(),
		children: z.array(z.object({
			id: z.string(),
			local: z.boolean(),
			provider: z.string()
		}))
	}))
});
/** Host-owned persisted folds and bounded query admission, independent of panel rendering. */
var StatisticsController = class {
	ctx;
	lockWaitMs;
	ready;
	attached = /* @__PURE__ */ new WeakSet();
	packets = /* @__PURE__ */ new Map();
	source;
	readers = 0;
	waiting = [];
	constructor(ctx, lockWaitMs = 1e4) {
		this.ctx = ctx;
		this.lockWaitMs = lockWaitMs;
		this.source = new SessionSource(ctx);
		this.ready = ctx.sessionProjections.register(accountingProjection);
		ctx.on("agent/disposed", ({ agent }) => {
			this.attached.delete(agent);
		});
		ctx.on("subagent/start", async (info) => {
			const owner = ctx.agents.get(info.parentSessionId);
			if (!owner || !this.attached.has(owner)) return;
			const cwd = owner.session.header.cwd;
			if (!cwd) return;
			await this.ready;
			await this.tracking(cwd, (value) => {
				const session = value.sessions.find((item) => item.id === info.parentSessionId);
				if (!session.children.some((child) => child.id === info.id)) session.children.push({
					id: info.id,
					local: info.local,
					provider: info.provider
				});
			});
		});
		ctx.on("agent/created", async ({ agent }) => {
			const projection = await this.ready;
			const cwd = agent.session.header.cwd;
			if (!cwd) return;
			const parent = agent.session.header.parentSession, owner = parent ? ctx.agents.get(parent) : void 0;
			if (owner && this.attached.has(owner)) {
				await this.track(agent);
				return;
			}
			let saved;
			try {
				saved = await this.tracking(cwd);
			} catch (error) {
				ctx.get("logger")?.warn(`AICraft accounting metadata unavailable: ${String(error)}`);
				return;
			}
			if (saved.sessions.some((item) => item.id === agent.session.id) || projection.stateOf(agent.session).tracked) await this.track(agent);
		});
	}
	/** Keep project accounting metadata separate from session logs. */
	async tracking(cwd, update) {
		return diagnosticOperation({ path: "src/execution-accounting/statistics.ts" }, { projectPath: cwd }, async () => {
			const path = ".aicraft/accounting.json", signal = new AbortController().signal;
			const read = async () => {
				if (!await this.ctx.fs.lstat(path, { cwd })) return {
					value: {
						version: 1,
						sessions: []
					},
					version: null
				};
				const doc = await readMaterial(this.ctx.fs, cwd, path, new AbortController().signal);
				return {
					value: trackingSchema.parse(JSON.parse(doc.text)),
					version: doc.version
				};
			};
			if (!update) return (await read()).value;
			await targetFor(this.ctx.fs, cwd, path, signal);
			return withFileLock(join(cwd, path), async () => {
				const target = await targetFor(this.ctx.fs, cwd, path, signal);
				const { value, version } = await read();
				update(value);
				await diagnosticPublication(() => this.ctx.fs.writeText(target, JSON.stringify(value, null, 2) + "\n", version === null ? { kind: "createIfAbsent" } : {
					kind: "replaceIfVersion",
					version
				}, void 0, {
					mode: "workspace-write",
					workspaceRoot: cwd
				}), target, "writeText");
				return value;
			}, { waitMs: this.lockWaitMs });
		});
	}
	/**
	* START_METHOD_StatisticsController.track
	* Track only AICraft executors and their native descendants; never append custom chat events.
	*/
	async track(agent) {
		return diagnosticOperation({
			path: "src/execution-accounting/statistics.ts",
			method: "StatisticsController.track"
		}, { sessionId: agent.session.id }, async () => {
			await this.ready;
			if (this.attached.has(agent)) return;
			const cwd = agent.session.header.cwd;
			if (!cwd) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("AICraft accounting requires the session project directory"), ownMessage({ key: "reasonAICraftAccountingRequiresTheSessionProjectDirectory" })));
			const id = agent.session.id;
			this.attached.add(agent);
			try {
				await this.tracking(cwd, (value) => {
					if (!value.sessions.some((item) => item.id === id)) value.sessions.push({
						id,
						children: []
					});
				});
			} catch (error) {
				this.attached.delete(agent);
				throw error;
			}
		});
	}
	/**
	* START_METHOD_StatisticsController.read
	* Validate the requested root; retain saved descendants even when their parent packet is unavailable.
	*/
	async read(cwd, taskId, sessionId, signal) {
		return diagnosticOperation({
			path: "src/execution-accounting/statistics.ts",
			method: "StatisticsController.read"
		}, {
			projectPath: cwd,
			taskId,
			sessionId
		}, async () => {
			await this.ready;
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Invalid task identifier"), ownMessage({ key: "reasonInvalidTaskIdentifier" })));
			await readTaskState(this.ctx.fs, cwd, taskId, signal);
			const task = { runs: await readRuns(this.ctx.fs, cwd, taskId, signal) };
			const roots = [...new Set(task.runs.filter((run) => sessionId === null || run.sessionId === sessionId).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).map((run) => run.sessionId))];
			if (sessionId !== null && !roots.includes(sessionId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("The session does not belong to this task"), ownMessage({ key: "reasonTheSessionDoesNotBelongToThisTask" })));
			let tracking = {
				version: 1,
				sessions: []
			};
			let trackingUnavailable = false;
			try {
				tracking = await this.tracking(cwd);
			} catch {
				trackingUnavailable = true;
			}
			const rootSet = new Set(roots), visited = /* @__PURE__ */ new Set(), incomplete = /* @__PURE__ */ new Set(), intervals = [];
			const buckets = /* @__PURE__ */ new Map();
			let totals = zeroTotals(), llmMs = 0, toolMs = 0, running = false, sessions = 0, coverageIncomplete = false;
			const messages = /* @__PURE__ */ new Map();
			const addIncomplete = (message, descriptor) => {
				incomplete.add(message);
				messages.set(message, descriptor);
			};
			const missing = (message, descriptor) => {
				coverageIncomplete = true;
				addIncomplete(message, descriptor);
			};
			const stack = [...roots].reverse();
			while (stack.length) {
				signal.throwIfAborted();
				const id = stack.pop();
				if (visited.has(id)) continue;
				visited.add(id);
				let packet = null;
				try {
					packet = await this.observe(cwd, id, signal);
				} catch (error) {
					if (signal.aborted) throw error;
				}
				const saved = tracking.sessions.find((item) => item.id === id);
				const children = /* @__PURE__ */ new Map();
				if (!packet) missing("Some session statistics are unavailable.", { key: "reasonSomeSessionStatisticsAreUnavailable" });
				else {
					const { state, stats, live } = packet;
					sessions++;
					totals = addTotals(totals, state.totals);
					for (const bucket of state.buckets) {
						const key = JSON.stringify([
							bucket.provider,
							bucket.model,
							bucket.period
						]), previous = buckets.get(key);
						buckets.set(key, {
							...bucket,
							totals: previous ? addTotals(previous.totals, bucket.totals) : bucket.totals
						});
					}
					if (!state.tracked && !saved) missing("Earlier subagent usage may be missing.", { key: "reasonEarlierSubagentUsageMayBeMissing" });
					if (trackingUnavailable) missing("Delegation accounting metadata is unavailable.", { key: "reasonDelegationAccountingMetadataIsUnavailable" });
					if (state.attempt || state.openSince !== null) running = true;
					if (rootSet.has(id)) {
						intervals.push(...state.intervals);
						if (state.openSince !== null && live) intervals.push([state.openSince, Date.now()]);
						if (typeof stats.llmMs === "number" && typeof stats.toolMs === "number") {
							llmMs += stats.llmMs;
							toolMs += stats.toolMs;
						} else addIncomplete("Some timing data is unavailable.", { key: "reasonSomeTimingDataIsUnavailable" });
					}
					for (const child of state.children) children.set(child.id, { local: child.local });
				}
				for (const child of saved?.children ?? []) children.set(child.id, { local: child.local });
				if (packet) if (!Array.isArray(packet.catalog)) missing("Subagent discovery is unavailable.", { key: "reasonSubagentDiscoveryIsUnavailable" });
				else for (const value of packet.catalog) {
					const child = record(value);
					if (typeof child.id === "string" && !children.has(child.id)) children.set(child.id, { local: true });
				}
				for (const [child, info] of children) if (info.local) stack.push(child);
				else missing("External subagent usage is unavailable.", { key: "reasonExternalSubagentUsageIsUnavailable" });
			}
			if (totals.unknownUsage) addIncomplete("Some requests did not report complete token usage.", { key: "reasonSomeRequestsDidNotReportCompleteTokenUsage" });
			if (totals.unknownCache) addIncomplete("Some requests did not report cache details.", { key: "reasonSomeRequestsDidNotReportCacheDetails" });
			return {
				...totals,
				buckets: [...buckets.values()],
				elapsedMs: intervalUnion(intervals),
				llmMs,
				toolMs,
				running,
				sessions,
				coverageIncomplete,
				incomplete: [...incomplete],
				incompleteMessages: [...incomplete].map((line) => messages.get(line))
			};
		});
	}
	/** Keep one bounded LRU of completed folds; source validation never globally resolves a direct file. */
	async observe(cwd, id, signal) {
		if (this.readers >= 2) await new Promise((resolve) => this.waiting.push(resolve));
		else this.readers++;
		const key = JSON.stringify([cwd, id]);
		try {
			signal.throwIfAborted();
			const result = await this.source.read(cwd, id, signal, this.packets.get(key));
			signal.throwIfAborted();
			this.packets.delete(key);
			if (result.packet && result.stamp) {
				this.packets.set(key, {
					stamp: result.stamp,
					packet: result.packet
				});
				if (this.packets.size > 128) this.packets.delete(this.packets.keys().next().value);
			}
			return result.packet;
		} catch (error) {
			this.packets.delete(key);
			throw error;
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.readers--;
		}
	}
};
//#endregion
//#region .build/host/project-settings/rules.js
/**
* FILE: plugin/src/project-settings/rules.ts
* DESCRIPTION: Read and explicitly migrate shared project rules
*/
/** Prefer project rules; read legacy projects without changing files during queries. */
async function projectRulesFile(fs, cwd, signal) {
	for (const file of ["project-rules.md", "agent-rules.md"]) {
		await targetFor(fs, cwd, `.aicraft/${file}`, signal);
		if (await fs.lstat(`.aicraft/${file}`, { cwd }, signal)) return file;
	}
	return "project-rules.md";
}
/**
* Called only under the project writer lock by explicit open/prepare operations.
*/
async function migrateProjectRules(fs, cwd, signal) {
	if (await projectRulesFile(fs, cwd, signal) !== "agent-rules.md") return;
	const source = await targetFor(fs, cwd, ".aicraft/agent-rules.md", signal);
	const target = await targetFor(fs, cwd, ".aicraft/project-rules.md", signal);
	const document = await readMaterial(fs, cwd, ".aicraft/agent-rules.md", signal);
	const from = fileURLToPath(fs.fileUrl(source)), to = fileURLToPath(fs.fileUrl(target));
	if (fs.processPathFromHostPath(from) !== fs.processPath(source) || fs.processPathFromHostPath(to) !== fs.processPath(target)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("This filesystem does not support local rules renaming"), ownMessage({ key: "reasonThisFilesystemDoesNotSupportLocalRulesRenaming" })));
	if ((await fs.lstat(".aicraft/agent-rules.md", { cwd }, signal))?.version !== document.version) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Project rules changed before renaming. Try again."), ownMessage({ key: "reasonProjectRulesChangedBeforeRenamingTryAgain" })));
	if (await fs.lstat(".aicraft/project-rules.md", { cwd }, signal)) return;
	signal.throwIfAborted();
	await diagnosticPublication(() => rename(from, to), to, "rename");
}
/**
* START_METHOD_openProjectRules
* Explicit Project rules action; preserve existing instructions when adopting the new name.
*/
async function openProjectRules(fs, cwd, waitMs, signal) {
	return diagnosticOperation({
		path: "src/project-settings/rules.ts",
		method: "openProjectRules"
	}, { projectPath: cwd }, async () => {
		return withFileLock(join(cwd, ".aicraft"), async () => {
			await assertProjectWritable(fs, cwd, signal);
			await migrateProjectRules(fs, cwd, signal);
			return readMaterial(fs, cwd, ".aicraft/project-rules.md", signal);
		}, { waitMs });
	});
}
/**
* START_METHOD_readRulesAndRole
* Read current shared rules and the selected role without changing project files.
* @param fs - DSH filesystem provider.
* @param cwd - Registered project directory.
* @param roleId - Role identity from the saved process.
* @param signal - Caller cancellation.
* @returns Current shared rules and the selected role instructions.
*/
async function readRulesAndRole(fs, cwd, roleId, signal) {
	return diagnosticOperation({
		path: "src/project-settings/rules.ts",
		method: "readRulesAndRole"
	}, { projectPath: cwd }, async () => {
		const read = async (path, missing) => {
			const target = await targetFor(fs, cwd, path, signal);
			const info = await fs.stat(target, signal);
			if (!info) throw diagnosticRejection(withUiMessage(new Error(missing), ownMessage({
				key: "missingInput",
				params: { path }
			})));
			if (info.type !== "file") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Executor input must be a file: ${path}`), ownMessage({
				key: "reasonExecutorInputMustBeAFileValue0",
				params: { value0: path }
			})));
			const content = await fs.readText(target, signal);
			if (!content.trim()) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Executor input must not be empty: ${path}`), ownMessage({
				key: "reasonExecutorInputMustNotBeEmptyValue0",
				params: { value0: path }
			})));
			return content;
		};
		const rules = await read(`.aicraft/${await projectRulesFile(fs, cwd, signal)}`, "Missing .aicraft/project-rules.md. Prepare or restore the project rules before starting an executor.");
		const rolePath = `.aicraft/config/roles/${roleId}.md`;
		return {
			rules,
			role: await read(rolePath, `Add the role instruction in ${rolePath} before starting an executor.`)
		};
	});
}
//#endregion
//#region .build/host/project-settings/project.js
/**
* FILE: plugin/src/project-settings/project.ts
* DESCRIPTION: Read project readiness and prepare missing settings
*/
const defaultProcess = {
	language: "ru",
	name: "Анализ → изменение файла → ревью",
	steps: [
		{
			id: "analysis",
			title: "Анализ",
			role: "analyst",
			model: defaultStepModel()
		},
		{
			id: "implementation",
			title: "Изменение файла",
			role: "developer",
			model: defaultStepModel()
		},
		{
			id: "review",
			title: "Ревью",
			role: "reviewer",
			model: defaultStepModel()
		}
	]
};
const defaults = {
	"project-rules.md": "## Общие правила\n\nРаботай только в пределах постановки задачи. При недостатке требований задай вопрос разработчику. Сохраняй результат в каталоге этапа. Не переводи и не закрывай задачу самостоятельно. Не создавай коммиты, не переключай ветки и не отправляй изменения без отдельного поручения.\n",
	"request.md": "# Постановка задачи\n\n## Требования\n\n## Ожидаемый результат\n\n## Условия приёмки\n",
	"knowledge-base/.gitkeep": "",
	"tasks/.gitkeep": ""
};
async function text(fs, cwd, path, signal) {
	return fs.readText(await targetFor(fs, cwd, `.aicraft/${path}`, signal), signal);
}
async function createText$1(fs, cwd, path, content, signal) {
	const target = await targetFor(fs, cwd, `.aicraft/${path}`, signal);
	await diagnosticPublication(() => fs.writeText(target, content, { kind: "createIfAbsent" }, signal, {
		mode: "workspace-write",
		workspaceRoot: cwd
	}), target, "writeText");
}
/**
* START_METHOD_hasAicraftProject
* Identify an MVP project by its directory, without requiring metadata files.
* @param fs - DSH filesystem provider.
* @param cwd - Registered project directory.
* @param signal - Caller cancellation.
* @returns Whether .aicraft exists as a directory.
*/
async function hasAicraftProject(fs, cwd, signal) {
	return diagnosticOperation({
		path: "src/project-settings/project.ts",
		method: "hasAicraftProject"
	}, { projectPath: cwd }, async () => {
		return (await fs.stat(await targetFor(fs, cwd, ".aicraft/", signal), signal))?.type === "directory";
	});
}
/**
* START_METHOD_readProjectReadiness
* Read required settings without inspecting knowledge materials or their marker.
*/
async function readProjectReadiness(fs, cwd, signal, canCreate = true) {
	return diagnosticOperation({
		path: "src/project-settings/project.ts",
		method: "readProjectReadiness"
	}, { projectPath: cwd }, async () => {
		const prepared = await hasAicraftProject(fs, cwd, signal);
		const result = {
			prepared,
			needsPreparation: (await Promise.all(Object.keys(defaults).filter((path) => path !== "knowledge-base/.gitkeep").map(async (path) => fs.stat(await targetFor(fs, cwd, `.aicraft/${path === "project-rules.md" ? await projectRulesFile(fs, cwd, signal) : path}`, signal), signal)))).some((info) => info?.type !== "file"),
			creationIssue: null,
			processes: [],
			requestTemplate: ""
		};
		if (!prepared) {
			result.creationIssue ??= "Prepare AICraft project files first.";
			result.creationIssueMessage = { key: "prepareFirst" };
			return result;
		}
		try {
			result.requestTemplate = await text(fs, cwd, "request.md", signal);
			const directory = await targetFor(fs, cwd, ".aicraft/config/processes", signal);
			let readyProcess = false;
			for (const entry of await fs.listDir(directory, signal)) {
				if (entry.type !== "file" || !entry.name.endsWith(".jsonc")) continue;
				const id = entry.name.slice(0, -6);
				if (!/^[a-z][a-z0-9-]*$/.test(id)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Process filenames must be lowercase identifiers"), ownMessage({ key: "reasonProcessFilenamesMustBeLowercaseIdentifiers" })));
				const definition = await process$1(fs, cwd, id, signal);
				readyProcess ||= definition.steps.length > 0;
				result.processes.push({
					id,
					name: definition.name
				});
			}
			result.processes.sort((a, b) => a.id.localeCompare(b.id));
			if (!result.creationIssue && !canCreate) {
				result.creationIssue = "Resolve or close the current task before creating another.";
				result.creationIssueMessage = { key: "closeCurrentFirst" };
			}
			if (!result.creationIssue && result.processes.length === 0) {
				result.creationIssue = "Add a process definition before creating a task.";
				result.creationIssueMessage = { key: "addProcessFirst" };
			}
			if (!result.creationIssue && !readyProcess) {
				result.creationIssue = "Add roles and at least one step in Project settings before creating a task.";
				result.creationIssueMessage = { key: "addStepsFirst" };
			}
		} catch (error) {
			signal.throwIfAborted();
			result.creationIssue = error instanceof Error ? error.message : String(error);
			result.creationIssueMessage = messageOf(error) ?? externalMessage("projectReadFailed", error);
		}
		return result;
	});
}
/**
* START_METHOD_prepareProject
* Create missing defaults without overwriting existing project materials.
* @param fs - DSH filesystem.
* @param subprocess - Git command provider.
* @param cwd - Canonical local project directory.
* @param config - Operation limits.
* @param signal - Caller cancellation.
* @returns Updated project readiness.
*/
async function prepareProject(fs, subprocess, cwd, config, signal, request, readProject) {
	return diagnosticOperation({
		path: "src/project-settings/project.ts",
		method: "prepareProject"
	}, { projectPath: cwd }, async () => {
		const input = request === null ? null : validate(z.object({
			template: z.enum([
				"ru",
				"en",
				"manual"
			]),
			processId: z.string().regex(/^[a-z][a-z0-9-]*$/),
			definition: processDraftSchema.nullable()
		}), request);
		const language = input?.template === "en" || input?.template === "manual" ? "en" : "ru";
		const definition = input?.template === "manual" ? input.definition : input ? processTemplate(language) : defaultProcess;
		if (!definition || !definition.name.trim() || definition.steps.some((step) => !step.title.trim())) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Enter a process name and names for any steps."), ownMessage({ key: "reasonEnterAProcessNameAndNamesForAnySteps" })));
		const roles = input?.template === "manual" ? {} : templateRoleInstructions(language);
		if (input?.template !== "manual" && definition.steps.some((step) => !roles[step.role])) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Choose a supported role for each step."), ownMessage({ key: "reasonChooseASupportedRoleForEachStep" })));
		const processPath = `config/processes/${input?.processId ?? "manual"}.jsonc`;
		const files = {
			...defaults,
			...Object.fromEntries(Object.entries(roles).map(([id, text]) => [`config/roles/${id}.md`, text]))
		};
		if (language === "en") {
			files["project-rules.md"] = "## Shared rules\n\nWork only within the task requirements. Ask the user if requirements are incomplete. Save results in the step directory. Do not advance or close the task yourself. Do not create commits, switch branches or push changes without a separate instruction.\n";
			files["request.md"] = "# Task requirements\n\n## Requirements\n\n## Expected result\n\n## Acceptance criteria\n";
		}
		for (const path of [...Object.keys(files), processPath]) await targetFor(fs, cwd, `.aicraft/${path}`, signal);
		return withFileLock(join(cwd, ".aicraft"), async () => {
			signal.throwIfAborted();
			await assertProjectWritable(fs, cwd, signal);
			const target = await targetFor(fs, cwd, `.aicraft/${processPath}`, signal);
			if (input && await fs.stat(target, signal)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("A process with this ID already exists. Choose another ID."), ownMessage({ key: "reasonAProcessWithThisIDAlreadyExistsChooseAnotherID" })));
			await migrateProjectRules(fs, cwd, signal);
			for (const path of Object.keys(files)) await targetFor(fs, cwd, `.aicraft/${path}`, signal);
			diagnosticAccepted({
				input,
				language
			});
			for (const [path, content] of Object.entries(files)) if (!await fs.stat(await targetFor(fs, cwd, `.aicraft/${path}`, signal), signal)) await createText$1(fs, cwd, path, content, signal);
			if (!await fs.stat(target, signal)) await createText$1(fs, cwd, processPath, JSON.stringify(definition, null, 2) + "\n", signal);
			return readProject(fs, subprocess, cwd, config, signal);
		}, { waitMs: config.lockWaitMs });
	});
}
//#endregion
//#region .build/host/project-settings/processes.js
/**
* FILE: plugin/src/project-settings/processes.ts
* DESCRIPTION: Read and save project process definitions
*/
/**
* Validate process identifiers before constructing project-relative paths.
*/
function identifier(id) {
	if (typeof id !== "string" || id !== id.trim() || !/^[a-z][a-z0-9-]*$/.test(id)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Use a lowercase identifier with letters, digits and hyphens"), ownMessage({ key: "reasonUseALowercaseIdentifierWithLettersDigitsAndHyphens" })));
}
/**
* Parse a process draft and retain the violated schema constraint.
*/
function definition(text) {
	const errors = [];
	const value = parse(text, errors, { allowTrailingComma: true });
	if (errors.length) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Process definition is invalid"), ownMessage({ key: "reasonProcessDefinitionIsInvalid" })));
	return validate(processDraftSchema, value);
}
/**
* Read the original versioned process definition.
*/
async function readProcess(fs, cwd, id, signal) {
	identifier(id);
	const file = await readMaterial(fs, cwd, `.aicraft/config/processes/${id}.jsonc`, signal);
	return {
		id,
		definition: definition(file.text),
		version: file.version
	};
}
/**
* START_METHOD_saveProcess
* Save only a project template with version checks; never rewrite task snapshots.
*/
async function saveProcess(fs, cwd, id, input, version, waitMs, signal, templateLanguage = null) {
	return diagnosticOperation({
		path: "src/project-settings/processes.ts",
		method: "saveProcess"
	}, { projectPath: cwd }, async () => {
		identifier(id);
		if (templateLanguage !== null && (version !== null || !["ru", "en"].includes(templateLanguage))) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Choose a bundled template only for a new process"), ownMessage({ key: "reasonChooseABundledTemplateOnlyForANewProcess" })));
		const value = validate(processSchema, input);
		if (!value.name.trim() || value.steps.some((step) => !step.title.trim())) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Process and step names must not be empty"), ownMessage({ key: "reasonProcessAndStepNamesMustNotBeEmpty" })));
		await targetFor(fs, cwd, `.aicraft/config/processes/${id}.jsonc`, signal);
		if ((await fs.stat(await fs.resolve(".aicraft", {
			cwd,
			signal
		}), signal))?.type !== "directory") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Initialize an AICraft project first"), ownMessage({ key: "reasonInitializeAnAICraftProjectFirst" })));
		return withFileLock(join(cwd, ".aicraft"), async () => {
			await assertProjectWritable(fs, cwd, signal);
			signal.throwIfAborted();
			const root = await fs.resolve(".aicraft", {
				cwd,
				signal
			});
			if ((await fs.stat(root, signal))?.type !== "directory") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Initialize an AICraft project first"), ownMessage({ key: "reasonInitializeAnAICraftProjectFirst" })));
			const path = `.aicraft/config/processes/${id}.jsonc`;
			const target = await targetFor(fs, cwd, path, signal);
			const current = await fs.lstat(path, { cwd }, signal);
			if (current?.type === "symlink" || current && current.type !== "file") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Process template must be a regular file"), ownMessage({ key: "reasonProcessTemplateMustBeARegularFile" })));
			if (version === null ? Boolean(current) : !current || current.version !== version) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Process changed outside the editor. Reload settings before saving."), ownMessage({ key: "reasonProcessChangedOutsideTheEditorReloadSettingsBeforeSaving" })));
			const instructions = templateLanguage ? templateRoleInstructions(templateLanguage) : {};
			const missing = [];
			for (const role of new Set(value.steps.map((step) => step.role))) {
				const rolePath = `.aicraft/config/roles/${role}.md`;
				const roleTarget = await targetFor(fs, cwd, rolePath, signal);
				if (await fs.lstat(rolePath, { cwd }, signal)) await readMaterial(fs, cwd, rolePath, signal);
				else if (instructions[role]) missing.push({
					target: roleTarget,
					text: instructions[role]
				});
				else throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Create role "${role}" before saving this process.`), ownMessage({
					key: "reasonCreateRoleValue0BeforeSavingThisProcess",
					params: { value0: role }
				})));
			}
			const original = current ? definition((await readMaterial(fs, cwd, path, signal)).text) : void 0;
			const merged = {
				...original,
				...value,
				steps: value.steps.map((step) => ({
					...original?.steps.find((old) => old.id === step.id),
					...step
				}))
			};
			const text = JSON.stringify(merged, null, 2) + "\n";
			if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Process template is too large"), ownMessage({ key: "reasonProcessTemplateIsTooLarge" })));
			diagnosticAccepted(merged);
			for (const role of missing) await diagnosticPublication(() => fs.writeText(role.target, role.text, { kind: "createIfAbsent" }, signal, {
				mode: "workspace-write",
				workspaceRoot: cwd
			}), role.target, "writeText");
			await diagnosticPublication(() => fs.writeText(target, text, version === null ? { kind: "createIfAbsent" } : {
				kind: "replaceIfVersion",
				version
			}, signal, {
				mode: "workspace-write",
				workspaceRoot: cwd
			}), target, "writeText");
			return readProcess(fs, cwd, id, signal);
		}, { waitMs });
	});
}
/**
* Read and validate the selected process without changing its contents.
*/
async function process$1(fs, cwd, id, signal) {
	const errors = [];
	const value = parse(await text(fs, cwd, `config/processes/${id}.jsonc`, signal), errors, { allowTrailingComma: true });
	if (errors.length) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Process ${id} contains invalid JSONC`), ownMessage({
		key: "reasonProcessValue0ContainsInvalidJSONC",
		params: { value0: id }
	})));
	return validate(processDraftSchema, value);
}
/**
* START_METHOD_readProcessForTask
* Validate the selected process and its current shared instructions.
*/
async function readProcessForTask(fs, cwd, id, signal) {
	return diagnosticOperation({
		path: "src/project-settings/processes.ts",
		method: "readProcessForTask"
	}, { projectPath: cwd }, async () => {
		const route = validate(processSchema, await process$1(fs, cwd, id, signal));
		for (const step of route.steps) if (!(await text(fs, cwd, `config/roles/${step.role}.md`, signal)).trim()) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Role ${step.role} has no instructions`), ownMessage({
			key: "reasonRoleValue0HasNoInstructions",
			params: { value0: step.role }
		})));
		if (!(await text(fs, cwd, await projectRulesFile(fs, cwd, signal), signal)).trim()) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("The project has no project rules"), ownMessage({ key: "reasonTheProjectHasNoProjectRules" })));
		return route;
	});
}
//#endregion
//#region .build/host/project-settings/roles.js
/**
* FILE: plugin/src/project-settings/roles.ts
* DESCRIPTION: Save and delete shared role instructions
*/
/**
* START_METHOD_saveRole
* Save a shared role instruction, using the material editor's versioned writer for edits.
*/
async function saveRole(fs, cwd, id, text, version, waitMs, signal) {
	return diagnosticOperation({
		path: "src/project-settings/roles.ts",
		method: "saveRole"
	}, { projectPath: cwd }, async () => {
		identifier(id);
		if (!text.trim() || text.includes("\0") || new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Role instructions must be nonempty UTF-8 text, at most 2 MiB"), ownMessage({ key: "reasonRoleInstructionsMustBeNonemptyUTF8TextAtMost2MiB" })));
		const path = `.aicraft/config/roles/${id}.md`;
		if (version !== null) {
			const file = await saveMaterial(fs, cwd, path, text, version, waitMs, signal);
			return {
				id,
				text: file.text,
				version: file.version
			};
		}
		await targetFor(fs, cwd, path, signal);
		if ((await fs.stat(await fs.resolve(".aicraft", {
			cwd,
			signal
		}), signal))?.type !== "directory") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Initialize an AICraft project first"), ownMessage({ key: "reasonInitializeAnAICraftProjectFirst" })));
		return withFileLock(join(cwd, ".aicraft"), async () => {
			await assertProjectWritable(fs, cwd, signal);
			const target = await targetFor(fs, cwd, path, signal);
			if (await fs.lstat(path, { cwd }, signal)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("A role with this ID already exists"), ownMessage({ key: "reasonARoleWithThisIDAlreadyExists" })));
			diagnosticAccepted({
				id,
				text,
				version
			});
			await diagnosticPublication(() => fs.writeText(target, text, { kind: "createIfAbsent" }, signal, {
				mode: "workspace-write",
				workspaceRoot: cwd
			}), target, "writeText");
			const file = await readMaterial(fs, cwd, path, signal);
			return {
				id,
				text: file.text,
				version: file.version
			};
		}, { waitMs });
	});
}
/**
* START_METHOD_deleteRole
* Delete the selected instruction, preserving every task and process reference.
*/
async function deleteRole(fs, cwd, id, version, waitMs, signal) {
	return diagnosticOperation({
		path: "src/project-settings/roles.ts",
		method: "deleteRole"
	}, { projectPath: cwd }, async () => {
		identifier(id);
		const path = `.aicraft/config/roles/${id}.md`;
		await targetFor(fs, cwd, path, signal);
		if ((await fs.stat(await fs.resolve(".aicraft", {
			cwd,
			signal
		}), signal))?.type !== "directory") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Initialize an AICraft project first"), ownMessage({ key: "reasonInitializeAnAICraftProjectFirst" })));
		await withFileLock(join(cwd, ".aicraft"), async () => {
			await assertProjectWritable(fs, cwd, signal);
			const target = await targetFor(fs, cwd, path, signal);
			const current = await fs.lstat(path, { cwd }, signal);
			if (!current || current.type !== "file" || current.version !== version) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Role changed outside the editor. Reload settings before deleting."), ownMessage({ key: "reasonRoleChangedOutsideTheEditorReloadSettingsBeforeDeleting" })));
			const hostPath = fileURLToPath(fs.fileUrl(target));
			if (fs.processPathFromHostPath(hostPath) !== fs.processPath(target)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("This filesystem does not support local role deletion"), ownMessage({ key: "reasonThisFilesystemDoesNotSupportLocalRoleDeletion" })));
			const latest = await fs.lstat(path, { cwd }, signal);
			if (!latest || latest.type !== "file" || latest.version !== version) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Role changed outside the editor. Reload settings before deleting."), ownMessage({ key: "reasonRoleChangedOutsideTheEditorReloadSettingsBeforeDeleting" })));
			signal.throwIfAborted();
			await diagnosticPublication(() => unlink(hostPath), hostPath, "unlink");
		}, { waitMs });
	});
}
//#endregion
//#region .build/host/project-settings/introduction.js
/**
* FILE: plugin/src/project-settings/introduction.ts
* DESCRIPTION: Supply the canonical framework introduction independently of task data
*/
const aicraftIntroduction = "AICraft is a DeepSeek Harness plugin for working on tasks through configurable processes.\n\nAICraft also provides an optional OneC Dark appearance in DSH settings. This preference belongs to the DSH profile, is shared across its clients, and does not change project or task data. The appearance is selected in the user interface; AICraft adds no agent command for it.\n\nA project is a working directory with AICraft settings and tasks. A process defines ordered stages, roles, and models. Creating a task saves a copy of its process; later changes to the shared template do not change that copy. A task stores its request, stage states, and work materials. A stage is a unit of work with an assigned role and model. A role describes an agent's responsibilities; its instructions and the project rules govern the agent's actions. A run is a stage execution linked to a DSH conversation and its results.\n\nAICraft prepares assignments, stores state and execution links, and provides commands for task management and access to materials. DSH connects models, executes agents, and stores conversations. The user and agents perform the substantive work and make decisions within their authority. A coordinator is an agent role, not a built-in manager inside the plugin.\n\nThe task's saved process contains its stages, assigned roles, and models. Each model assignment includes a provider, model, and optional reasoning effort. Default uses the selected model's DSH default effort; the resolved effort is recorded for each run. The panel can change the model and effort for one run without changing the stage assignment. Agent launches use the stage assignment. A prepared assignment includes the task request, project rules, role instructions, and material locations. Saved user edits are not replaced by automatic prompt regeneration. AICraft commands provide access to task state and transitions.\n\nA finished run does not mean an accepted stage. Completing the last stage does not close the task; closing requires a separate command. Role instructions and project rules define acceptance, rework, and when to ask the user for a decision.\n\nDescriptions and parameters of available commands accompany this introduction. A role name grants no additional permissions. A command error is not confirmation that the command completed.";
//#endregion
//#region .build/host/project-settings/settings.js
/**
* FILE: plugin/src/project-settings/settings.ts
* DESCRIPTION: Read editable processes and role documents
*/
/**
* START_METHOD_readSettings
* Read project templates and role choices, independently of task state.
*/
async function readSettings(fs, cwd, signal) {
	return diagnosticOperation({
		path: "src/project-settings/settings.ts",
		method: "readSettings"
	}, { projectPath: cwd }, async () => {
		const result = {
			processes: [],
			roles: [],
			roleDocuments: []
		};
		for (const kind of ["processes", "roles"]) {
			const dir = await targetFor(fs, cwd, `.aicraft/config/${kind}`, signal);
			if (!await fs.stat(dir, signal)) continue;
			for (const entry of await fs.listDir(dir, signal)) {
				const match = entry.name.match(kind === "processes" ? /^([a-z][a-z0-9-]*)\.jsonc$/ : /^([a-z][a-z0-9-]*)\.md$/);
				if (!match) continue;
				if (kind === "processes") result.processes.push(await readProcess(fs, cwd, match[1], signal));
				else {
					const role = await readMaterial(fs, cwd, `.aicraft/config/roles/${entry.name}`, signal);
					result.roles.push(match[1]);
					result.roleDocuments.push({
						id: match[1],
						text: role.text,
						version: role.version
					});
				}
			}
		}
		result.processes.sort((a, b) => a.id.localeCompare(b.id));
		result.roles.sort();
		result.roleDocuments.sort((a, b) => a.id.localeCompare(b.id));
		return result;
	});
}
//#endregion
//#region .build/host/step-execution/prompts.js
/**
* FILE: plugin/src/step-execution/prompts.ts
* DESCRIPTION: Open saved prompts and compose defaults from current inputs
*/
/**
* Validate and read the same executor inputs for the panel and dispatch.
* @param fs - DSH filesystem provider.
* @param cwd - Registered project directory.
* @param taskId - Task identity obtained from the current snapshot.
* @param roleId - Role identity from the saved process.
* @param signal - Caller cancellation.
* @returns Current rules, role and task requirements.
*/
async function readExecutionInputs(fs, cwd, taskId, roleId, signal) {
	const read = async (path, missing) => {
		const target = await targetFor(fs, cwd, path, signal);
		const info = await fs.stat(target, signal);
		if (!info) throw withUiMessage(new Error(missing), ownMessage({
			key: "missingInput",
			params: { path }
		}));
		if (info.type !== "file") throw withUiMessage(/* @__PURE__ */ new Error(`Executor input must be a file: ${path}`), ownMessage({
			key: "reasonExecutorInputMustBeAFileValue0",
			params: { value0: path }
		}));
		const content = await fs.readText(target, signal);
		if (!content.trim()) throw withUiMessage(/* @__PURE__ */ new Error(`Executor input must not be empty: ${path}`), ownMessage({
			key: "reasonExecutorInputMustNotBeEmptyValue0",
			params: { value0: path }
		}));
		return content;
	};
	const { rules, role } = await readRulesAndRole(fs, cwd, roleId, signal);
	const requestPath = `.aicraft/tasks/${taskId}/request.md`;
	return {
		rules,
		role,
		request: await read(requestPath, `Add task requirements in ${requestPath} before starting an executor.`)
	};
}
/**
* START_METHOD_openStepPrompt
* Open or create the editable prompt without creating a run.
*/
async function openStepPrompt(fs, waitMs, cwd, taskId, stepId, signal, beforeCreate, progress) {
	return diagnosticOperation({
		path: "src/step-execution/prompts.ts",
		method: "openStepPrompt"
	}, {
		projectPath: cwd,
		taskId,
		stepId
	}, async () => {
		return withFileLock(join(cwd, ".aicraft"), () => inputPrompt(fs, cwd, taskId, stepId, signal, void 0, beforeCreate, progress), { waitMs });
	});
}
/**
* START_METHOD_defaultStepPrompt
* Generate editor defaults without changing the saved prompt or its version.
*/
async function defaultStepPrompt(fs, waitMs, cwd, taskId, stepId, version, signal) {
	return diagnosticOperation({
		path: "src/step-execution/prompts.ts",
		method: "defaultStepPrompt"
	}, {
		projectPath: cwd,
		taskId,
		stepId
	}, async () => {
		if (!version) throw diagnosticRejection(withUiMessage(new OperationRefusal("invalid-input", "The original file version is required"), ownMessage({ key: "reasonTheOriginalFileVersionIsRequired" })));
		return withFileLock(join(cwd, ".aicraft"), async () => {
			const text = await inputPrompt(fs, cwd, taskId, stepId, signal, version);
			return {
				path: `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`,
				text,
				version,
				format: "markdown"
			};
		}, { waitMs });
	});
}
/** Read the saved assignment or prepare it from the current stage inputs.
*/
async function inputPrompt(fs, cwd, taskId, stepId, signal, previewVersion, beforeCreate, progress) {
	const snapshot = await readTaskSnapshot(fs, cwd, signal);
	if (snapshot.kind === "ambiguous") throw withUiMessage(new OperationRefusal("state-conflict", AMBIGUOUS_TASKS_MESSAGE), ownMessage({ key: "ambiguousTasks" }));
	if (snapshot.kind === "invalid" || !snapshot.allTasks.some((task) => task.id === taskId)) throw withUiMessage(new OperationRefusal("state-conflict", "Task is missing or invalid"), ownMessage({ key: "reasonTaskIsMissingOrInvalid" }));
	const state = await readTaskState(fs, cwd, taskId, signal);
	const step = state.process.steps.find((item) => item.id === stepId);
	if (!step) throw withUiMessage(new OperationRefusal("not-found", "Step is missing from the task process"), ownMessage({ key: "reasonStepIsMissingFromTheTaskProcess" }));
	const path = `${`.aicraft/tasks/${taskId}/${stepId}`}/input-prompt.md`;
	const target = await targetFor(fs, cwd, path, signal);
	if (previewVersion !== void 0) {
		if ((await readMaterial(fs, cwd, path, signal)).version !== previewVersion) throw withUiMessage(new OperationRefusal("version-conflict", "The file changed outside the editor. Reload it before resetting the prompt."), ownMessage({ key: "reasonTheFileChangedOutsideTheEditorReloadItBeforeResettingThePrompt" }));
	} else if (await fs.lstat(path, { cwd }, signal)) return (await readMaterial(fs, cwd, path, signal)).text;
	if (previewVersion === void 0) await beforeCreate?.();
	const { rules, role, request } = await readExecutionInputs(fs, cwd, taskId, step.role, signal);
	const hasKnowledge = await hasKnowledgeMaterials(fs, cwd, signal);
	const stageDirectories = state.process.steps.slice(0, state.process.steps.indexOf(step) + 1);
	const labels = (state.process.language ?? "en") === "ru" ? {
		step: "Этап",
		role: "Роль",
		rules: "Общие правила",
		assignment: "Постановка",
		artifacts: "Артефакты",
		knowledge: "База знаний",
		directories: "Рабочие каталоги этапов"
	} : {
		step: "Step",
		role: "Role",
		rules: "Project rules",
		assignment: "Task requirements",
		artifacts: "Artifacts",
		knowledge: "Knowledge base",
		directories: "Step working directories"
	};
	const text = [
		`# AICraft: ${state.title}\n${labels.step}: ${step.title}\n${labels.role}: ${step.role}`,
		`## ${labels.rules}\n${rules}`,
		`## ${labels.role}\n${role}`,
		`## ${labels.assignment}\n${request}`,
		`## ${labels.artifacts}\n\n${hasKnowledge ? `${labels.knowledge}: \`.aicraft/knowledge-base/\`\n\n` : ""}${labels.directories}:\n\n${stageDirectories.map((item) => `- \`.aicraft/tasks/${taskId}/${item.id}/\``).join("\n")}`
	].join("\n\n") + "\n";
	if (text.includes("\0")) throw withUiMessage(new OperationRefusal("invalid-input", "The generated prompt must not contain NUL bytes"), ownMessage({ key: "reasonTheGeneratedPromptMustNotContainNULBytes" }));
	if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw withUiMessage(new OperationRefusal("invalid-input", "The generated prompt is too large (limit: 2 MiB)"), ownMessage({ key: "reasonTheGeneratedPromptIsTooLargeLimit2MiB" }));
	if (previewVersion === void 0) {
		const prepared = new TextEncoder().encode(text);
		progress?.submitting();
		const saved = await diagnosticPublication(async () => {
			try {
				return await fs.writeText(target, text, { kind: "createIfAbsent" }, signal, {
					mode: "workspace-write",
					workspaceRoot: cwd
				});
			} catch (error) {
				if (error !== null && typeof error === "object" && "code" in error && ["FS_STALE_VERSION", "FS_NOT_OBSERVED"].includes(String(error.code))) throw error;
				if (error !== null && typeof error === "object" && "code" in error && ["FS_PERMISSION_DENIED", "FS_SANDBOX_DENIED"].includes(String(error.code))) throw new OperationRefusal("access-denied", error instanceof Error ? error.message : String(error), { cause: error });
				try {
					const before = await fs.stat(target, signal);
					const bytes = await fs.readBytes(target, signal, 2 * 1024 * 1024);
					const after = await fs.stat(target, signal);
					if (before?.type === "file" && after?.type === "file" && after.version === before.version && bytes.length === prepared.length && bytes.every((byte, index) => byte === prepared[index])) return after;
				} catch {}
				throw error;
			}
		}, target, "writeText");
		progress?.confirmed({
			path,
			text,
			version: saved.version,
			format: "markdown"
		});
	}
	return text;
}
//#endregion
//#region .build/host/step-execution/application/start-run.js
/**
* FILE: plugin/src/step-execution/application/start-run.ts
* DESCRIPTION: Publish an original attempt before native dispatch and retain uncertain outcomes
*/
/**
* Classify the whole launch by native receipt and publication, retaining uncertainty after possible acceptance.
* Repeated attempt IDs observe their original run before any new-start checks.
*/
async function startRun(deps, context, taskId, attemptId, request, signal) {
	const check = verification(context, taskId, { attemptId });
	let externalMayHaveStarted = false;
	let registrationMayHaveStarted = false;
	let lookupCompleted = false;
	let readingExisting = false;
	let lastConfirmedState;
	let confirmation;
	try {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw withUiMessage(new OperationRefusal("invalid-input", "attemptId must contain 1–128 letters, digits, underscores or hyphens"), ownMessage({ key: "reasonAttemptIdMustContain1128LettersDigitsUnderscoresOrHyphens" }));
		return await deps.store.transaction(context, taskId, signal, async (writer) => {
			const previous = (await writer.read()).find((run) => run.attemptId === attemptId);
			lookupCompleted = true;
			if (previous) {
				if (!sameAttempt(previous, context.callerSessionId, request)) throw withUiMessage(new OperationRefusal("state-conflict", "The attemptId already identifies a different original request"), ownMessage({ key: "reasonTheAttemptIdAlreadyIdentifiesADifferentOriginalRequest" }));
				readingExisting = true;
				lastConfirmedState = {
					taskId,
					attemptId,
					runId: previous.id,
					...previous.dispatch?.phase === "accepted" ? {
						stepId: previous.stepId,
						sessionId: previous.sessionId
					} : {}
				};
				let run = previous;
				let recovered;
				if (run.dispatch?.phase === "rejected") throw withUiMessage(new OperationRefusal("dependency-unavailable", run.dispatch.reason ?? "The original dispatch was rejected"), run.dispatch.reasonMessage ?? ownMessage({
					key: "dispatchRejected",
					details: run.dispatch.reason ? [run.dispatch.reason] : []
				}));
				if (run.dispatch?.phase !== "accepted") {
					externalMayHaveStarted = run.dispatch?.phase === "submitting";
					recovered = await deps.reader.acceptedMessage?.(context, run, signal);
					if (!recovered) return {
						operationStatus: "unknown",
						problem: operationProblem(context, withUiMessage(/* @__PURE__ */ new Error("Acceptance of the original assignment is not established"), ownMessage({ key: "reasonAcceptanceOfTheOriginalAssignmentIsNotEstablished" }))),
						verification: check,
						lastConfirmedState
					};
					const messageId = recovered.messageId;
					externalMayHaveStarted = true;
					run = {
						...advanceDispatch(run, {
							phase: "accepted",
							messageId,
							reason: null
						}),
						status: "running",
						initialTurn: {
							turn: null,
							messageId
						}
					};
					lastConfirmedState = {
						taskId,
						attemptId,
						runId: run.id,
						stepId: run.stepId,
						sessionId: run.sessionId
					};
					await writer.save(run);
				}
				if (!run.dispatch?.messageId) throw withUiMessage(/* @__PURE__ */ new Error("The accepted original dispatch has no message receipt"), ownMessage({ key: "reasonTheAcceptedOriginalDispatchHasNoMessageReceipt" }));
				confirmation = {
					run,
					messageId: run.dispatch.messageId
				};
				if (recovered?.observationError !== void 0) throw recovered.observationError;
				confirmation.observation = recovered?.observation ?? await deps.reader.observe(context, run, signal);
				return {
					operationStatus: "confirmed",
					value: confirmation.observation
				};
			}
			const model = await deps.validate(context, taskId, request, signal);
			const admission = await deps.runtime.admit(context, signal);
			try {
				const prepared = await deps.prepare(context, taskId, attemptId, request, model, admission, signal);
				registrationMayHaveStarted = true;
				await writer.save(prepared.run);
				lastConfirmedState = {
					taskId,
					attemptId,
					runId: prepared.run.id
				};
				prepared.run = advanceDispatch(prepared.run, {
					phase: "submitting",
					messageId: null,
					reason: null
				});
				await writer.save(prepared.run);
				try {
					await deps.validateDispatch(context, taskId, prepared.run, signal);
				} catch (error) {
					const problem = operationProblem(context, error);
					const rejected = advanceDispatch(prepared.run, {
						phase: "rejected",
						messageId: null,
						reason: problem.message,
						reasonMessage: problem.uiMessage
					});
					await writer.save({
						...rejected,
						status: "failed",
						finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
						error: problem.message,
						errorMessage: problem.uiMessage
					});
					return {
						operationStatus: "rejected",
						problem: {
							...problem,
							code: error instanceof OperationRefusal ? error.code : "dependency-unavailable"
						}
					};
				}
				externalMayHaveStarted = true;
				let result;
				let recovered;
				try {
					result = await deps.runtime.start(context, prepared, signal);
				} catch (error) {
					result = {
						operationStatus: "unknown",
						problem: operationProblem(context, error),
						verification: check
					};
				}
				if (result.operationStatus === "unknown") {
					const uncertain = result;
					try {
						recovered = await deps.reader.acceptedMessage?.(context, prepared.run, signal);
					} catch {}
					if (!recovered) return {
						...uncertain,
						verification: check,
						lastConfirmedState
					};
					result = {
						operationStatus: "confirmed",
						value: { messageId: recovered.messageId }
					};
				}
				if (result.operationStatus === "rejected") {
					externalMayHaveStarted = false;
					const rejected = advanceDispatch(prepared.run, {
						phase: "rejected",
						messageId: null,
						reason: result.problem.message,
						reasonMessage: result.problem.uiMessage
					});
					await writer.save({
						...rejected,
						status: "failed",
						finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
						error: result.problem.message,
						errorMessage: result.problem.uiMessage
					});
					return result;
				}
				const accepted = advanceDispatch(prepared.run, {
					phase: "accepted",
					messageId: result.value.messageId,
					reason: null
				});
				lastConfirmedState = {
					taskId,
					attemptId,
					runId: accepted.id,
					stepId: accepted.stepId,
					sessionId: accepted.sessionId
				};
				prepared.run = {
					...accepted,
					status: "running",
					initialTurn: {
						turn: null,
						messageId: result.value.messageId
					}
				};
				await writer.save(prepared.run);
				confirmation = {
					run: prepared.run,
					messageId: result.value.messageId
				};
				if (recovered?.observationError !== void 0) throw recovered.observationError;
				confirmation.observation = recovered?.observation ?? await deps.reader.observe(context, prepared.run, signal);
				return {
					operationStatus: "confirmed",
					value: confirmation.observation
				};
			} finally {
				deps.runtime.releaseAdmission(admission);
			}
		});
	} catch (error) {
		const problem = operationProblem(context, error);
		const presentation = problem.uiMessage ? { reasonMessage: problem.uiMessage } : {};
		const activityPresentation = problem.uiMessage ? { reasonMessages: [problem.uiMessage] } : {};
		if (confirmation) return {
			operationStatus: "confirmed",
			refreshIssue: problem,
			value: confirmation.observation ?? {
				link: confirmation.run,
				initialOutcome: {
					state: "unknown",
					reason: problem.message,
					...presentation
				},
				activity: {
					selected: {
						state: "unknown",
						complete: false,
						participants: [],
						reasons: [problem.message],
						...activityPresentation
					},
					others: {
						state: "unknown",
						complete: false,
						participants: [],
						reasons: [problem.message],
						...activityPresentation
					}
				},
				availability: {
					executor: {
						state: "unavailable",
						reason: problem.message,
						...presentation
					},
					caller: confirmation.run.callerSessionId ? {
						state: "unavailable",
						reason: problem.message,
						...presentation
					} : null
				},
				delivery: {
					state: "accepted",
					messageId: confirmation.messageId
				},
				response: {
					state: "unknown",
					reason: problem.message,
					...presentation
				},
				result: null
			}
		};
		return error instanceof OperationRefusal && !externalMayHaveStarted || !registrationMayHaveStarted && !externalMayHaveStarted && !(error instanceof OperationUncertainty) && !readingExisting && (lookupCompleted || error instanceof OperationRefusal) ? {
			operationStatus: "rejected",
			problem: {
				...problem,
				code: error instanceof OperationRefusal ? error.code : "dependency-unavailable"
			}
		} : {
			operationStatus: "unknown",
			problem: {
				...problem,
				code: "outcome-unknown"
			},
			verification: error instanceof OperationUncertainty ? error.verification : check,
			...lastConfirmedState === void 0 ? {} : { lastConfirmedState }
		};
	}
}
//#endregion
//#region .build/host/dsh-integration/execution/runtime.js
/**
* FILE: plugin/src/dsh-integration/execution/runtime.ts
* DESCRIPTION: Own native execution admission, exact spawn dispatch and standalone agent lifetime
*/
const nativeIdentity = (value) => value && (typeof value === "object" || typeof value === "function") ? Reflect.get(value, symbols.original) ?? value : value;
/**
* The installed host can load another SDK module instance; use the seam's typed code vocabulary to recognize refusals.
*/
const nativeRefusal = (error, codes) => error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && codes.includes(error.code);
/**
* Own native executor handles and lifecycle subscriptions, releasing archived idle chats safely.
*/
var NativeExecutionRuntime = class {
	ctx;
	trackStatistics;
	resolveCaller;
	work;
	onSettled;
	admissions = /* @__PURE__ */ new WeakMap();
	handles = /* @__PURE__ */ new Map();
	active = /* @__PURE__ */ new Set();
	releasing = /* @__PURE__ */ new Set();
	archivedSessions = /* @__PURE__ */ new Set();
	releaseRevision = 0;
	stopping = false;
	/**
	* @param ctx - Service context with DSH execution and persistence dependencies.
	*/
	constructor(ctx, trackStatistics, resolveCaller, work, onSettled) {
		this.ctx = ctx;
		this.trackStatistics = trackStatistics;
		this.resolveCaller = resolveCaller;
		this.work = work;
		this.onSettled = onSettled;
		this.archivedSessions = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? []);
		ctx.on("domain/changed", (change) => {
			if (change.domain !== "workspace" || change.table !== "" || change.operation !== "put") return;
			this.archivedSessions = new Set(workspaceDomainState.parse(change.value).archivedSessionIds);
			this.releaseIdleHandles();
		});
		ctx.on("agent/disposed", ({ agent }) => {
			for (const [id, handle] of this.handles) if (handle.agent === agent) {
				this.handles.delete(id);
				this.active.delete(id);
				this.work.initial.delete(agent.session.id);
			}
		});
		ctx.on("agent/status", ({ status }) => {
			if (status === "idle") this.releaseIdleHandles();
		});
		ctx.on("agent/inbox/discarded", () => this.releaseIdleHandles());
		const jobs = ctx.get("jobs");
		if (jobs) ctx.effect(() => jobs.events.subscribe({ owners: "all" }, (event) => {
			if (event.type === "removed") this.releaseIdleHandles();
		}), "aicraft: executor job ownership");
		ctx.effect(() => async () => {
			this.stopping = true;
			await Promise.all([...this.handles.values()].map((handle) => handle.dispose()));
			this.handles.clear();
		}, "aicraft: executor lifetime");
	}
	/**
	* Ordinary idle chats stay live; archived owners release on lifecycle events, without polling.
	*/
	releaseIdleHandles() {
		this.releaseRevision++;
		for (const [id, handle] of this.handles) {
			if (this.stopping || !this.archivedSessions.has(handle.agent.session.id) || this.active.has(id) || this.releasing.has(id) || handle.agent.status !== "idle") continue;
			this.releasing.add(id);
			this.release(id, handle).catch((error) => {
				this.ctx.get("logger")?.warn(`AICraft executor release failed: ${String(error)}`);
			}).finally(() => this.releasing.delete(id));
		}
	}
	/**
	* Release only an archived owner after checking idle state, queued input and owned work.
	*/
	async release(id, handle) {
		const agent = handle.agent;
		while (!this.stopping && this.handles.get(id) === handle) {
			await agent.whenIdle();
			if (this.stopping || !this.archivedSessions.has(agent.session.id) || this.active.has(id) || this.handles.get(id) !== handle) return;
			const revision = agent.session.seq, generation = this.releaseRevision;
			const activity = await this.ctx.waterfall("workspace/session-activity", { sessionId: agent.session.id }, () => Promise.resolve([]));
			if (this.stopping || !this.archivedSessions.has(agent.session.id) || this.handles.get(id) !== handle) return;
			if (agent.status !== "idle" || agent.session.seq !== revision || this.releaseRevision !== generation) continue;
			if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length || agent.ctx.get("jobs")?.list(agent.session.id).some((job) => job.owner === agent.session.id) || activity.length) return;
			try {
				await handle.dispose();
				if (this.handles.get(id) === handle) this.handles.delete(id);
			} finally {
				if (this.handles.get(id) === handle && this.ctx.agents.get(agent.session.id) !== agent) this.handles.delete(id);
			}
			return;
		}
	}
	/**
	* Reconsider archived idle handles after an explicit project reconciliation.
	*/
	reconcileResources() {
		this.releaseIdleHandles();
	}
	/**
	* Validate the installed host composition and actual caller before native admission.
	*/
	services(context) {
		const required = [
			"agents",
			"agentPresets",
			"sessionProjections",
			"sessionPersistence",
			"sessionQuery",
			"agentLoop"
		];
		const services = required.map((name) => this.ctx.get(name));
		const missing = required.filter((_name, index) => !services[index]);
		if (missing.length) throw withUiMessage(new OperationRefusal("dependency-unavailable", `The host is missing required native execution services: ${missing.join(", ")}`), ownMessage({
			key: "reasonTheHostIsMissingRequiredNativeExecutionServicesValue0",
			params: { value0: missing.join(", ") }
		}));
		if (typeof this.trackStatistics !== "function") throw withUiMessage(new OperationRefusal("dependency-unavailable", "Early executor accounting is unavailable"), ownMessage({ key: "reasonEarlyExecutorAccountingIsUnavailable" }));
		services.push(this.trackStatistics);
		if (context.source === "agent") {
			const caller = context.callerRef && this.resolveCaller(context.callerRef);
			if (!caller || this.ctx.agents.get(caller.session.id) !== caller || caller.session.id !== context.callerSessionId) throw withUiMessage(new OperationRefusal("access-denied", "The actual calling agent is no longer live"), ownMessage({ key: "reasonTheActualCallingAgentIsNoLongerLive" }));
			const runtime = this.ctx.get("subagents"), provider = runtime?.getProvider("spawn");
			if (!provider || provider.name !== "spawn") throw withUiMessage(new OperationRefusal("dependency-unavailable", "The host must provide the exact spawn backend"), ownMessage({ key: "reasonTheHostMustProvideTheExactSpawnBackend" }));
			if (typeof provider.prepareContinuable !== "function") throw withUiMessage(new OperationRefusal("dependency-unavailable", "The spawn backend cannot prepare a continuable executor"), ownMessage({ key: "reasonTheSpawnBackendCannotPrepareAContinuableExecutor" }));
			if (provider.inheritsParentContext !== false) throw withUiMessage(new OperationRefusal("dependency-unavailable", "The spawn backend does not guarantee a fresh conversation"), ownMessage({ key: "reasonTheSpawnBackendDoesNotGuaranteeAFreshConversation" }));
			if (provider.capabilities?.agentOptions !== true) throw withUiMessage(new OperationRefusal("dependency-unavailable", "The spawn backend cannot select explicit executor model options"), ownMessage({ key: "reasonTheSpawnBackendCannotSelectExplicitExecutorModelOptions" }));
			services.push(runtime, provider, caller);
		}
		return services.map(nativeIdentity);
	}
	/** Check native launch readiness and install accounting for the reserved executor.
	*/
	async admit(context, signal) {
		signal.throwIfAborted();
		const identity = {}, services = this.services(context);
		const sessionId = `session-${randomUUID()}`;
		const token = {
			context,
			services,
			sessionId,
			accountingFailed: false
		};
		token.unlisten = this.ctx.on("agent/created", async ({ agent }) => {
			if (agent.session.id !== sessionId || !token.prepared) return void 0;
			try {
				if (context.source === "agent") setSandboxMode(agent.session, context.permissions.mode);
				await this.trackStatistics(agent);
				const workspace = this.ctx.workspaceRegistry.get(brandString(context.workspaceId));
				if (!workspace) throw withUiMessage(/* @__PURE__ */ new Error("The original workspace disappeared before dispatch"), ownMessage({ key: "reasonTheOriginalWorkspaceDisappearedBeforeDispatch" }));
				await workspace.attachSession(agent.session.id);
				this.ctx.sessionTitle.rename(agent.session, token.prepared.sessionTitle);
			} catch (error) {
				token.accountingFailed = true;
				throw error;
			}
		});
		if (typeof token.unlisten !== "function") throw withUiMessage(new OperationRefusal("dependency-unavailable", "The awaited executor creation listener is unavailable"), ownMessage({ key: "reasonTheAwaitedExecutorCreationListenerIsUnavailable" }));
		this.admissions.set(identity, token);
		return {
			identity,
			sessionId
		};
	}
	/** Release the reserved admission and its addressed creation listener.
	*/
	releaseAdmission(admission) {
		const token = this.admissions.get(admission.identity);
		if (!token) return;
		token.prepared = void 0;
		this.admissions.delete(admission.identity);
		try {
			token.unlisten?.();
		} catch (error) {
			this.ctx.get("logger")?.warn(`AICraft creation listener release failed: ${String(error)}`);
		}
	}
	/** Dispatch the prepared launch through its admitted native execution path.
	*/
	async start(context, prepared, signal) {
		const run = prepared.run;
		let invoked = false, handle;
		const token = this.admissions.get(prepared.admission.identity);
		try {
			signal.throwIfAborted();
			const services = this.services(context);
			if (!token || token.context !== context || token.services.some((service, index) => service !== services[index])) throw withUiMessage(new OperationRefusal("dependency-unavailable", "Native execution services changed after admission"), ownMessage({ key: "reasonNativeExecutionServicesChangedAfterAdmission" }));
			if (run.sessionId !== token.sessionId) throw withUiMessage(new OperationRefusal("state-conflict", "The reserved executor identity changed before dispatch"), ownMessage({ key: "reasonTheReservedExecutorIdentityChangedBeforeDispatch" }));
			token.prepared = prepared;
			diagnosticAccepted({
				workspaceId: context.workspaceId,
				taskId: run.taskId,
				stepId: run.stepId,
				runId: run.id,
				sessionId: run.sessionId
			});
			this.work.pending.add(run.sessionId);
			const selected = {
				provider: run.model.provider,
				model: run.model.model,
				...run.model.reasoningEffort === null ? context.source === "agent" ? { reasoningEffort: void 0 } : {} : { reasoningEffort: ReasoningEffortId(run.model.reasoningEffort) }
			};
			if (context.source === "agent") {
				const titleConfig = Reflect.get(this.ctx.sessionTitle, "config");
				invoked = true;
				const activation = await this.ctx.get("subagents").startActivation({
					provider: "spawn",
					childId: brandString(run.sessionId),
					label: normalizeSessionTitle(prepared.sessionTitle, titleConfig.maxTitleBytes),
					delivery: "parent",
					signal,
					parent: this.resolveCaller(context.callerRef),
					cwd: context.projectRoot,
					prompt: prepared.content,
					agentOptions: selected
				});
				diagnosticEvent("native.execution-accepted", {
					messageId: activation.messageId,
					callId: context.callId,
					callerSessionId: context.callerSessionId
				}, { path: "src/dsh-integration/execution/runtime.ts" });
				activation.result.then(() => this.stopping ? void 0 : this.onSettled(context, run)).catch((error) => this.ctx.get("logger")?.warn(`AICraft run observation failed: ${String(error)}`));
				return {
					operationStatus: "confirmed",
					value: { messageId: activation.messageId }
				};
			}
			const preset = await this.ctx.agentPresets.resolve();
			handle = await this.ctx.agents.create({
				sessionId: brandString(run.sessionId),
				meta: {
					cwd: context.projectRoot,
					agentPreset: preset.id
				},
				agentOptions: selected,
				signal,
				setup: async (agentCtx, agent) => {
					await this.ctx.agentPresets.mount(agentCtx, preset.id);
					installModelSelection(agentCtx);
					agent.session.append("model/selection", selected);
				}
			});
			this.handles.set(run.id, handle);
			this.active.add(run.id);
			this.work.initial.add(run.sessionId);
			const message = createUserMessage({
				content: prepared.content,
				source: { kind: "user" }
			});
			invoked = true;
			handle.agent.followup(message);
			diagnosticEvent("native.execution-accepted", {
				messageId: message.id,
				callId: context.callId,
				callerSessionId: null
			}, { path: "src/dsh-integration/execution/runtime.ts" });
			handle.agent.whenIdle().then(() => this.stopping ? void 0 : this.onSettled(context, run)).catch((error) => this.ctx.get("logger")?.warn(`AICraft run observation failed: ${String(error)}`)).finally(() => {
				this.active.delete(run.id);
				this.work.initial.delete(run.sessionId);
				this.releaseIdleHandles();
			});
			return {
				operationStatus: "confirmed",
				value: { messageId: message.id }
			};
		} catch (error) {
			diagnosticEvent("native.execution-failure", {
				callId: context.callId,
				callerSessionId: context.callerSessionId,
				sessionId: run.sessionId,
				acceptanceMayHaveStarted: invoked && !token?.accountingFailed,
				error: diagnosticFailure(error)
			}, { path: "src/dsh-integration/execution/runtime.ts" });
			if (!invoked || token?.accountingFailed || nativeRefusal(error, [
				"UNAUTHORIZED",
				"DUPLICATE_CHILD",
				"ACTIVATION_LIMIT_REACHED",
				"UNSUPPORTED_CAPABILITY",
				"DRAINING",
				"ACTIVATION_CLOSING",
				"PRESET_UNAVAILABLE",
				"PROVIDER_CHANGED"
			])) {
				if (handle) await handle.dispose();
				this.work.initial.delete(run.sessionId);
				return {
					operationStatus: "rejected",
					problem: {
						...operationProblem(context, error),
						code: error instanceof OperationRefusal ? error.code : "dependency-unavailable"
					}
				};
			}
			if (handle) handle.agent.whenIdle().then(() => this.stopping ? void 0 : this.onSettled(context, run)).catch((failure) => this.ctx.get("logger")?.warn(`AICraft uncertain run observation failed: ${String(failure)}`)).finally(() => {
				this.active.delete(run.id);
				this.work.initial.delete(run.sessionId);
				this.releaseIdleHandles();
			});
			return {
				operationStatus: "unknown",
				problem: operationProblem(context, error),
				verification: verification(context, run.taskId, { attemptId: run.attemptId })
			};
		} finally {
			this.work.pending.delete(run.sessionId);
			this.releaseAdmission(prepared.admission);
		}
	}
};
//#endregion
//#region .build/host/dsh-integration/execution/activity.js
const empty = () => ({
	state: "inactive",
	complete: true,
	participants: [],
	reasons: []
});
const identity = (value) => value ? Reflect.get(value, symbols.original) ?? value : value;
/**
* Track native lifecycle changes before snapshots so activity completeness can be established.
*/
var NativeWorkObservation = class {
	ctx;
	resolveCaller;
	observers = /* @__PURE__ */ new Set();
	activations = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Set();
	initial = /* @__PURE__ */ new Set();
	constructor(ctx, resolveCaller) {
		this.ctx = ctx;
		this.resolveCaller = resolveCaller;
		const changed = (...ids) => {
			for (const observer of this.observers) for (const id of ids) if (id) observer.add(id);
		};
		ctx.on("agent/created", ({ agent }) => {
			changed(agent.session.id, agent.session.header.parentSession);
		});
		ctx.on("agent/disposed", ({ agent }) => changed(agent.session.id, agent.session.header.parentSession));
		ctx.on("agent/status", ({ agent }) => changed(agent.session.id));
		ctx.on("subagent/start", (info) => {
			this.activations.set(info.runId, {
				sessionId: info.id,
				local: info.local
			});
			changed(info.id, ctx.agents.get(info.id)?.session.header.parentSession, info.local ? void 0 : "*");
		});
		ctx.on("subagent/end", (info) => {
			this.activations.delete(info.runId);
			changed(info.id, info.local ? void 0 : "*");
		});
	}
	/**
	* One bounded observation; a changing or unreadable composition stays incomplete.
	*/
	async read(context, run, signal, excludeCallerTurn = false) {
		const unpublished = run.dispatch?.phase === "registered" || run.dispatch?.phase === "rejected";
		return this.readRoots(context, run.sessionId, /* @__PURE__ */ new Set([...unpublished ? [] : [run.sessionId], ...run.callerSessionId ? [run.callerSessionId] : []]), signal, excludeCallerTurn);
	}
	/** Observe work owned by the actual calling conversation.
	*/
	async caller(context, signal) {
		if (!context.callerSessionId) return {
			selected: empty(),
			others: empty()
		};
		return this.readRoots(context, context.callerSessionId, /* @__PURE__ */ new Set([context.callerSessionId]), signal, true);
	}
	/**
	* Observe exact work owners and retain incomplete discovery as unknown activity.
	*/
	async readRoots(context, selectedId, roots, signal, excludeCallerTurn) {
		const changes = /* @__PURE__ */ new Set(), selected = empty(), others = empty();
		const caller = excludeCallerTurn && context.callerRef ? this.resolveCaller(context.callerRef) : void 0;
		this.observers.add(changes);
		const jobs = this.ctx.get("jobs");
		let unsubscribe;
		try {
			const known = new Set(roots);
			const unknown = (reason, descriptor) => {
				others.complete = false;
				others.reasons.push(reason);
				(others.reasonMessages ??= []).push(descriptor);
			};
			if (!jobs) unknown("Native job observation is unavailable", { key: "reasonNativeJobObservationIsUnavailable" });
			else try {
				unsubscribe = jobs.events.subscribe({ owners: "all" }, (event) => {
					const owner = "job" in event ? event.job.owner : event.owner;
					if (owner) changes.add(owner);
				});
			} catch (error) {
				unknown(`Native job events unavailable: ${error instanceof Error ? error.message : String(error)}`, {
					key: "reasonNativeJobEventsUnavailableValue0",
					params: { value0: error instanceof Error ? error.message : String(error) }
				});
			}
			const runtime = this.ctx.get("subagents");
			for (const root of roots) {
				if (!runtime) {
					unknown("Native descendant discovery is unavailable", { key: "reasonNativeDescendantDiscoveryIsUnavailable" });
					continue;
				}
				try {
					for (const row of await runtime.listDescendants(brandString(root), signal)) {
						known.add(row.id);
						if (row.kind === "diagnostic") unknown(`${row.id}: ${row.reason}`, {
							key: "reasonValue0Value1",
							params: {
								value0: row.id,
								value1: row.reason
							}
						});
						else if (row.mode === "external" && ![...this.activations.values()].some((item) => item.sessionId === row.id)) unknown(`${row.id}: external execution state is not established`, {
							key: "reasonValue0ExternalExecutionStateIsNotEstablished",
							params: { value0: row.id }
						});
					}
				} catch (error) {
					unknown(`${root}: ${error instanceof Error ? error.message : String(error)}`, {
						key: "reasonValue0Value1",
						params: {
							value0: root,
							value1: error instanceof Error ? error.message : String(error)
						}
					});
				}
			}
			for (const id of known) {
				signal.throwIfAborted();
				const target = id === selectedId ? selected : others;
				const agent = this.ctx.agents.get(brandString(id));
				const ownTurn = excludeCallerTurn && id === context.callerSessionId && agent !== void 0 && agent === caller && agent.status !== "idle";
				if (agent && agent.status !== "idle" && !ownTurn) target.participants.push({
					sessionId: id,
					kind: "turn",
					id
				});
				if (this.pending.has(id)) target.participants.push({
					sessionId: id,
					kind: "start",
					id
				});
				if (this.initial.has(id) && !ownTurn) others.participants.push({
					sessionId: id,
					kind: "activation",
					id
				});
				for (const [activationId, activation] of this.activations) if (activation.sessionId === id && !ownTurn) others.participants.push({
					sessionId: id,
					kind: "activation",
					id: activationId
				});
				for (const job of jobs?.list(brandString(id)) ?? []) if (job.owner === id && (job.status === "running" || job.status === "stopping")) others.participants.push({
					sessionId: id,
					kind: "job",
					id: job.id
				});
			}
			if (changes.has("*") || [...known].some((id) => changes.has(id))) unknown("Related native work changed during discovery", { key: "reasonRelatedNativeWorkChangedDuringDiscovery" });
			if (identity(this.ctx.get("jobs")) !== identity(jobs)) unknown("Native job service changed during discovery", { key: "reasonNativeJobServiceChangedDuringDiscovery" });
			for (const value of [selected, others]) value.state = value.participants.length ? "active" : value.complete ? "inactive" : "unknown";
			return {
				selected,
				others
			};
		} finally {
			unsubscribe?.();
			this.observers.delete(changes);
		}
	}
};
//#endregion
//#region .build/host/dsh-integration/execution/conversations.js
/**
* FILE: plugin/src/dsh-integration/execution/conversations.ts
* DESCRIPTION: Observe the original native turn and exact linked messages
*/
const messageEvents = /* @__PURE__ */ new Set([
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"tool/ptc-dispatch",
	"agent/inbox/spliced",
	"turn/start",
	"turn/end",
	"step/start",
	"step/end"
]);
const reason = (error) => error instanceof Error ? error.message : String(error);
const json = (value) => JSON.parse(JSON.stringify(value));
/**
* Native identified message entry, rather than arbitrary text or the last turn, selects the turn.
*/
function messageTurn(events, messageId) {
	let start = -1;
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (event.type === "turn/start") start = index;
		if (event.type === "user/message" && event.data.id === messageId && start >= 0) {
			const turn = events[start];
			if (turn.type !== "turn/start") return void 0;
			const end = events.findIndex((item, position) => position > index && item.type === "turn/end" && item.data.turn === turn.data.turn);
			return {
				start,
				entry: index,
				end
			};
		}
		if (event.type === "turn/end") start = -1;
	}
}
/**
* Read immutable native conversation facts independently of publication and task acceptance.
*/
var NativeConversations = class {
	source;
	work;
	constructor(source, work) {
		this.source = source;
		this.work = work;
	}
	/**
	* Establish initial submission from the reserved conversation and exact original assignment, without creating work.
	*/
	async acceptedMessage(context, run, signal) {
		if (run.dispatch?.phase !== "submitting" || !run.promptSha256) return void 0;
		const cut = await this.source.read(context, run.sessionId, signal);
		if (run.executionBackend?.kind === "spawn-in-process" && cut.header.parentSession !== run.callerSessionId) throw withUiMessage(new OperationRefusal("state-conflict", "The native parent differs from the saved run link"), ownMessage({ key: "reasonTheNativeParentDiffersFromTheSavedRunLink" }));
		const initial = cut.events.flatMap((event) => event.type === "user/message" ? [event.data] : event.type === "agent/inbox/spliced" ? event.data.inserted : []).find((message) => message.source.kind === "user");
		if (!initial) return void 0;
		const assignment = initial.content[0];
		if (assignment?.type !== "text" || createHash("sha256").update(assignment.text).digest("hex") !== run.promptSha256) return void 0;
		const accepted = {
			...run,
			status: "running",
			dispatch: {
				phase: "accepted",
				messageId: initial.id,
				reason: null
			},
			initialTurn: {
				turn: null,
				messageId: initial.id
			}
		};
		try {
			return {
				messageId: initial.id,
				observation: await this.observe(context, accepted, signal, void 0, cut)
			};
		} catch (observationError) {
			return {
				messageId: initial.id,
				observationError
			};
		}
	}
	/** Assemble run and message observations from their exact native conversation sources.
	*/
	async observe(context, run, signal, messageRef, executorCut) {
		const value = {
			link: run,
			initialOutcome: {
				state: "unknown",
				reason: "The initial native turn is not established at this read boundary",
				reasonMessage: { key: "reasonTheInitialNativeTurnIsNotEstablishedAtThisReadBoundary" }
			},
			activity: await this.work.read(context, run, signal),
			availability: {
				executor: { state: "unavailable" },
				caller: run.callerSessionId ? { state: "unavailable" } : null
			},
			...messageRef ? { messageRef } : {},
			delivery: { state: "not-requested" },
			response: {
				state: "unknown",
				reason: "No message was selected",
				reasonMessage: { key: "reasonNoMessageWasSelected" }
			},
			result: null
		};
		const cuts = /* @__PURE__ */ new Map();
		if (run.dispatch?.phase === "rejected") value.initialOutcome = {
			state: "failed",
			reason: run.dispatch.reason ?? "Native execution was rejected before publication",
			reasonMessage: run.dispatch.reasonMessage ?? { key: "dispatchRejected" }
		};
		for (const [key, id] of [["executor", run.sessionId], ["caller", run.callerSessionId]]) {
			if (!id) continue;
			if (key === "executor" && (run.dispatch?.phase === "registered" || run.dispatch?.phase === "rejected")) {
				value.availability.executor = {
					state: "unavailable",
					reason: "The reserved executor identity was not published",
					reasonMessage: { key: "reasonTheReservedExecutorIdentityWasNotPublished" }
				};
				continue;
			}
			try {
				const cut = key === "executor" && executorCut ? executorCut : await this.source.read(context, id, signal);
				if (key === "executor" && run.executionBackend?.kind === "spawn-in-process" && cut.header.parentSession !== run.callerSessionId) throw withUiMessage(/* @__PURE__ */ new Error("The native parent differs from the saved run link"), ownMessage({ key: "reasonTheNativeParentDiffersFromTheSavedRunLink" }));
				cuts.set(id, cut);
				value.availability[key] = { state: "available" };
			} catch (error) {
				signal.throwIfAborted();
				value.availability[key] = {
					state: "unavailable",
					reason: reason(error),
					reasonMessage: messageOf(error) ?? externalMessage("sourceUnavailable", error)
				};
				if (key === "executor") value.activity.selected = {
					...value.activity.selected,
					state: value.activity.selected.state === "active" ? "active" : "unknown",
					complete: false,
					reasons: [...value.activity.selected.reasons, reason(error)]
				};
			}
		}
		const executor = cuts.get(run.sessionId);
		if (executor && !executor.events.some((event) => event.type === "turn/end")) value.initialOutcome = {
			state: "unknown",
			reason: "The observed conversation has no completed DSH turn",
			reasonMessage: { key: "reasonTheObservedConversationHasNoCompletedDSHTurn" },
			evidence: {
				kind: "no-turn-end",
				observedThrough: executor.upper
			}
		};
		const initialMessage = run.initialTurn?.messageId ?? run.dispatch?.messageId;
		if (executor && initialMessage) {
			const turn = messageTurn(executor.events, initialMessage);
			const end = turn && turn.end >= 0 ? executor.events[turn.end] : void 0;
			if (turn && end?.type === "turn/end") {
				const kind = end.data.reason.kind;
				const failure = end.data.reason.kind === "error" ? end.data.reason.error.message : `DSH turn ended: ${kind}`;
				value.initialOutcome = {
					state: kind === "completed" ? "completed" : ["interrupted", "aborted"].includes(kind) ? "interrupted" : "failed",
					...kind === "completed" ? {} : {
						reason: failure,
						reasonMessage: end.data.reason.kind === "error" ? externalMessage("runFailed", end.data.reason.error.message) : {
							key: "dshTurnEnded",
							params: { kind }
						}
					}
				};
				const events = executor.events.slice(turn.start, turn.end + 1);
				value.result = {
					content: json(finalAssistantOutput(events) ?? []),
					events: events.filter((event) => messageEvents.has(event.type)).map(json)
				};
			}
		}
		if (!messageRef) {
			value.delivery = run.callerSessionId ? {
				state: "unknown",
				reason: "The delivery of the initial result is not linked to a specific native notification",
				reasonMessage: { key: "reasonTheDeliveryOfTheInitialResultIsNotLinkedToASpecificNativeNotif" }
			} : { state: "not-requested" };
			return value;
		}
		const selected = messageRef;
		const cut = cuts.get(selected.sessionId);
		if (!cut) {
			value.delivery = {
				state: "unknown",
				messageId: selected.messageId,
				reason: "The original message source is unavailable",
				reasonMessage: { key: "reasonTheOriginalMessageSourceIsUnavailable" }
			};
			return value;
		}
		const inserted = cut.events.flatMap((event) => event.type === "agent/inbox/spliced" ? event.data.inserted : event.type === "user/message" ? [event.data] : []).find((message) => message.id === selected.messageId);
		if (!inserted) {
			value.delivery = {
				state: selected.messageId === run.dispatch?.messageId && run.dispatch.phase === "accepted" ? "accepted" : "unknown",
				messageId: selected.messageId,
				reason: "The selected input is not retained in the observed prefix",
				reasonMessage: { key: "reasonTheSelectedInputIsNotRetainedInTheObservedPrefix" }
			};
			value.response = {
				state: "unknown",
				reason: "The original input cannot be linked to a response",
				reasonMessage: { key: "reasonTheOriginalInputCannotBeLinkedToAResponse" }
			};
			return value;
		}
		const expectedSender = selected.sessionId === run.sessionId ? run.callerSessionId : run.sessionId;
		if ((inserted.source.kind === "agent-message" || inserted.source.kind === "subagent-settled") && inserted.source.senderSessionId !== expectedSender) throw withUiMessage(new OperationRefusal("state-conflict", "The native message sender does not match the saved conversation pair"), ownMessage({ key: "reasonTheNativeMessageSenderDoesNotMatchTheSavedConversationPair" }));
		value.delivery = {
			state: "accepted",
			messageId: selected.messageId,
			source: json(inserted.source)
		};
		const turn = messageTurn(cut.events, selected.messageId);
		if (!turn) value.response = { state: "not-observed" };
		else {
			const following = cut.events.slice(turn.entry + 1, turn.end >= 0 ? turn.end + 1 : void 0);
			const output = following.find((event) => event.type === "assistant/message" && event.data.message.content.some((block) => block.type === "text" && block.text.length > 0));
			value.response = following.some((event) => event.type === "user/message" && (!("form" in event.data.source) || event.data.source.form !== "snapshot") && (!output || event.seq < output.seq)) ? {
				state: "unknown",
				reason: "Another native input prevents linking later output to this exact message",
				reasonMessage: { key: "reasonAnotherNativeInputPreventsLinkingLaterOutputToThisExactMessage" }
			} : output ? {
				state: "observed",
				evidence: json({
					kind: "assistant-message-in-consumed-turn",
					inputMessageId: selected.messageId,
					event: output
				})
			} : following.some((event) => event.type === "assistant/message") ? {
				state: "unknown",
				reason: "Native control output does not establish a related answer",
				reasonMessage: { key: "reasonNativeControlOutputDoesNotEstablishARelatedAnswer" }
			} : { state: "not-observed" };
		}
		return value;
	}
};
//#endregion
//#region .build/host/dsh-integration/execution/session-reader.js
/**
* FILE: plugin/src/dsh-integration/execution/session-reader.ts
* DESCRIPTION: Lease one exact native conversation cut without publishing an agent
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
var NativeSessionReader = class {
	ctx;
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Read a consistent Session Query cut within an automatically released observation.
	*/
	async read(context, sessionId, signal) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			signal.throwIfAborted();
			const observation = __addDisposableResource(env_1, await this.ctx.sessionQuery.observeSession(brandString(sessionId), {
				signal,
				projectionMode: "all"
			}), false);
			if (observation.header.id !== sessionId || !observation.header.cwd || resolve(observation.header.cwd) !== resolve(context.projectRoot)) throw withUiMessage(new OperationRefusal("access-denied", "The conversation source does not belong to the original project"), ownMessage({ key: "reasonTheConversationSourceDoesNotBelongToTheOriginalProject" }));
			const events = observation.events;
			if ((events.at(-1)?.seq ?? -1) !== observation.cursor || observation.projections && observation.projections.asOfSeq !== observation.cursor) throw withUiMessage(/* @__PURE__ */ new Error("The native conversation cut is inconsistent"), ownMessage({ key: "reasonTheNativeConversationCutIsInconsistent" }));
			return {
				header: observation.header,
				events,
				upper: observation.cursor
			};
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
};
//#endregion
//#region .build/host/dsh-integration/execution/compose.js
/**
* FILE: plugin/src/dsh-integration/execution/compose.ts
* DESCRIPTION: Assemble execution ports and project-backed preparation for the compatible controller
*/
/**
* Connect shared launch and observation operations to their project and native owners.
*/
var ExecutionApplication = class {
	ctx;
	config;
	resolveModel;
	store;
	work;
	reader;
	runtime;
	constructor(ctx, config, track, resolveModel, caller) {
		this.ctx = ctx;
		this.config = config;
		this.resolveModel = resolveModel;
		this.store = createRunStore(ctx.fs, config.lockWaitMs);
		this.work = new NativeWorkObservation(ctx, caller);
		this.reader = new NativeConversations(new NativeSessionReader(ctx), this.work);
		this.runtime = new NativeExecutionRuntime(ctx, track, caller, this.work, (context, run) => this.settle(context, run));
	}
	/**
	* Admit task mutations using live work, excluding only the actual caller's current turn.
	*/
	isActive = async (run, context) => diagnosticOperation({ path: "src/dsh-integration/execution/compose.ts" }, {
		runId: run.id,
		sessionId: run.sessionId
	}, async () => {
		const cwd = context?.projectRoot ?? this.ctx.agents.get(run.sessionId)?.session?.header?.cwd;
		const call = context ?? {
			workspaceId: "",
			projectRoot: cwd ?? "",
			source: "panel",
			callId: "activity",
			callerSessionId: null,
			callerRef: null,
			permissions: {
				mode: "workspace-write",
				workspaceRoot: cwd ?? ""
			}
		};
		const observed = await this.work.read(call, run, new AbortController().signal, true);
		if (observed.selected.state === "active" || observed.others.state === "active") return true;
		if (observed.selected.state === "unknown" || observed.others.state === "unknown") throw withUiMessage(new OperationRefusal("dependency-unavailable", "Task work could not be completely observed"), ownMessage({ key: "reasonTaskWorkCouldNotBeCompletelyObserved" }));
		return false;
	});
	/** Check the caller's own and related work before a shared operation.
	*/
	async hasCallerActivity(context, signal) {
		return diagnosticOperation({ path: "src/dsh-integration/execution/compose.ts" }, {
			projectPath: context.projectRoot,
			sessionId: context.callerSessionId
		}, async () => {
			const work = await this.work.caller(context, signal);
			if (work.selected.state === "active" || work.others.state === "active") return true;
			if (!work.selected.complete || !work.others.complete) throw withUiMessage(new OperationRefusal("dependency-unavailable", "The calling conversation work could not be completely observed"), ownMessage({ key: "reasonTheCallingConversationWorkCouldNotBeCompletelyObserved" }));
			return false;
		});
	}
	/**
	* Recheck the actual current task without resolving or changing a model route.
	*/
	async currentState(context, taskId, stepId, signal) {
		const snapshot = await readTaskSnapshot(this.ctx.fs, context.projectRoot, signal);
		if (snapshot.kind !== "task" || snapshot.tasks[0]?.id !== taskId) throw withUiMessage(new OperationRefusal("state-conflict", "The current task changed or is ambiguous"), ownMessage({ key: "reasonTheCurrentTaskChangedOrIsAmbiguous" }));
		const state = await readTaskState(this.ctx.fs, context.projectRoot, taskId, signal);
		if (state.status !== "open" || currentStepOf(state) !== stepId || state.stepStates.find((step) => step.id === stepId)?.status !== "current") throw withUiMessage(new OperationRefusal("state-conflict", "Only the current running stage can start an executor"), ownMessage({ key: "reasonOnlyTheCurrentRunningStageCanStartAnExecutor" }));
		return state;
	}
	/** Assemble project-backed launch preparation and ports for the shared start operation.
	*/
	async start(context, taskId, stepId, attemptId, modelOverride, signal) {
		let originalAssignment;
		const currentAssignment = async () => {
			const state = await this.currentState(context, taskId, stepId, signal);
			if (modelOverride === null && originalAssignment) {
				const assigned = state.process.steps.find((step) => step.id === stepId).model;
				if (assigned.provider !== originalAssignment.provider || assigned.model !== originalAssignment.model || assigned.reasoningEffort !== originalAssignment.reasoningEffort) throw withUiMessage(new OperationRefusal("version-conflict", "The stage model assignment changed during launch preparation"), ownMessage({ key: "reasonTheStageModelAssignmentChangedDuringLaunchPreparation" }));
			}
			return state;
		};
		return startRun({
			store: this.store,
			runtime: this.runtime,
			reader: this.reader,
			validate: async (_context, _taskId, request, signal) => {
				const state = await currentAssignment();
				const step = state.process.steps.find((step) => step.id === request.stepId);
				if (state.status !== "open" || !step || currentStepOf(state) !== request.stepId || state.stepStates.find((step) => step.id === request.stepId)?.status !== "current") throw withUiMessage(new OperationRefusal("state-conflict", "Only the current running stage can start an executor"), ownMessage({ key: "reasonOnlyTheCurrentRunningStageCanStartAnExecutor" }));
				if (await this.hasCallerActivity(context, signal)) throw withUiMessage(new OperationRefusal("state-conflict", "An executor is already active for this task"), ownMessage({ key: "reasonAnExecutorIsAlreadyActiveForThisTask" }));
				for (const run of await readRuns(this.ctx.fs, context.projectRoot, taskId, signal)) if (await this.isActive(run, context)) throw withUiMessage(new OperationRefusal("state-conflict", "An executor is already active for this task"), ownMessage({ key: "reasonAnExecutorIsAlreadyActiveForThisTask" }));
				originalAssignment = structuredClone(request.modelOverride ?? step.model);
				return this.resolveModel(originalAssignment, signal);
			},
			validateDispatch: async (_context, _taskId, ownRun, signal) => {
				await currentAssignment();
				if (await this.hasCallerActivity(context, signal)) throw withUiMessage(new OperationRefusal("state-conflict", "An executor is already active for this task"), ownMessage({ key: "reasonAnExecutorIsAlreadyActiveForThisTask" }));
				for (const run of await readRuns(this.ctx.fs, context.projectRoot, taskId, signal)) if (run.id !== ownRun.id && await this.isActive(run, context)) throw withUiMessage(new OperationRefusal("state-conflict", "An executor is already active for this task"), ownMessage({ key: "reasonAnExecutorIsAlreadyActiveForThisTask" }));
			},
			prepare: async (_context, _taskId, attemptId, request, model, admission, signal) => {
				let promptWritePending = false;
				try {
					await inputPrompt(this.ctx.fs, context.projectRoot, taskId, stepId, signal, void 0, void 0, {
						submitting() {
							promptWritePending = true;
						},
						confirmed() {
							promptWritePending = false;
						}
					});
				} catch (error) {
					if (error instanceof OperationRefusal) throw error;
					if (error !== null && typeof error === "object" && "code" in error && ["FS_NOT_OBSERVED", "FS_STALE_VERSION"].includes(String(error.code))) throw new OperationRefusal("version-conflict", error instanceof Error ? error.message : String(error), { cause: error });
					if (promptWritePending) throw new OperationUncertainty(error instanceof Error ? error.message : String(error), {
						workspaceId: context.workspaceId,
						taskId,
						attemptId,
						operation: "material",
						path: `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`
					}, { cause: error });
					throw error;
				}
				const outputPath = `.aicraft/tasks/${taskId}/${stepId}`;
				const prompt = await readMaterial(this.ctx.fs, context.projectRoot, `${outputPath}/input-prompt.md`, signal);
				if (!prompt.text.trim()) throw withUiMessage(new OperationRefusal("invalid-input", `The saved prompt is empty. Edit and save ${outputPath}/input-prompt.md before starting an executor.`), ownMessage({
					key: "reasonTheSavedPromptIsEmptyEditAndSaveValue0InputPromptMdBeforeStart",
					params: { value0: outputPath }
				}));
				const state = await currentAssignment();
				const content = [{
					type: "text",
					text: prompt.text
				}];
				const processTarget = await targetFor(this.ctx.fs, context.projectRoot, `.aicraft/tasks/${taskId}/process.json`, signal);
				if (!await this.ctx.fs.stat(processTarget, signal)) {
					const processText = JSON.stringify(state.process, null, 2) + "\n";
					const processBytes = new TextEncoder().encode(processText);
					try {
						await diagnosticPublication(async () => {
							try {
								await this.ctx.fs.writeText(processTarget, processText, { kind: "createIfAbsent" }, signal, {
									mode: "workspace-write",
									workspaceRoot: context.projectRoot
								});
							} catch (error) {
								if (error !== null && typeof error === "object" && "code" in error && ["FS_NOT_OBSERVED", "FS_STALE_VERSION"].includes(String(error.code))) throw error;
								if (error !== null && typeof error === "object" && "code" in error && ["FS_PERMISSION_DENIED", "FS_SANDBOX_DENIED"].includes(String(error.code))) throw new OperationRefusal("access-denied", error instanceof Error ? error.message : String(error), { cause: error });
								try {
									const bytes = await this.ctx.fs.readBytes(processTarget, signal, processBytes.length + 1);
									if (bytes.length === processBytes.length && bytes.every((byte, index) => byte === processBytes[index])) return;
								} catch {}
								throw error;
							}
						}, processTarget, "writeText");
					} catch (error) {
						if (error instanceof OperationRefusal) throw error;
						if (error !== null && typeof error === "object" && "code" in error && ["FS_NOT_OBSERVED", "FS_STALE_VERSION"].includes(String(error.code))) throw new OperationRefusal("version-conflict", error instanceof Error ? error.message : String(error), { cause: error });
						throw new OperationUncertainty(error instanceof Error ? error.message : String(error), {
							workspaceId: context.workspaceId,
							taskId,
							attemptId,
							operation: "material",
							path: `.aicraft/tasks/${taskId}/process.json`
						}, { cause: error });
					}
				}
				const run = {
					id: `run-${randomUUID()}`,
					taskId,
					stepId,
					attemptId,
					callerSessionId: context.callerSessionId,
					sessionId: admission.sessionId,
					request,
					model,
					status: "starting",
					startedAt: (/* @__PURE__ */ new Date()).toISOString(),
					finishedAt: null,
					outputPath,
					error: null,
					dispatch: {
						phase: "registered",
						messageId: null,
						reason: null
					},
					initialTurn: {
						turn: null,
						messageId: null
					},
					promptVersion: prompt.version,
					promptSha256: createHash("sha256").update(prompt.text).digest("hex"),
					executionBackend: {
						kind: context.source === "agent" ? "spawn-in-process" : "standalone",
						providerName: context.source === "agent" ? "spawn" : null
					}
				};
				const stepIndex = state.process.steps.findIndex((step) => step.id === stepId);
				const step = state.process.steps[stepIndex];
				return {
					run,
					content,
					admission,
					sessionTitle: `${stepIndex + 1}. ${step.title}`
				};
			}
		}, context, taskId, attemptId, {
			stepId,
			modelOverride
		}, signal);
	}
	/** Connect the run store and native reader to the shared observation operation.
	*/
	observe(context, taskId, selector, signal, expectedWorkspaceId, messageRef) {
		return diagnosticOperation({ path: "src/dsh-integration/execution/compose.ts" }, {
			projectPath: context.projectRoot,
			taskId
		}, () => observeRun(this.store, this.reader, context, taskId, selector, signal, expectedWorkspaceId, messageRef));
	}
	/**
	* Persist established initial-turn outcomes; unreadable sources do not invent interruption.
	*/
	async settle(context, run, recovery = false, taskId = run.taskId) {
		const signal = new AbortController().signal;
		await this.store.transaction(context, taskId, signal, async (writer) => {
			const saved = (await writer.read()).find((item) => item.id === run.id);
			if (!saved || !["starting", "running"].includes(saved.status)) return;
			const observed = await this.reader.observe(context, saved, signal);
			if (observed.initialOutcome.state === "unknown") {
				if (!recovery || observed.availability.executor.state !== "available" || observed.activity.selected.state !== "inactive" || observed.initialOutcome.evidence?.kind !== "no-turn-end") return;
				await writer.save({
					...saved,
					status: "interrupted",
					finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
					error: "The saved run has no completed DSH turn",
					errorMessage: { key: "reasonTheSavedRunHasNoCompletedDSHTurn" }
				});
			} else await writer.save({
				...saved,
				status: observed.initialOutcome.state,
				finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
				error: observed.initialOutcome.reason ?? null,
				errorMessage: observed.initialOutcome.reasonMessage
			});
		});
	}
	/** Reconcile saved launches and persist established recovery outcomes through settle.
	*/
	async reconcile(cwd) {
		this.runtime.reconcileResources();
		const signal = new AbortController().signal, snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal);
		if (snapshot.kind !== "task") return;
		const context = {
			workspaceId: "",
			projectRoot: cwd,
			source: "panel",
			callId: "reconcile",
			callerSessionId: null,
			callerRef: null,
			permissions: {
				mode: "workspace-write",
				workspaceRoot: cwd
			}
		};
		for (const task of snapshot.tasks) for (const run of await readRuns(this.ctx.fs, cwd, task.id, signal)) if (["starting", "running"].includes(run.status)) await this.settle(context, run, true, task.id);
	}
};
//#endregion
//#region .build/host/step-execution/runs.js
/** Await native activity providers before admitting a task mutation.
* START_METHOD_hasActiveRun
*/
async function hasActiveRun(runs, isActive) {
	return diagnosticOperation({
		path: "src/step-execution/runs.ts",
		method: "hasActiveRun"
	}, {}, async () => {
		for (const run of runs) if (await isActive(run)) return true;
		return false;
	});
}
/** Compatible construction boundary; execution rules and operations use consumer-owned ports. */
var RunController = class extends ExecutionApplication {
	constructor(ctx, config, track, resolveModel, caller = () => void 0) {
		super(ctx, config, track, resolveModel, caller);
	}
};
//#endregion
//#region .build/host/step-execution/models.js
/**
* FILE: plugin/src/step-execution/models.ts
* DESCRIPTION: Save task step model assignments after native validation
*/
/**
* START_METHOD_setStepModel
* Persist a task-specific model assignment without changing project templates.
*/
async function setStepModel(fs, waitMs, isActive, cwd, taskId, stepId, input, signal, resolveModel) {
	return diagnosticOperation({
		path: "src/step-execution/models.ts",
		method: "setStepModel"
	}, {
		projectPath: cwd,
		taskId,
		stepId
	}, async () => {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId) || !/^[a-z][a-z0-9-]*$/.test(stepId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Invalid task or step ID"), ownMessage({ key: "reasonInvalidTaskOrStepID" })));
		const model = validate(modelAssignmentSchema, input);
		await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal);
		await withFileLock(join(cwd, ".aicraft"), async () => {
			const snapshot = await readTaskSnapshot(fs, cwd, signal);
			if (snapshot.kind !== "task" || snapshot.tasks[0]?.id !== taskId) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Only the open, unambiguous task can be changed"), ownMessage({ key: "reasonOnlyTheOpenUnambiguousTaskCanBeChanged" })));
			const path = `.aicraft/tasks/${taskId}/process.json`;
			const target = await targetFor(fs, cwd, path, signal);
			const info = await fs.lstat(path, { cwd }, signal);
			if (info && info.type !== "file") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Task process must be a regular file"), ownMessage({ key: "reasonTaskProcessMustBeARegularFile" })));
			const version = info ? (await fs.stat(target, signal))?.version : void 0;
			if (info && !version) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Task process changed while loading; refresh before saving"), ownMessage({ key: "reasonTaskProcessChangedWhileLoadingRefreshBeforeSaving" })));
			const state = {
				...await readTaskState(fs, cwd, taskId, signal),
				runs: await readRuns(fs, cwd, taskId, signal)
			};
			if (await hasActiveRun(state.runs, isActive)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Wait for the task executor before changing its model"), ownMessage({ key: "reasonWaitForTheTaskExecutorBeforeChangingItsModel" })));
			const step = state.process.steps.find((step) => step.id === stepId);
			if (!step) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Step is missing from the task process"), ownMessage({ key: "reasonStepIsMissingFromTheTaskProcess" })));
			await resolveModel(model, signal);
			step.model = model;
			await diagnosticPublication(() => fs.writeText(target, JSON.stringify(state.process, null, 2) + "\n", info ? {
				kind: "replaceIfVersion",
				version
			} : { kind: "createIfAbsent" }, signal, {
				mode: "workspace-write",
				workspaceRoot: cwd
			}), target, "writeText");
		}, { waitMs });
	});
}
//#endregion
//#region .build/host/task-management/creation-result.js
/**
* FILE: plugin/src/task-management/creation-result.ts
* DESCRIPTION: Identify a proven refusal before task publication
*/
/** A refusal of this attempt; another writer's task may already exist. */
var TaskCreationRefusal = class extends Error {
	taskIdentifier;
	outcome = "not-created";
	constructor(taskIdentifier, cause) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.taskIdentifier = taskIdentifier;
		this.name = "TaskCreationRefusal";
	}
};
//#endregion
//#region .build/host/task-management/commands.js
/**
* FILE: plugin/src/task-management/commands.ts
* DESCRIPTION: Apply explicit task creation and lifecycle commands
*/
/**
* START_METHOD_createTask
* Create one task after rechecking project restrictions under a writer lock.
* @param fs - DSH filesystem.
* @param subprocess - Git command provider.
* @param cwd - Canonical local project directory.
* @param request - Developer requirements and selected process.
* @param config - Operation limits.
* @param signal - Caller cancellation.
* @returns Confirmation of the published task, without a second read.
*/
async function createTask(fs, subprocess, cwd, request, config, signal, readProject) {
	return diagnosticOperation({
		path: "src/task-management/commands.ts",
		method: "createTask"
	}, { projectPath: cwd }, async () => {
		let operationError;
		let publicationStarted = false;
		let confirmation;
		try {
			const input = validate(requestSchema, request);
			return await withFileLock(join(cwd, ".aicraft"), async () => {
				try {
					signal.throwIfAborted();
					const id = input.taskIdentifier;
					const destination = await targetFor(fs, cwd, `.aicraft/tasks/${id}`, signal);
					if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Task directory "${id}" already exists. Choose another Task ID.`), ownMessage({
						key: "reasonTaskDirectoryValue0AlreadyExistsChooseAnotherTaskID",
						params: { value0: id }
					})));
					const before = await readProject(fs, subprocess, cwd, config, signal);
					if (before.creationIssue) throw diagnosticRejection(withUiMessage(new Error(before.creationIssue), before.creationIssueMessage ?? { key: "creationBlocked" }));
					if (!before.processes.some((item) => item.id === input.processId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("The selected process does not exist"), ownMessage({ key: "reasonTheSelectedProcessDoesNotExist" })));
					const route = await readProcessForTask(fs, cwd, input.processId, signal);
					diagnosticAccepted({
						...input,
						taskId: id
					});
					const staging = `tasks/.creating-${randomUUID()}`;
					const stagingPath = join(cwd, ".aicraft", staging);
					const prepared = {
						taskIdentifier: id,
						title: input.title,
						initialState: {
							status: "open",
							stepStates: route.steps.map((step, index) => ({
								id: step.id,
								status: index === 0 ? "current" : "pending"
							}))
						}
					};
					try {
						await createText(fs, cwd, `${staging}/request.md`, `${input.requestText}\n`, signal);
						for (const step of route.steps) await createText(fs, cwd, `${staging}/${step.id}/.gitkeep`, "", signal);
						await createText(fs, cwd, `${staging}/process.json`, JSON.stringify(route, null, 2) + "\n", signal);
						await createText(fs, cwd, `${staging}/state.json`, serializeState({
							taskType: input.processId,
							taskIdentifier: id,
							taskTitle: input.title,
							status: "open",
							...before.branch ? { createdBranch: before.branch } : {},
							stepStates: prepared.initialState.stepStates
						}), signal);
						signal.throwIfAborted();
						if (await fs.lstat(`.aicraft/tasks/${id}`, { cwd }, signal)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error(`Task directory "${id}" already exists. Choose another Task ID.`), ownMessage({
							key: "reasonTaskDirectoryValue0AlreadyExistsChooseAnotherTaskID",
							params: { value0: id }
						})));
						const publishedPath = fs.processPath(destination);
						await diagnosticPublication(async () => {
							publicationStarted = true;
							await rename(stagingPath, publishedPath);
							confirmation = prepared;
						}, publishedPath, "rename");
					} catch (error) {
						try {
							await diagnosticPublication(() => rm(stagingPath, {
								recursive: true,
								force: true
							}), stagingPath, "rm");
						} catch (cleanupError) {
							diagnosticEvent("task.creation-cleanup-failed", { error: cleanupError instanceof Error ? {
								name: cleanupError.name,
								message: cleanupError.message,
								stack: cleanupError.stack
							} : { message: String(cleanupError) } });
							throw new AggregateError([error, cleanupError], error instanceof Error ? error.message : String(error), { cause: error });
						}
						throw error;
					}
					return prepared;
				} catch (error) {
					operationError = error;
					throw error;
				}
			}, { waitMs: config.lockWaitMs });
		} catch (error) {
			if (confirmation) {
				diagnosticEvent("task.creation-lock-release-failed", { error: error instanceof Error ? {
					name: error.name,
					message: error.message,
					stack: error.stack
				} : { message: String(error) } });
				return confirmation;
			}
			const failure = operationError && operationError !== error ? new AggregateError([operationError, error], operationError instanceof Error ? operationError.message : String(operationError), { cause: operationError }) : error;
			if (!publicationStarted) throw diagnosticRejection(new TaskCreationRefusal(request.taskIdentifier, failure));
			throw failure;
		}
	});
}
/**
* START_METHOD_updateTask
* Apply one explicit task command; preserve process and all stage materials.
* @param fs - DSH filesystem provider.
* @param subprocess - Git command provider.
* @param cwd - Canonical project directory.
* @param taskId - Exact open task identity from the caller's view.
* @param operation - Stage selection, completion, or separate task closure.
* @param stepId - Stage identity for goto/return/complete/skip; null for closure.
* @param config - Operation limits.
* @param signal - Caller cancellation.
* @param fromStepId - Source stage for an explicit return.
* @param isActive - Shared executor check including live native chat continuations.
* @returns Updated project state.
*/
async function updateTask(fs, subprocess, cwd, taskId, operation, stepId, config, signal, fromStepId, isActive, readProject, progress, callerActivity, expected) {
	return diagnosticOperation({
		path: "src/task-management/commands.ts",
		method: "updateTask"
	}, {
		projectPath: cwd,
		taskId,
		stepId
	}, async () => {
		validate(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), taskId);
		return withFileLock(join(cwd, ".aicraft"), async () => {
			signal.throwIfAborted();
			const before = await readProject(fs, subprocess, cwd, config, signal);
			if (operation === "reopen") {
				if (before.task.kind !== "empty") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Finish the open task before reopening another task; refresh if the project is invalid or ambiguous"), ownMessage({ key: "reasonFinishTheOpenTaskBeforeReopeningAnotherTaskRefreshIfTheProject" })));
				if (!before.task.allTasks.some((task) => task.id === taskId && task.status !== "open")) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "The closed task was not found"), ownMessage({ key: "reasonTheClosedTaskWasNotFound" })));
				if (await hasActiveRun(before.task.allTasks.flatMap((task) => task.runs), isActive)) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Wait for the active executor to finish before reopening a task"), ownMessage({ key: "reasonWaitForTheActiveExecutorToFinishBeforeReopeningATask" })));
			} else if (before.task.kind !== "task" || before.task.tasks[0]?.id !== taskId) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "The current task changed or is ambiguous; refresh the project"), ownMessage({ key: "reasonTheCurrentTaskChangedOrIsAmbiguousRefreshTheProject" })));
			const target = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/state.json`, signal);
			const info = await fs.stat(target, signal);
			if (!info || info.type !== "file") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "The task state file is missing"), ownMessage({ key: "reasonTheTaskStateFileIsMissing" })));
			const state = {
				...await readTaskState(fs, cwd, taskId, signal),
				runs: await readRuns(fs, cwd, taskId, signal)
			};
			progress?.lastConfirmed?.({
				taskId,
				status: state.status,
				currentStep: state.stepStates.find((step) => step.status === "current")?.id ?? null
			});
			if (expected && actualCurrentStep(state) !== expected.expectedStep) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "The current stage changed from expectedStep; the original request was not applied"), ownMessage({ key: "reasonTheCurrentStageChangedFromExpectedStepTheOriginalRequestWasNot" })));
			if (operation !== "reopen" && state.status !== "open") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "The task is already closed"), ownMessage({ key: "reasonTheTaskIsAlreadyClosed" })));
			if (await callerActivity?.()) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Wait for the active executor to finish before changing the task"), ownMessage({ key: "reasonWaitForTheActiveExecutorToFinishBeforeChangingTheTask" })));
			if (await hasActiveRun(state.runs, isActive)) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Wait for the active executor to finish before changing the task"), ownMessage({ key: "reasonWaitForTheActiveExecutorToFinishBeforeChangingTheTask" })));
			const current = currentStepOf(state);
			if (operation === "reopen") state.status = "open";
			else if (operation === "close") state.status = "completed";
			else {
				const targetIndex = state.process.steps.findIndex((step) => step.id === stepId);
				if (targetIndex < 0 || stepId === null) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "The requested step is not in the saved process"), ownMessage({ key: "reasonTheRequestedStepIsNotInTheSavedProcess" })));
				const selected = state.stepStates.find((step) => step.id === stepId);
				if (selected.status === "cancelled" && ["goto", "return"].includes(operation)) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Cancelled steps cannot be selected"), ownMessage({ key: "reasonCancelledStepsCannotBeSelected" })));
				if (operation === "return") {
					if (fromStepId !== current || state.stepStates.find((step) => step.id === fromStepId)?.status !== "current") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Only the current running step can return to an earlier step"), ownMessage({ key: "reasonOnlyTheCurrentRunningStepCanReturnToAnEarlierStep" })));
					const steps = before.task.tasks[0].steps;
					const fromIndex = steps.findIndex((step) => step.id === fromStepId);
					const excluded = (index) => index < 0 || steps[index].status === "cancelled";
					if (excluded(fromIndex) || excluded(targetIndex) || targetIndex >= fromIndex) throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Return requires an earlier step that is not cancelled"), ownMessage({ key: "reasonReturnRequiresAnEarlierStepThatIsNotCancelled" })));
				}
				if (operation === "goto") {
					for (const step of state.stepStates) if (step.status === "current") step.status = "pending";
					selected.status = "current";
				} else if (operation === "complete" || operation === "skip") {
					if (current !== stepId || state.stepStates.find((step) => step.id === stepId)?.status !== "current") throw diagnosticRejection(withUiMessage(new OperationRefusal("state-conflict", "Only the current running step can be completed or skipped"), ownMessage({ key: "reasonOnlyTheCurrentRunningStepCanBeCompletedOrSkipped" })));
					state.stepStates.find((step) => step.id === stepId).status = operation === "complete" ? "done" : "skipped";
					const next = state.process.steps.slice(targetIndex + 1).find((step) => state.stepStates.find((item) => item.id === step.id)?.status === "pending");
					if (next) state.stepStates.find((step) => step.id === next.id).status = "current";
				} else if (operation === "return") {
					for (const [index, step] of state.process.steps.entries()) {
						const previous = state.stepStates.find((item) => item.id === step.id);
						if (previous.status === "cancelled" || previous.status === "skipped") continue;
						if (index > targetIndex || previous.status === "current") previous.status = "pending";
					}
					state.stepStates.find((step) => step.id === stepId).status = "current";
				}
			}
			if (operation !== "reopen") {
				const processTarget = await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal);
				if (!await fs.stat(processTarget, signal)) {
					const processText = JSON.stringify(state.process, null, 2) + "\n";
					const processBytes = new TextEncoder().encode(processText);
					progress?.submitting();
					await diagnosticPublication(async () => {
						try {
							await fs.writeText(processTarget, processText, { kind: "createIfAbsent" }, signal, {
								mode: "workspace-write",
								workspaceRoot: cwd
							});
						} catch (error) {
							if (error !== null && typeof error === "object" && "code" in error && [
								"FS_STALE_VERSION",
								"FS_NOT_OBSERVED",
								"FS_PERMISSION_DENIED",
								"FS_SANDBOX_DENIED"
							].includes(String(error.code))) throw error;
							try {
								const bytes = await fs.readBytes(processTarget, signal, processBytes.length + 1);
								if (bytes.length === processBytes.length && bytes.every((byte, index) => byte === processBytes[index])) return;
							} catch {}
							throw error;
						}
					}, processTarget, "writeText");
				}
			}
			progress?.submitting();
			const text = serializeState(state);
			const prepared = new TextEncoder().encode(text);
			await diagnosticPublication(async () => {
				try {
					await fs.writeText(target, text, {
						kind: "replaceIfVersion",
						version: info.version
					}, signal, {
						mode: "workspace-write",
						workspaceRoot: cwd
					});
				} catch (error) {
					if (error !== null && typeof error === "object" && "code" in error && [
						"FS_STALE_VERSION",
						"FS_NOT_OBSERVED",
						"FS_PERMISSION_DENIED",
						"FS_SANDBOX_DENIED"
					].includes(String(error.code))) throw error;
					try {
						const bytes = await fs.readBytes(target, signal, prepared.length + 1);
						if (bytes.length === prepared.length && bytes.every((byte, index) => byte === prepared[index])) return;
					} catch {}
					throw error;
				}
			}, target, "writeText");
			progress?.confirmed({
				taskId,
				operation,
				status: state.status,
				stepStates: state.stepStates.map((step) => ({ ...step }))
			});
			return readProject(fs, subprocess, cwd, config, signal);
		}, { waitMs: config.lockWaitMs });
	});
}
async function createText(fs, cwd, path, content, signal) {
	const target = await targetFor(fs, cwd, `.aicraft/${path}`, signal);
	await fs.writeText(target, content, { kind: "createIfAbsent" }, signal, {
		mode: "workspace-write",
		workspaceRoot: cwd
	});
}
//#endregion
//#region .build/host/work-materials/cleanup.js
/**
* FILE: plugin/src/work-materials/cleanup.ts
* DESCRIPTION: Delete confirmed step outputs while preserving prompt and task records
*/
/**
* START_METHOD_deleteStepMaterials
* Clear only the selected step's files, keeping task state and executor history.
*/
async function deleteStepMaterials(fs, waitMs, isActive, cwd, taskId, stepId, signal) {
	return diagnosticOperation({
		path: "src/work-materials/cleanup.ts",
		method: "deleteStepMaterials"
	}, {
		projectPath: cwd,
		taskId,
		stepId
	}, async () => {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId) || !/^[a-z][a-z0-9-]*$/.test(stepId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Invalid task or step ID"), ownMessage({ key: "reasonInvalidTaskOrStepID" })));
		await targetFor(fs, cwd, `.aicraft/tasks/${taskId}/${stepId}`, signal);
		await withFileLock(join(cwd, ".aicraft"), async () => {
			signal.throwIfAborted();
			const snapshot = await readTaskSnapshot(fs, cwd, signal);
			if (snapshot.kind !== "task" || snapshot.tasks[0]?.id !== taskId) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Only the open, unambiguous task can be changed"), ownMessage({ key: "reasonOnlyTheOpenUnambiguousTaskCanBeChanged" })));
			const state = {
				...await readTaskState(fs, cwd, taskId, signal),
				runs: await readRuns(fs, cwd, taskId, signal)
			};
			if (!state.process.steps.some((step) => step.id === stepId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Step is missing from the task process"), ownMessage({ key: "reasonStepIsMissingFromTheTaskProcess" })));
			if (await hasActiveRun(state.runs, isActive)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Stop the task executor before deleting step artifacts"), ownMessage({ key: "reasonStopTheTaskExecutorBeforeDeletingStepArtifacts" })));
			const path = `.aicraft/tasks/${taskId}/${stepId}`;
			const target = await targetFor(fs, cwd, path, signal);
			const info = await fs.lstat(path, { cwd }, signal);
			if (!info) return;
			if (info.type !== "directory") throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Step artifacts must be a regular directory"), ownMessage({ key: "reasonStepArtifactsMustBeARegularDirectory" })));
			const hostPath = fileURLToPath(fs.fileUrl(target));
			if (fs.processPathFromHostPath(hostPath) !== fs.processPath(target)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("This filesystem does not support local artifact deletion"), ownMessage({ key: "reasonThisFilesystemDoesNotSupportLocalArtifactDeletion" })));
			for (const name of await readdir(hostPath)) {
				if (name === ".gitkeep" || name === "input-prompt.md") continue;
				signal.throwIfAborted();
				await diagnosticPublication(() => rm(join(hostPath, name), { recursive: true }), join(hostPath, name), "rm");
			}
		}, { waitMs });
	});
}
//#endregion
//#region .build/host/dsh-integration/project-context.js
/**
* FILE: plugin/src/dsh-integration/project-context.ts
* DESCRIPTION: Resolve registered workspaces and session-owned project paths
*/
/**
* START_METHOD_resolveProject
* resolveProject operation.
*/
function resolveProject(ctx, workspaceId) {
	const workspace = ctx.workspaceRegistry.get(brandString(workspaceId));
	if (!workspace) throw withUiMessage(/* @__PURE__ */ new Error("The selected project is no longer registered in DSH"), ownMessage({ key: "reasonTheSelectedProjectIsNoLongerRegisteredInDSH" }));
	const cwd = ctx.fs.processPathFromHostPath(workspace.path);
	if (cwd === void 0) throw withUiMessage(/* @__PURE__ */ new Error("The filesystem provider cannot read this project"), ownMessage({ key: "reasonTheFilesystemProviderCannotReadThisProject" }));
	return cwd;
}
/**
* START_METHOD_workspaceForAgent
* Resolve a registered project for an agent's actual working directory.
* @param cwd - Session-owned directory, never a model argument.
* @returns The matching Workspace identity.
*/
function workspaceForAgent(ctx, cwd) {
	const workspace = ctx.workspaceRegistry.list().find((item) => resolve(item.path) === resolve(cwd));
	if (!workspace) throw withUiMessage(/* @__PURE__ */ new Error("The session directory is not a registered DSH project"), ownMessage({ key: "reasonTheSessionDirectoryIsNotARegisteredDSHProject" }));
	return workspace.id;
}
//#endregion
//#region .build/host/dsh-integration/git.js
/**
* FILE: plugin/src/dsh-integration/git.ts
* DESCRIPTION: Read optional Git branch and worktree metadata
*/
/**
* Read complete optional Git metadata without inventing a branch on truncated output.
*/
async function git(subprocess, cwd, args, config, signal) {
	const executable = await subprocess.resolveExecutable("git");
	const runSignal = AbortSignal.any([signal, AbortSignal.timeout(config.gitTimeoutMs)]);
	const handle = subprocess.spawn({
		argv: [executable, ...args],
		cwd,
		signal: runSignal,
		graceMs: config.gitGraceMs,
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 32768 },
			stderr: { maxBytes: 32768 }
		}
	});
	const outcome = await handle.done;
	runSignal.throwIfAborted();
	if (outcome.exitCode !== 0) return null;
	const output = handle.collected.stdout?.readFrom(0);
	if (!output || output.lossy) throw withUiMessage(/* @__PURE__ */ new Error("Could not read complete Git output"), ownMessage({ key: "reasonCouldNotReadCompleteGitOutput" }));
	return output.text.trim();
}
/**
* START_METHOD_gitDirectory
* Per-worktree metadata directory; HEAD lives here even when .git is a file.
*/
async function gitDirectory(subprocess, cwd, config, signal) {
	try {
		return await git(subprocess, cwd, ["rev-parse", "--absolute-git-dir"], config, signal);
	} catch {
		signal.throwIfAborted();
		return null;
	}
}
/**
* START_METHOD_currentBranch
* Read the branch as a reminder; missing Git never blocks project operations.
*/
async function currentBranch(subprocess, cwd, config, signal) {
	try {
		return await git(subprocess, cwd, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD"
		], config, signal);
	} catch {
		signal.throwIfAborted();
		return null;
	}
}
//#endregion
//#region .build/host/dsh-integration/project-view.js
/**
* FILE: plugin/src/dsh-integration/project-view.ts
* DESCRIPTION: Compose project readiness, task data, history and material counts
*/
/**
* START_METHOD_readProject
* Read preparation, current branch, process choices and the current task.
* @param fs - DSH filesystem.
* @param subprocess - DSH process provider for read-only Git commands.
* @param cwd - Canonical local project directory.
* @param config - Operation limits.
* @param signal - Caller cancellation.
* @returns Project readiness and task state.
*/
async function readProject(fs, subprocess, cwd, config, signal) {
	return diagnosticOperation({
		path: "src/dsh-integration/project-view.ts",
		method: "readProject"
	}, { projectPath: cwd }, async () => {
		const task = await readTaskView(fs, cwd, signal);
		const branch = await currentBranch(subprocess, cwd, config, signal);
		const result = {
			...await readProjectReadiness(fs, cwd, signal, task.kind === "empty"),
			branch,
			executionIssue: null,
			task
		};
		if (task.kind === "task") {
			const current = task.tasks[0];
			const step = current.steps.find((item) => item.id === current.currentStep);
			if (step) try {
				await readExecutionInputs(fs, cwd, current.id, step.role, signal);
			} catch (error) {
				signal.throwIfAborted();
				result.executionIssue = error instanceof Error ? error.message : String(error);
				result.executionIssueMessage = messageOf(error) ?? externalMessage("executionInputsUnavailable", error);
			}
		}
		return result;
	});
}
/**
* Add history and material counts, projecting owner-reported issues to the panel's text format.
*/
async function readTaskView(fs, cwd, signal) {
	const snapshot = await readTaskSnapshot(fs, cwd, signal, false);
	const allTasks = [];
	const issues = snapshot.issues.map((issue) => issue.message);
	const issueMessages = snapshot.issues.map((issue) => issue.uiMessage ?? externalMessage("invalidTaskState", issue.message));
	for (const task of snapshot.allTasks) try {
		const runs = await readRuns(fs, cwd, task.id, signal);
		const steps = await Promise.all(task.steps.map(async (step) => ({
			...step,
			...await artifactSummary(fs, cwd, `.aicraft/tasks/${task.id}/${step.id}`, signal)
		})));
		allTasks.push({
			...task,
			runs,
			steps
		});
	} catch (error) {
		signal.throwIfAborted();
		issues.push(`.aicraft/tasks/${task.id}/state.json: ${error instanceof Error ? error.message : String(error)}`);
		const descriptor = messageOf(error);
		const path = `.aicraft/tasks/${task.id}/state.json`;
		issueMessages.push(descriptor ? {
			...descriptor,
			details: [path, ...descriptor.details ?? []]
		} : {
			key: "taskReadFailed",
			params: { path },
			details: [error instanceof Error ? error.message : String(error)]
		});
	}
	const tasks = allTasks.filter((task) => task.status === "open");
	return {
		kind: issues.length ? "invalid" : tasks.length === 0 ? "empty" : tasks.length === 1 ? "task" : "ambiguous",
		tasks: issues.length ? [] : tasks,
		allTasks,
		issues,
		issueMessages
	};
}
//#endregion
//#region .build/host/dsh-integration/project-watch.js
/**
* FILE: plugin/src/dsh-integration/project-watch.ts
* DESCRIPTION: Watch project files and native executor activity with owned cleanup
*/
/** One bounded invalidation queue and directory-watch tree per visible project. */
var ProjectWatch = class {
	ctx;
	config;
	owners = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		ctx.effect(() => async () => {
			const owners = [...this.owners];
			for (const [owner] of owners) owner.abort();
			await Promise.all(owners.map(([, close]) => close()));
		}, "aicraft: project watches");
	}
	/**
	* START_METHOD_ProjectWatch.follow
	* follow operation.
	*/
	async *follow(cwd, taskId, caller) {
		yield* diagnosticStream({
			path: "src/dsh-integration/project-watch.ts",
			method: "ProjectWatch.follow"
		}, {
			projectPath: cwd,
			taskId
		}, async function* () {
			if (taskId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("Invalid task identifier"), ownMessage({ key: "reasonInvalidTaskIdentifier" })));
			const owner = new AbortController(), signal = AbortSignal.any([caller, owner.signal]);
			const watches = /* @__PURE__ */ new Map();
			const previousEntries = /* @__PURE__ */ new Map();
			const dirty = /* @__PURE__ */ new Set(), paths = /* @__PURE__ */ new Set(), sessions = /* @__PURE__ */ new Map();
			const nativeActivity = /* @__PURE__ */ new Map();
			let initializing = true;
			let knownSessions = /* @__PURE__ */ new Set(), failure, wake;
			let timer, gitRoot = null;
			let cleanup;
			const finish = () => cleanup ??= (async () => {
				clearTimeout(timer);
				wake?.();
				await Promise.all([...watches.values()].map((watch) => watch.close()));
				watches.clear();
			})();
			this.owners.set(owner, finish);
			const cancel = () => {
				finish().catch((error) => {
					failure = error;
				});
			};
			signal.addEventListener("abort", cancel, { once: true });
			const notify = () => {
				if (timer === void 0) timer = setTimeout(() => {
					timer = void 0;
					wake?.();
					wake = void 0;
				}, 200);
			};
			const changed = (directory, error) => {
				if (signal.aborted) return;
				if (error) failure = error;
				dirty.add(directory);
				notify();
			};
			const relevant = (path) => path === ".aicraft" || path.startsWith(".aicraft/") || path === ".git" || path === "$git/HEAD" || path === "$git/commondir";
			const descend = (path) => path === ".aicraft" || path === ".aicraft/config" || path.startsWith(".aicraft/config/") || path === ".aicraft/tasks" || /^\.aicraft\/tasks\/[^/]+$/.test(path) || taskId !== null && path.startsWith(`.aicraft/tasks/${taskId}/`) || path === ".aicraft/knowledge-base";
			const drop = async (path, remember = false) => {
				if (!remember) {
					for (const name of previousEntries.keys()) if (name === path || name.startsWith(path + "/")) previousEntries.delete(name);
				}
				for (const [name, watch] of [...watches]) if (name === path || name.startsWith(path + "/")) {
					if (remember) previousEntries.set(name, watch.entries);
					else previousEntries.delete(name);
					watches.delete(name);
					await watch.close();
				}
			};
			const sync = async (directory, initial = false, depth = 0) => {
				signal.throwIfAborted();
				if (depth > 24) return;
				const path = directory === "$git" ? gitRoot : directory || ".";
				if ((await this.ctx.fs.lstat(path, { cwd }, signal))?.type !== "directory") {
					await drop(directory);
					return;
				}
				const target = await this.ctx.fs.resolve(path, {
					cwd,
					signal
				});
				if (directory !== "$git") {
					const root = await this.ctx.fs.resolve(cwd, { signal });
					if (!this.ctx.fs.contains(root, target)) throw diagnosticRejection(withUiMessage(/* @__PURE__ */ new Error("AICraft watch directory is outside the project"), ownMessage({ key: "reasonAICraftWatchDirectoryIsOutsideTheProject" })));
				}
				let watch = watches.get(directory);
				if (!watch) {
					const close = await this.ctx.fs.watch(target, (error) => changed(directory, error), signal);
					if (signal.aborted) {
						await close();
						return;
					}
					watch = {
						close,
						entries: previousEntries.get(directory) ?? /* @__PURE__ */ new Map()
					};
					previousEntries.delete(directory);
					watches.set(directory, watch);
				}
				const entries = /* @__PURE__ */ new Map(), children = [];
				for (const entry of await this.ctx.fs.listDir(target, signal)) {
					if (directory === ".aicraft/knowledge-base") {
						const child = `${directory}/${entry.name}`;
						const metadata = await this.ctx.fs.lstat(child, { cwd }, signal);
						if (isKnowledgeFile(entry.name, metadata?.type)) entries.set(child, String(metadata.version));
						continue;
					}
					if (entry.name.startsWith(".creating-") || entry.name.endsWith(".lock") || entry.name === ".gitkeep") continue;
					const child = directory ? `${directory}/${entry.name}` : entry.name;
					if (!relevant(child) || directory === "$git" && !["HEAD", "commondir"].includes(entry.name)) continue;
					const metadata = await this.ctx.fs.lstat(directory === "$git" ? `${gitRoot}/${entry.name}` : child, { cwd }, signal);
					if (!metadata || metadata.type === "symlink" || metadata.type === "other") continue;
					entries.set(child, metadata.type === "directory" ? `directory:${metadata.version}` : String(metadata.version));
					if (metadata.type === "directory" && descend(child)) children.push(child);
				}
				if (!initial) {
					for (const name of /* @__PURE__ */ new Set([...watch.entries.keys(), ...entries.keys()])) if (watch.entries.get(name) !== entries.get(name)) {
						const wasDirectory = watch.entries.get(name)?.startsWith("directory:");
						const isDirectory = entries.get(name)?.startsWith("directory:");
						if (wasDirectory && isDirectory) {
							await drop(name, true);
							if (name === ".aicraft/knowledge-base") paths.add(name);
						} else {
							paths.add(name);
							if (wasDirectory) await drop(name);
						}
					}
				}
				watch.entries = entries;
				for (const child of children) if (!watches.has(child)) await sync(child, initial, depth + 1);
			};
			const activities = async () => {
				if (taskId === null) {
					knownSessions.clear();
					initializing = false;
					return [];
				}
				if (!await this.ctx.fs.lstat(`.aicraft/tasks/${taskId}/state.json`, { cwd }, signal)) {
					knownSessions.clear();
					return [];
				}
				await readTaskState(this.ctx.fs, cwd, taskId, signal);
				const runs = await readRuns(this.ctx.fs, cwd, taskId, signal);
				knownSessions = new Set(runs.map((run) => run.sessionId));
				initializing = false;
				return runs.map((run) => {
					const agent = this.ctx.agents.get(brandString(run.sessionId));
					return nativeActivity.get(run.sessionId) ?? {
						id: run.sessionId,
						running: agent ? agent.status !== "idle" : ["starting", "running"].includes(run.status),
						revision: String(agent?.session.seq ?? run.finishedAt ?? run.startedAt)
					};
				});
			};
			const off = this.ctx.on("session/event", (session, event) => {
				if (taskId === null || !knownSessions.has(session.id) && !nativeActivity.has(session.id) && !(initializing && session.header.cwd === cwd) || !["turn/start", "turn/end"].includes(event.type)) return;
				const activity = {
					id: session.id,
					running: event.type === "turn/start",
					revision: String(event.seq + 1)
				};
				nativeActivity.set(session.id, activity);
				sessions.set(session.id, activity);
				notify();
			});
			signal.addEventListener("abort", off, { once: true });
			try {
				await sync("", true);
				gitRoot = await gitDirectory(this.ctx.subprocess, cwd, this.config, signal);
				if (gitRoot) await sync("$git", true);
				yield {
					kind: "ready",
					paths: [],
					counts: [],
					sessions: await activities()
				};
				while (!signal.aborted) {
					if (timer !== void 0 || !dirty.size && !sessions.size && !failure) await new Promise((resolve) => {
						wake = resolve;
						if (signal.aborted) resolve();
					});
					signal.throwIfAborted();
					if (failure) throw failure;
					const directories = [...dirty].sort((a, b) => a.length - b.length);
					dirty.clear();
					for (const directory of directories) if (watches.has(directory)) await sync(directory);
					if ([...paths].some((path) => path === ".git" || path.startsWith(".git/"))) {
						await drop("$git");
						gitRoot = await gitDirectory(this.ctx.subprocess, cwd, this.config, signal);
						if (gitRoot) await sync("$git", true);
						paths.add("$git/HEAD");
					}
					const changedPaths = [...paths];
					paths.clear();
					if (changedPaths.some((path) => path.endsWith("/runs.json"))) {
						for (const activity of await activities()) if (!sessions.has(activity.id)) sessions.set(activity.id, activity);
					}
					const counts = [];
					const stepIds = new Set(changedPaths.map((path) => path.match(/^\.aicraft\/tasks\/([^/]+)\/([^/]+)(?:\/|$)/)).filter((match) => match && match[1] === taskId && !match[2].includes(".")).map((match) => match[2]));
					for (const stepId of stepIds) {
						const summary = await artifactSummary(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/${stepId}`, signal);
						counts.push({
							taskId,
							stepId,
							count: summary.artifactCount,
							issue: summary.artifactIssue,
							...summary.artifactIssueMessage ? { issueMessage: summary.artifactIssueMessage } : {}
						});
					}
					const activity = [...sessions.values()].filter((item) => knownSessions.has(item.id));
					sessions.clear();
					if (changedPaths.length || activity.length) yield {
						kind: "change",
						paths: changedPaths,
						counts,
						sessions: activity,
						...changedPaths.some((path) => path.startsWith("$git/")) ? { branch: await currentBranch(this.ctx.subprocess, cwd, this.config, signal) } : {}
					};
				}
			} finally {
				owner.abort();
				off();
				signal.removeEventListener("abort", off);
				signal.removeEventListener("abort", cancel);
				try {
					await finish();
				} finally {
					this.owners.delete(owner);
				}
			}
		}.bind(this));
	}
};
//#endregion
//#region .build/host/dsh-integration/presentation-errors.js
/**
* FILE: plugin/src/dsh-integration/presentation-errors.ts
* DESCRIPTION: Preserve owner-provided message descriptors through native Remote failures
*/
/**
* Retain native codes and payloads; serialize metadata only for an explicitly described own error.
*/
function presentationFailure(error) {
	const uiMessage = messageOf(error);
	if (!uiMessage) return error;
	const existing = remoteErrorOf(error);
	if (existing) return new RemoteError(existing.code, existing.message, {
		...existing.details,
		uiMessage
	}, { cause: error });
	return new RemoteError("gateway/internal", error instanceof Error ? error.message : String(error), { uiMessage }, { cause: error });
}
/** Adapt unary and stream errors without changing inputs, values, cancellation or publication semantics.
*/
function presentationErrors(method, _context) {
	return function(...args) {
		try {
			const value = method.apply(this, args);
			if (value instanceof Promise) return value.catch((error) => {
				throw presentationFailure(error);
			});
			if (value && typeof value === "object" && Symbol.asyncIterator in value) return (async function* () {
				try {
					yield* value;
				} catch (error) {
					throw presentationFailure(error);
				}
			})();
			return value;
		} catch (error) {
			throw presentationFailure(error);
		}
	};
}
//#endregion
//#region .build/host/dsh-integration/service.js
/**
* FILE: plugin/src/dsh-integration/service.ts
* DESCRIPTION: Route shared panel and agent operations to domain owners
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Server operations shared by the AICraft panel and actual agent callers.
*/
let AicraftService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _changes_decorators;
	let _status_decorators;
	let _projects_decorators;
	let _task_decorators;
	let _statistics_decorators;
	let _project_decorators;
	let _materials_decorators;
	let _material_decorators;
	let _projectRules_decorators;
	let _saveMaterial_decorators;
	let _setStepModel_decorators;
	let _deleteStepMaterials_decorators;
	let _settings_decorators;
	let _saveProcess_decorators;
	let _saveRole_decorators;
	let _deleteRole_decorators;
	let _stepPrompt_decorators;
	let _defaultStepPrompt_decorators;
	let _startStep_decorators;
	let _run_decorators;
	let _prepare_decorators;
	let _createTask_decorators;
	let _completeStep_decorators;
	let _goToStep_decorators;
	let _returnStep_decorators;
	let _skipStep_decorators;
	let _closeTask_decorators;
	let _reopenTask_decorators;
	return class AicraftService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_changes_decorators = [Remote({ mode: "stream" }), presentationErrors];
			_status_decorators = [Remote, presentationErrors];
			_projects_decorators = [Remote, presentationErrors];
			_task_decorators = [Remote, presentationErrors];
			_statistics_decorators = [Remote, presentationErrors];
			_project_decorators = [Remote, presentationErrors];
			_materials_decorators = [Remote, presentationErrors];
			_material_decorators = [Remote, presentationErrors];
			_projectRules_decorators = [Remote, presentationErrors];
			_saveMaterial_decorators = [Remote, presentationErrors];
			_setStepModel_decorators = [Remote, presentationErrors];
			_deleteStepMaterials_decorators = [Remote, presentationErrors];
			_settings_decorators = [Remote, presentationErrors];
			_saveProcess_decorators = [Remote, presentationErrors];
			_saveRole_decorators = [Remote, presentationErrors];
			_deleteRole_decorators = [Remote, presentationErrors];
			_stepPrompt_decorators = [Remote, presentationErrors];
			_defaultStepPrompt_decorators = [Remote, presentationErrors];
			_startStep_decorators = [Remote, presentationErrors];
			_run_decorators = [Remote, presentationErrors];
			_prepare_decorators = [Remote, presentationErrors];
			_createTask_decorators = [Remote, presentationErrors];
			_completeStep_decorators = [Remote, presentationErrors];
			_goToStep_decorators = [Remote, presentationErrors];
			_returnStep_decorators = [Remote, presentationErrors];
			_skipStep_decorators = [Remote, presentationErrors];
			_closeTask_decorators = [Remote, presentationErrors];
			_reopenTask_decorators = [Remote, presentationErrors];
			__esDecorate(this, null, _changes_decorators, {
				kind: "method",
				name: "changes",
				static: false,
				private: false,
				access: {
					has: (obj) => "changes" in obj,
					get: (obj) => obj.changes
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _status_decorators, {
				kind: "method",
				name: "status",
				static: false,
				private: false,
				access: {
					has: (obj) => "status" in obj,
					get: (obj) => obj.status
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _projects_decorators, {
				kind: "method",
				name: "projects",
				static: false,
				private: false,
				access: {
					has: (obj) => "projects" in obj,
					get: (obj) => obj.projects
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _task_decorators, {
				kind: "method",
				name: "task",
				static: false,
				private: false,
				access: {
					has: (obj) => "task" in obj,
					get: (obj) => obj.task
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _statistics_decorators, {
				kind: "method",
				name: "statistics",
				static: false,
				private: false,
				access: {
					has: (obj) => "statistics" in obj,
					get: (obj) => obj.statistics
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _project_decorators, {
				kind: "method",
				name: "project",
				static: false,
				private: false,
				access: {
					has: (obj) => "project" in obj,
					get: (obj) => obj.project
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _materials_decorators, {
				kind: "method",
				name: "materials",
				static: false,
				private: false,
				access: {
					has: (obj) => "materials" in obj,
					get: (obj) => obj.materials
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _material_decorators, {
				kind: "method",
				name: "material",
				static: false,
				private: false,
				access: {
					has: (obj) => "material" in obj,
					get: (obj) => obj.material
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _projectRules_decorators, {
				kind: "method",
				name: "projectRules",
				static: false,
				private: false,
				access: {
					has: (obj) => "projectRules" in obj,
					get: (obj) => obj.projectRules
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveMaterial_decorators, {
				kind: "method",
				name: "saveMaterial",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveMaterial" in obj,
					get: (obj) => obj.saveMaterial
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setStepModel_decorators, {
				kind: "method",
				name: "setStepModel",
				static: false,
				private: false,
				access: {
					has: (obj) => "setStepModel" in obj,
					get: (obj) => obj.setStepModel
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteStepMaterials_decorators, {
				kind: "method",
				name: "deleteStepMaterials",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteStepMaterials" in obj,
					get: (obj) => obj.deleteStepMaterials
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _settings_decorators, {
				kind: "method",
				name: "settings",
				static: false,
				private: false,
				access: {
					has: (obj) => "settings" in obj,
					get: (obj) => obj.settings
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveProcess_decorators, {
				kind: "method",
				name: "saveProcess",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveProcess" in obj,
					get: (obj) => obj.saveProcess
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveRole_decorators, {
				kind: "method",
				name: "saveRole",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveRole" in obj,
					get: (obj) => obj.saveRole
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteRole_decorators, {
				kind: "method",
				name: "deleteRole",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteRole" in obj,
					get: (obj) => obj.deleteRole
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _stepPrompt_decorators, {
				kind: "method",
				name: "stepPrompt",
				static: false,
				private: false,
				access: {
					has: (obj) => "stepPrompt" in obj,
					get: (obj) => obj.stepPrompt
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _defaultStepPrompt_decorators, {
				kind: "method",
				name: "defaultStepPrompt",
				static: false,
				private: false,
				access: {
					has: (obj) => "defaultStepPrompt" in obj,
					get: (obj) => obj.defaultStepPrompt
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _startStep_decorators, {
				kind: "method",
				name: "startStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "startStep" in obj,
					get: (obj) => obj.startStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _run_decorators, {
				kind: "method",
				name: "run",
				static: false,
				private: false,
				access: {
					has: (obj) => "run" in obj,
					get: (obj) => obj.run
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _prepare_decorators, {
				kind: "method",
				name: "prepare",
				static: false,
				private: false,
				access: {
					has: (obj) => "prepare" in obj,
					get: (obj) => obj.prepare
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createTask_decorators, {
				kind: "method",
				name: "createTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "createTask" in obj,
					get: (obj) => obj.createTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _completeStep_decorators, {
				kind: "method",
				name: "completeStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "completeStep" in obj,
					get: (obj) => obj.completeStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _goToStep_decorators, {
				kind: "method",
				name: "goToStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "goToStep" in obj,
					get: (obj) => obj.goToStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _returnStep_decorators, {
				kind: "method",
				name: "returnStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "returnStep" in obj,
					get: (obj) => obj.returnStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _skipStep_decorators, {
				kind: "method",
				name: "skipStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "skipStep" in obj,
					get: (obj) => obj.skipStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _closeTask_decorators, {
				kind: "method",
				name: "closeTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "closeTask" in obj,
					get: (obj) => obj.closeTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _reopenTask_decorators, {
				kind: "method",
				name: "reopenTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "reopenTask" in obj,
					get: (obj) => obj.reopenTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		config = __runInitializers(this, _instanceExtraInitializers);
		/** Project identity and filesystem operations are provided by DSH. */
		static inject = [
			"workspaceRegistry",
			"fs",
			"subprocess",
			"agents",
			"agentPresets",
			"sessionQuery",
			"sessionTitle",
			"llm",
			"sessionProjections"
		];
		runs;
		statisticsController;
		projectWatch;
		callers = /* @__PURE__ */ new WeakMap();
		/**
		* @param ctx - Owning Cordis plugin context.
		* @param config - Validated operation limits.
		*/
		constructor(ctx, config) {
			super(ctx, "aicraft");
			this.config = config;
			this.statisticsController = new StatisticsController(ctx, config.lockWaitMs);
			this.runs = new RunController(ctx, config, (agent) => this.statisticsController.track(agent), (model, signal) => resolveModel(ctx, model, signal), (ref) => this.callers.get(ref));
			this.projectWatch = new ProjectWatch(ctx, config);
		}
		/** Publish operations only after the owned accounting registration is ready.
		*/
		async [Service.init]() {
			await this.statisticsController.ready;
		}
		/**
		* START_METHOD_AicraftService.changes
		* One event-driven project subscription, independent of the selected chat.
		*/
		changes(workspaceId, taskId, signal) {
			return this.projectWatch.follow(this.projectPath(workspaceId), taskId, signal);
		}
		/**
		* START_METHOD_AicraftService.status
		* Confirm that the AICraft server service is reachable.
		* @returns The stable connection status.
		*/
		status() {
			return "connected";
		}
		/**
		* START_METHOD_AicraftService.projects
		* Inspect project directories for icons in the workspace picker.
		* @param signal - Caller cancellation.
		* @returns Presence information for every registered workspace.
		*/
		projects(signal) {
			return Promise.all(this.ctx.workspaceRegistry.list().map(async (workspace) => ({
				workspaceId: workspace.id,
				hasAicraft: await hasAicraftProject(this.ctx.fs, this.projectPath(workspace.id), signal)
			})));
		}
		/**
		* START_METHOD_AicraftService.task
		* Read task state for an explicitly selected DSH project.
		* @param workspaceId - Registered DSH Workspace identity, never an arbitrary path.
		* @param signal - Caller cancellation injected by Remote API.
		* @returns The project's current task snapshot.
		*/
		async task(workspaceId, signal) {
			return diagnosticOperation({
				path: "src/dsh-integration/service.ts",
				method: "AicraftService.task"
			}, { workspaceId }, async () => {
				return readTaskView(this.ctx.fs, this.projectPath(workspaceId), signal);
			});
		}
		/**
		* START_METHOD_AicraftService.statistics
		* Fetch derived task or executor-tree statistics separately from project/UI loading.
		*/
		statistics(workspaceId, taskId, sessionId, signal) {
			return this.statisticsController.read(this.projectPath(workspaceId), taskId, sessionId, signal);
		}
		projectPath(workspaceId) {
			return resolveProject(this.ctx, workspaceId);
		}
		/**
		* Keep actual caller identity and the common outcome in the existing diagnostic channel.
		*/
		forCall(context, execute, subject = {}) {
			return diagnosticContext({
				workspaceId: context.workspaceId,
				projectPath: context.projectRoot,
				callId: context.callId,
				callerSessionId: context.callerSessionId,
				taskId: void 0,
				stepId: void 0,
				runId: void 0,
				sessionId: void 0,
				...subject
			}, () => diagnosticOperation({ path: "src/dsh-integration/service.ts" }, {}, async () => {
				const result = await execute();
				if (typeof result === "object" && result !== null && "operationStatus" in result) {
					const value = result;
					diagnosticEvent("operation.result", {
						outcome: value.operationStatus,
						...value.problem ? { problem: value.problem } : {},
						...value.refreshIssue ? { refreshIssue: value.refreshIssue } : {}
					});
				}
				return result;
			}));
		}
		/** Expose the shared material catalog through the common read result.
		*/
		materialsForCall(context, taskId, signal) {
			return this.forCall(context, async () => {
				return readResult(context, () => this.materials(context.workspaceId, taskId, signal).catch((error) => {
					throw error instanceof RemoteError && error.cause ? error.cause : error;
				}));
			}, { taskId: taskId ?? void 0 });
		}
		/** Expose document reading through the common read result.
		*/
		materialForCall(context, path, signal) {
			return this.forCall(context, async () => {
				return readResult(context, () => this.material(context.workspaceId, path, signal).catch((error) => {
					throw error instanceof RemoteError && error.cause ? error.cause : error;
				}));
			}, {});
		}
		/** Build trusted references from the actual tool execution, never model parameters.
		*/
		contextForAgent(workspaceId, agent, callId, standing) {
			const projectRoot = this.projectPath(workspaceId);
			if (!agent.session.header.cwd || resolve(agent.session.header.cwd) !== resolve(projectRoot) || resolve(standing.workspaceRoot) !== resolve(projectRoot)) throw withUiMessage(new OperationRefusal("access-denied", "The actual caller and standing policy must belong to the registered project"), ownMessage({ key: "reasonTheActualCallerAndStandingPolicyMustBelongToTheRegisteredProje" }));
			const callerRef = {};
			this.callers.set(callerRef, agent);
			return {
				workspaceId,
				projectRoot,
				source: "agent",
				callId,
				callerSessionId: agent.session.id,
				callerRef,
				permissions: {
					mode: standing.mode,
					workspaceRoot: standing.workspaceRoot
				}
			};
		}
		/**
		* Build trusted panel context for the registered project without inventing a caller session.
		*/
		panelContext(workspaceId) {
			const projectRoot = this.projectPath(workspaceId);
			return {
				workspaceId,
				projectRoot,
				source: "panel",
				callId: randomUUID(),
				callerSessionId: null,
				callerRef: null,
				permissions: {
					mode: "workspace-write",
					workspaceRoot: projectRoot
				}
			};
		}
		/**
		* Select only a fully read, unambiguous open task without history or material projections.
		*/
		async openTaskForAgent(context, signal, allowEmpty = false) {
			const snapshot = await readTaskSnapshot(this.ctx.fs, context.projectRoot, signal, false);
			if (snapshot.issues.length) {
				const issue = [
					"access-denied",
					"dependency-unavailable",
					"state-conflict"
				].flatMap((code) => snapshot.issues.filter((issue) => issue.code === code))[0];
				throw new OperationRefusal(issue.code, snapshot.issues.map((issue) => issue.message).join("; "), { cause: new AggregateError(snapshot.issues.map((issue) => issue.cause), issue.message) });
			}
			if (snapshot.kind === "ambiguous" || snapshot.kind === "invalid") throw withUiMessage(new OperationRefusal("state-conflict", "The open task is ambiguous or invalid"), ownMessage({ key: "reasonTheOpenTaskIsAmbiguousOrInvalid" }));
			const task = snapshot.tasks[0];
			if (!task && !allowEmpty) throw withUiMessage(new OperationRefusal("not-found", "No task is open in the calling project"), ownMessage({ key: "reasonNoTaskIsOpenInTheCallingProject" }));
			return task;
		}
		/**
		* Read the actual current stage; the panel's last-done selection is irrelevant.
		*/
		stepForAgent(context, signal) {
			return this.forCall(context, () => readResult(context, async () => (await this.openTaskForAgent(context, signal)).steps.find((step) => step.status === "current")?.id ?? null));
		}
		/**
		* Read the unchanged framework description from its settings owner.
		*/
		readHelpDescription() {
			return aicraftIntroduction;
		}
		/**
		* Read the mandatory explanation independently of task or execution state.
		*/
		readHelpResultNotes() {
			return agentResultNotes;
		}
		/**
		* Return fresh help for the trusted actual caller without reading or admitting task work.
		*/
		helpForAgent(context, catalog, signal) {
			return this.forCall(context, () => readResult(context, async () => {
				signal.throwIfAborted();
				const agent = context.callerRef && this.callers.get(context.callerRef);
				if (!agent || agent.session.id !== context.callerSessionId) throw withUiMessage(new OperationRefusal("access-denied", "AICraft help requires the actual calling agent"), ownMessage({ key: "reasonAICraftHelpRequiresTheActualCallingAgent" }));
				const result = readAgentHelp(() => this.readHelpDescription(), () => catalog(agent), () => this.readHelpResultNotes());
				signal.throwIfAborted();
				return result;
			}));
		}
		/** The same task-state owner serves panel and actual agent callers.
		*/
		changeTask(context, taskId, operation, stepId, signal, fromStepId, expected) {
			return this.forCall(context, async () => {
				return mutationResult(context, {
					workspaceId: context.workspaceId,
					taskId,
					operation: "task"
				}, (progress) => updateTask(this.ctx.fs, this.ctx.subprocess, context.projectRoot, taskId, operation, stepId, this.config, signal, fromStepId, (run) => this.runs.isActive(run, context), readProject, progress, () => this.runs.hasCallerActivity(context, signal), expected));
			}, {
				taskId,
				stepId: stepId ?? void 0
			});
		}
		/**
		* START_METHOD_AicraftService.project
		* Read project readiness, process choices, current branch and task state.
		* @param workspaceId - Registered DSH project identity.
		* @param signal - Caller cancellation.
		* @returns Project state suitable for creation controls.
		*/
		async project(workspaceId, signal) {
			return diagnosticOperation({
				path: "src/dsh-integration/service.ts",
				method: "AicraftService.project"
			}, { workspaceId }, async () => {
				const cwd = this.projectPath(workspaceId);
				await this.runs.reconcile(cwd);
				return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal);
			});
		}
		/**
		* Read the open task ID and all saved stages with their actual states.
		*/
		projectForAgent(context, signal) {
			return this.forCall(context, () => readResult(context, async () => {
				const task = await this.openTaskForAgent(context, signal, true);
				return {
					openTaskId: task?.id ?? null,
					steps: task?.steps.map((step) => ({
						id: step.id,
						description: step.description ?? `Execute the assignment for stage '${step.id}' using role '${step.role}'.`,
						status: step.status
					})) ?? []
				};
			}));
		}
		/**
		* Apply a guarded agent transition through the common task owner and original selected task.
		*/
		async moveStepForAgent(context, action, expectedStep, targetStep, signal) {
			return this.forCall(context, async () => {
				const selected = await readResult(context, async () => {
					if (![
						"complete",
						"skip",
						"goto",
						"return"
					].includes(action) || action !== "goto" && expectedStep === null || (["goto", "return"].includes(action) ? !targetStep : targetStep !== void 0)) throw withUiMessage(new OperationRefusal("invalid-input", "expectedStep and targetStep do not match the selected action"), ownMessage({ key: "reasonExpectedStepAndTargetStepDoNotMatchTheSelectedAction" }));
					return await this.openTaskForAgent(context, signal);
				});
				if (selected.operationStatus !== "confirmed") return selected;
				return this.changeTask(context, selected.value.id, action, action === "complete" || action === "skip" ? expectedStep : targetStep, signal, action === "return" ? expectedStep : void 0, { expectedStep });
			});
		}
		/**
		* Resolve the open task once before the shared owner rechecks its identity under lock.
		*/
		async closeTaskForAgent(context, signal) {
			return this.forCall(context, async () => {
				const selected = await readResult(context, async () => await this.openTaskForAgent(context, signal));
				if (selected.operationStatus !== "confirmed") return selected;
				return this.changeTask(context, selected.value.id, "close", null, signal);
			});
		}
		/**
		* START_METHOD_AicraftService.materials
		* List documents in the selected project, independently of the chat session.
		*/
		materials(workspaceId, taskId, signal) {
			return listMaterials(this.ctx.fs, this.projectPath(workspaceId), taskId, signal);
		}
		/**
		* START_METHOD_AicraftService.material
		* Read one project material without modifying it.
		*/
		async material(workspaceId, path, signal) {
			return diagnosticOperation({
				path: "src/dsh-integration/service.ts",
				method: "AicraftService.material"
			}, { workspaceId }, async () => {
				const cwd = this.projectPath(workspaceId);
				const document = await readMaterial(this.ctx.fs, cwd, path, signal);
				const snapshot = await readTaskView(this.ctx.fs, cwd, signal);
				return {
					...document,
					readOnly: snapshot.kind === "ambiguous"
				};
			});
		}
		/**
		* START_METHOD_AicraftService.projectRules
		* Open shared project rules, adopting the current filename on explicit request.
		*/
		projectRules(workspaceId, signal) {
			return openProjectRules(this.ctx.fs, this.projectPath(workspaceId), this.config.lockWaitMs, signal);
		}
		/**
		* START_METHOD_AicraftService.saveMaterial
		* Save existing Markdown with an optimistic file version guard.
		*/
		saveMaterial(workspaceId, path, text, version, signal) {
			const context = this.panelContext(workspaceId);
			return this.saveMaterialForCall(context, path, text, version, signal);
		}
		/** Connect versioned material saving to the common mutation result.
		*/
		saveMaterialForCall(context, path, text, version, signal) {
			return this.forCall(context, async () => {
				return mutationResult(context, {
					workspaceId: context.workspaceId,
					taskId: "",
					operation: "material",
					path
				}, (progress) => saveMaterial(this.ctx.fs, context.projectRoot, path, text, version, this.config.lockWaitMs, signal, progress));
			}, {});
		}
		/**
		* START_METHOD_AicraftService.setStepModel
		* Save the model used by subsequent runs of this task step.
		*/
		async setStepModel(workspaceId, taskId, stepId, model, signal) {
			return diagnosticOperation({
				path: "src/dsh-integration/service.ts",
				method: "AicraftService.setStepModel"
			}, {
				workspaceId,
				taskId,
				stepId
			}, async () => {
				const cwd = this.projectPath(workspaceId);
				await setStepModel(this.ctx.fs, this.config.lockWaitMs, this.runs.isActive, cwd, taskId, stepId, model, signal, (model, signal) => resolveModel(this.ctx, model, signal));
				return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal);
			});
		}
		/**
		* START_METHOD_AicraftService.deleteStepMaterials
		* Delete step outputs only after the panel's explicit confirmation.
		*/
		async deleteStepMaterials(workspaceId, taskId, stepId, signal) {
			return diagnosticOperation({
				path: "src/dsh-integration/service.ts",
				method: "AicraftService.deleteStepMaterials"
			}, {
				workspaceId,
				taskId,
				stepId
			}, async () => {
				const cwd = this.projectPath(workspaceId);
				await deleteStepMaterials(this.ctx.fs, this.config.lockWaitMs, this.runs.isActive, cwd, taskId, stepId, signal);
				return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal);
			});
		}
		/**
		* START_METHOD_AicraftService.settings
		* Read editable project process templates and available roles.
		*/
		settings(workspaceId, signal) {
			return readSettings(this.ctx.fs, this.projectPath(workspaceId), signal);
		}
		/**
		* START_METHOD_AicraftService.saveProcess
		* Persist a project process template without changing existing tasks.
		*/
		saveProcess(workspaceId, id, definition, version, templateLanguage, signal) {
			return saveProcess(this.ctx.fs, this.projectPath(workspaceId), id, definition, version, this.config.lockWaitMs, signal, templateLanguage);
		}
		/**
		* START_METHOD_AicraftService.saveRole
		* Save project role instructions without replacing stale edits.
		*/
		saveRole(workspaceId, id, text, version, signal) {
			return saveRole(this.ctx.fs, this.projectPath(workspaceId), id, text, version, this.config.lockWaitMs, signal);
		}
		/**
		* START_METHOD_AicraftService.deleteRole
		* Remove the selected role instruction after version and access checks.
		*/
		deleteRole(workspaceId, id, version, signal) {
			return deleteRole(this.ctx.fs, this.projectPath(workspaceId), id, version, this.config.lockWaitMs, signal);
		}
		/**
		* START_METHOD_AicraftService.stepPrompt
		* Read or create the editable step prompt, preserving the owner's publication outcome at the Remote boundary.
		*/
		async stepPrompt(workspaceId, taskId, stepId, signal) {
			const context = this.panelContext(workspaceId);
			const path = `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`;
			const result = await mutationResult(context, {
				workspaceId,
				taskId,
				operation: "material",
				path
			}, async (progress) => {
				const text = await openStepPrompt(this.ctx.fs, this.config.lockWaitMs, context.projectRoot, taskId, stepId, signal, void 0, {
					submitting: () => progress.submitting(),
					confirmed: (document) => progress.confirmed(document.text),
					lastConfirmed: (state) => progress.lastConfirmed?.(state)
				});
				progress.confirmed(text);
			});
			if (result.operationStatus === "confirmed") return result.value;
			throw new RemoteError("aicraft/prompt-not-confirmed", result.operationStatus === "unknown" ? `${result.problem.message} Outcome unknown. Check the original assignment at ${path}; do not repeat the change.` : result.problem.message, result);
		}
		/**
		* START_METHOD_AicraftService.defaultStepPrompt
		* Generate default editor text without saving; preserve the loaded file version.
		*/
		defaultStepPrompt(workspaceId, taskId, stepId, version, signal) {
			return defaultStepPrompt(this.ctx.fs, this.config.lockWaitMs, this.projectPath(workspaceId), taskId, stepId, version, signal);
		}
		/**
		* START_METHOD_AicraftService.startStep
		* Launch the current stage in a new independent session.
		* @param workspaceId - Registered project identity.
		* @param taskId - Current task identity.
		* @param stepId - Current running stage.
		* @param model - Optional per-run model override.
		* @param signal - Creation cancellation.
		* @returns Durable executor link, without accepting the stage.
		*/
		startStep(workspaceId, taskId, stepId, model, attemptId, signal) {
			return this.runs.start(this.panelContext(workspaceId), taskId, stepId, attemptId, model, signal);
		}
		/**
		* START_METHOD_AicraftService.startStepForAgent
		* Authorized agent entry; the executor inherits standing permissions, not a one-call grant.
		*/
		async startStepForAgent(context, expectedStep, attemptId, signal) {
			return this.forCall(context, async () => {
				const selected = await readResult(context, async () => await this.openTaskForAgent(context, signal));
				if (selected.operationStatus !== "confirmed") return selected;
				return this.forCall(context, () => this.runs.start(context, selected.value.id, expectedStep, attemptId, null, signal), {
					taskId: selected.value.id,
					stepId: expectedStep
				});
			});
		}
		/** Read one attempt without reconciliation or execution.
		*/
		run(workspaceId, taskId, runId, attemptId, expectedWorkspaceId, messageRef, signal) {
			return this.observeRunForCall(this.panelContext(workspaceId), taskId, runId, attemptId, expectedWorkspaceId, messageRef, signal);
		}
		/** Route either transport to the shared saved-attempt observation.
		*/
		observeRunForCall(context, taskId, runId, attemptId, expectedWorkspaceId, messageRef, signal) {
			return this.forCall(context, async () => {
				return this.runs.observe(context, taskId, {
					...runId === null ? {} : { runId },
					...attemptId === null ? {} : { attemptId }
				}, signal, expectedWorkspaceId ?? void 0, messageRef ?? void 0);
			}, {
				taskId,
				runId: runId ?? void 0
			});
		}
		/**
		* Read one original attempt of the selected open task without choosing a later run.
		*/
		async checkRunForAgent(context, runId, attemptId, signal) {
			return this.forCall(context, async () => {
				const selected = await readResult(context, async () => {
					if (runId === void 0 === (attemptId === void 0)) throw withUiMessage(new OperationRefusal("invalid-input", "Specify exactly one runId or attemptId"), ownMessage({ key: "reasonSpecifyExactlyOneRunIdOrAttemptId" }));
					return await this.openTaskForAgent(context, signal);
				});
				if (selected.operationStatus !== "confirmed") return selected;
				const result = await this.observeRunForCall(context, selected.value.id, runId ?? null, attemptId ?? null, null, null, signal);
				if (result.operationStatus !== "confirmed") return result;
				const observed = result.value;
				if (observed.availability.executor.state === "unavailable" || !observed.activity.selected.complete) {
					const reason = observed.availability.executor.reason ?? (observed.activity.selected.reasons.join("; ") || "The executor source could not be completely observed");
					return {
						operationStatus: "unknown",
						problem: operationProblem(context, new Error(reason)),
						verification: {
							workspaceId: context.workspaceId,
							taskId: selected.value.id,
							operation: "run",
							...runId === void 0 ? { attemptId } : { runId }
						},
						lastConfirmedState: {
							runId: observed.link.id,
							stepId: observed.link.stepId,
							...observed.link.dispatch === void 0 || observed.link.dispatch.phase === "accepted" || observed.availability.executor.state === "available" ? { sessionId: observed.link.sessionId } : {},
							initialAssignmentStatus: observed.initialOutcome.state,
							conversationActivity: observed.activity.selected.state
						}
					};
				}
				return result;
			});
		}
		/**
		* START_METHOD_AicraftService.prepare
		* Prepare missing project files without overwriting existing materials.
		* @param workspaceId - Registered DSH project identity.
		* @param signal - Caller cancellation.
		* @returns Updated project state.
		*/
		prepare(workspaceId, request, signal) {
			return prepareProject(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), this.config, signal, request, readProject);
		}
		/**
		* START_METHOD_AicraftService.createTask
		* Create one open task in the selected project.
		* @param workspaceId - Registered DSH project identity.
		* @param request - Task title, selected process and requirements.
		* @param signal - Caller cancellation.
		* @returns Publication confirmation; full project state is read separately.
		*/
		async createTask(workspaceId, request, signal) {
			try {
				return await createTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), request, this.config, signal, readProject);
			} catch (error) {
				throw creationFailure(error);
			}
		}
		/**
		* START_METHOD_AicraftService.workspaceForAgent
		* Resolve the registered project matching the calling agent's working directory.
		*/
		workspaceForAgent(cwd) {
			return workspaceForAgent(this.ctx, cwd);
		}
		/**
		* START_METHOD_AicraftService.completeStep
		* Complete the current step and select the next pending stage without closing the task.
		* @param workspaceId - Registered project.
		* @param taskId - Current task identity.
		* @param stepId - Current running stage.
		* @param signal - Caller cancellation.
		* @returns Updated project state.
		*/
		completeStep(workspaceId, taskId, stepId, signal) {
			return this.changeTask(this.panelContext(workspaceId), taskId, "complete", stepId, signal);
		}
		/**
		* START_METHOD_AicraftService.goToStep
		* Select a step without resetting the other stages; the previous current stage becomes pending.
		*/
		goToStep(workspaceId, taskId, stepId, signal) {
			return this.changeTask(this.panelContext(workspaceId), taskId, "goto", stepId, signal);
		}
		/**
		* START_METHOD_AicraftService.returnStep
		* Return from a row to an eligible earlier step, preserving excluded stages and materials.
		*/
		returnStep(workspaceId, taskId, fromStepId, stepId, signal) {
			return this.changeTask(this.panelContext(workspaceId), taskId, "return", stepId, signal, fromStepId);
		}
		/**
		* START_METHOD_AicraftService.skipStep
		* Skip the current step and select the next pending stage, keeping all materials.
		*/
		skipStep(workspaceId, taskId, stepId, signal) {
			return this.changeTask(this.panelContext(workspaceId), taskId, "skip", stepId, signal);
		}
		/**
		* START_METHOD_AicraftService.closeTask
		* Close a task without deleting materials or performing Git mutations.
		* @param workspaceId - Registered project.
		* @param taskId - Current task identity.
		* @param signal - Caller cancellation.
		* @returns Updated project state.
		*/
		closeTask(workspaceId, taskId, signal) {
			return this.changeTask(this.panelContext(workspaceId), taskId, "close", null, signal);
		}
		/**
		* START_METHOD_AicraftService.reopenTask
		* Reopen a closed task without resetting stages, artifacts or executor history.
		*/
		reopenTask(workspaceId, taskId, signal) {
			return this.changeTask(this.panelContext(workspaceId), taskId, "reopen", null, signal);
		}
	};
})();
/**
* START_METHOD_resolveModel
* Resolve the explicit model assignment with DSH without substituting a default route.
*/
async function resolveModel(ctx, assignment, signal) {
	return diagnosticOperation({
		path: "src/dsh-integration/service.ts",
		method: "resolveModel"
	}, {}, async () => {
		const selection = {
			provider: assignment.provider,
			model: assignment.model,
			...assignment.reasoningEffort === null ? {} : { reasoningEffort: ReasoningEffortId(assignment.reasoningEffort) }
		};
		const resolved = await ctx.llm.resolveCallConfig(selection, signal);
		return {
			provider: resolved.provider,
			model: resolved.model,
			reasoningEffort: resolved.reasoningEffort ?? null
		};
	});
}
/** Translate only a refusal proven by the task publication owner.
*/
function creationFailure(error) {
	if (error instanceof TaskCreationRefusal) return new RemoteError("aicraft/task-not-created", error.message, {
		taskIdentifier: error.taskIdentifier,
		outcome: "not-created",
		...messageOf(error) ? { uiMessage: messageOf(error) } : {}
	}, { cause: error });
	return error;
}
//#endregion
//#region .build/host/dsh-integration/config.js
/**
* FILE: plugin/src/dsh-integration/config.ts
* DESCRIPTION: Define deployment limits for Git reads and project writer locks
*/
/** Validate operation limits before plugin activation. */
const Config = Schema.object({
	oneCDark: Schema.boolean().default(false).volatile(),
	gitTimeoutMs: Schema.natural().min(1).max(2147483647).default(1e4),
	gitGraceMs: Schema.natural().min(1).max(2147483647).default(1e3),
	lockWaitMs: Schema.natural().min(1).max(2147483647).default(1e4)
});
//#endregion
//#region .build/host/index.js
/** Stable AICraft server plugin name. */
const name = "dsh-aicraft";
/**
* START_METHOD_apply
* Install the AICraft server service.
* @param ctx - Owning Cordis plugin context.
* @param config - Validated deployment limits.
*/
function apply(ctx, config) {
	ctx.inject(["settings"], (owner) => {
		owner.effect(() => owner.settings.configure({ auto: false }), "aicraft: custom settings page");
	});
	ctx.plugin(AicraftService, config);
	ctx.inject([
		"tools",
		"aicraft",
		"sandboxPolicy"
	], registerAgentTools);
	console.log("[dsh-aicraft] plugin loaded");
}
//#endregion
export { AicraftService, Config, apply, diagnosticContext, name, observeDiagnostics };
