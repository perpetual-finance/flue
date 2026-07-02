import type { MiddlewareHandler } from 'hono';
import { configureErrorRendering } from '../errors.ts';
import type {
	AgentDefinition,
	AgentDispatchRequest,
	DispatchReceipt,
	NamedAgentDispatchRequest,
} from '../types.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type { AttachmentStore } from './attachment-store.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';
import { enqueueDispatch } from './dispatch.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import type { RuntimeActivityGate } from './runtime-activity-gate.ts';

export interface AgentRecord {
	name: string;
	definition: AgentDefinition;
	description?: string;
	route?: MiddlewareHandler;
	/**
	 * Opt-in gate for `GET /agents/:name/:id/attachments/:attachmentId`. When
	 * absent, the attachment-download endpoint returns 404. When present, it runs
	 * as middleware before bytes are served, so the agent author authorizes and
	 * scopes access (the bytes may contain sensitive content).
	 */
	attachments?: MiddlewareHandler;
}

interface RuntimeBase {
	devMode?: boolean;
	agents: AgentRecord[];
	dispatchQueue: DispatchQueue;
	activityGate?: RuntimeActivityGate;
}

export interface NodeRuntime extends RuntimeBase {
	target: 'node';
	createAgentAdmission: (
		agentName: string,
		instanceId: string,
	) => AttachedAgentSubmissionAdmission;
	/**
	 * Abort all in-flight and queued durable work for an agent instance.
	 * Resolves `true` when there was unsettled work to abort. Terminal
	 * settlement (the distinct aborted outcome) happens asynchronously.
	 */
	abortAgentInstance: (agentName: string, instanceId: string) => Promise<boolean>;
	conversationStreamStore: ConversationStreamStore;
	attachmentStore: AttachmentStore;
}

export interface CloudflareRuntime extends RuntimeBase {
	target: 'cloudflare';
	routeAgentRequest: (
		request: Request,
		env: unknown,
		target: { agentName: string; instanceId: string },
	) => Promise<Response | null>;
}

export type FlueRuntime = NodeRuntime | CloudflareRuntime;

/**
 * Accepts input for asynchronous delivery to a continuing agent session.
 *
 * Resolves after the current runtime admits and queues the input. It does not
 * wait for model processing, tool calls, or an agent reply. The returned
 * `dispatchId` identifies delivery.
 *
 * The agent-definition overload requires a value default-exported by exactly one
 * registered `'use agent'` module. The named overload targets a registered
 * agent module by identity.
 *
 * Delivery durability depends on the generated target. Node uses a
 * process-lifetime in-memory queue by default. Cloudflare durably admits work
 * to the target agent Durable Object and may retry processing after an
 * interruption. Cloudflare processing can therefore be at-least-once; design
 * external side effects to be idempotent.
 */
export function dispatch(
	agent: AgentDefinition,
	request: AgentDispatchRequest,
): Promise<DispatchReceipt>;
export function dispatch(request: NamedAgentDispatchRequest): Promise<DispatchReceipt>;
export async function dispatch(
	agentOrRequest: AgentDefinition | NamedAgentDispatchRequest,
	maybeRequest?: AgentDispatchRequest,
): Promise<DispatchReceipt> {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] dispatch() called before runtime was configured. ' +
				'This usually means it was used outside a Flue-built server entry.',
		);
	}
	const request = isAgentDefinitionValue(agentOrRequest)
		? resolveAgentDefinitionDispatchRequest(agentOrRequest, maybeRequest, rt)
		: agentOrRequest;
	return enqueueDispatch({ request, dispatchQueue: rt.dispatchQueue, rt });
}

function isAgentDefinitionValue(
	value: AgentDefinition | NamedAgentDispatchRequest,
): value is AgentDefinition {
	return (
		'__flueAgentDefinition' in value &&
		value.__flueAgentDefinition === true &&
		typeof value.initialize === 'function'
	);
}

function resolveAgentDefinitionDispatchRequest(
	agent: AgentDefinition,
	request: AgentDispatchRequest | undefined,
	rt: FlueRuntime,
): NamedAgentDispatchRequest {
	if (!request) throw new Error('[flue] dispatch(agent, request) requires a dispatch request.');
	const name = rt.agents.find((record) => record.definition === agent)?.name;
	if (!name) {
		throw new Error(
			'[flue] dispatch() target agent definition is not a discovered default-exported agent in this built application.',
		);
	}
	return { agent: name, id: request.id, message: request.message };
}

let runtimeConfig: FlueRuntime | undefined;

/**
 * Not part of the public API — exposed via `@flue/runtime/internal` only
 * because the generated entry imports it from a stable bare specifier.
 */
export function configureFlueRuntime(cfg: FlueRuntime): void {
	runtimeConfig = cfg;
	configureErrorRendering({ devMode: cfg.devMode ?? false });
}

export function resetFlueRuntimeForTests(): void {
	runtimeConfig = undefined;
	configureErrorRendering({ devMode: false });
}

export function getFlueRuntime(): FlueRuntime | undefined {
	return runtimeConfig;
}
