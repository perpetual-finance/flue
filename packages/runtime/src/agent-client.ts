/**
 * `init()` — the programmatic client for one agent instance.
 *
 * The handle is an *address*, not a resource: `init()` creates nothing, and
 * the instance itself is created on first contact exactly as it would be for
 * any other delivery. `dispatch()` delivers one message through the dispatch
 * queue — either kind, exactly like the top-level `dispatch()`, with the same
 * string shorthand for a user message — and every hook (`useDelivery`,
 * `useAgentStart`, `useAgentFinish`, state, output, joins) fires exactly as
 * it does on the other transports. The one difference is the await: the
 * handle is the "control this agent" surface, so its `dispatch()` waits for
 * the submission to settle and resolves with the reply. For fire-and-forget
 * delivery, use the top-level `dispatch()`.
 *
 * Like the top-level verb, the handle taps the process's one configured Flue
 * runtime: it works inside a Flue server (a cron callback in app.ts), in a
 * standalone script after `start()` from `@flue/runtime/node`, under
 * `flue run`, and inside a deployed Cloudflare Worker — including Workflow
 * steps, where the settled reply becomes the step's durable result. Awaiting
 * holds no durable state — if the process dies mid-await, the submission
 * itself survives exactly as the configured store persists it, but the
 * awaiting promise is gone. That trade is the point: scripts and CI runs get
 * a plain awaitable call and accept the loss.
 */

import type {
	AgentConversationSnapshot,
	ConversationStreamChunk,
} from './conversation-public.ts';
import { InvalidRequestError } from './errors.ts';
import {
	observeSubmissionSettlement,
	readSubmissionReply,
	replyFromSnapshot,
	type SubmissionReply,
	type SubmissionSettlement,
	settlementFromChunk,
} from './runtime/conversation-observer.ts';
import { enqueueDispatch } from './runtime/dispatch.ts';
import type { CloudflareRuntime, FlueRuntime, NodeRuntime } from './runtime/flue-app.ts';
import { getFlueRuntime } from './runtime/flue-app.ts';
import { generateInstanceId } from './runtime/ids.ts';
import { normalizeMessageInput } from './runtime/message-input.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import type { AgentModuleValue, DeliveredMessageInput } from './types.ts';

export interface InitOptions {
	/**
	 * The instance address. Omit to mint a fresh unique one — a throwaway
	 * instance for this run. Pass a stable id (e.g. `nightly-2026-07-08`) to
	 * address an instance that later sends can find again.
	 */
	id?: string;
	/**
	 * Instance-creation data, validated against the agent's `input:` schema.
	 * The seed, consulted only when the handle's first send creates the
	 * instance; ignored after.
	 */
	data?: unknown;
	/**
	 * Send condition for the handle's first contact (uid ≈ ETag): a string
	 * continues only that incarnation, `null` creates only when no instance
	 * exists, omit to send unconditionally. After a send's receipt, the handle
	 * pins the incarnation it contacted and later sends continue it.
	 */
	uid?: string | null;
}

export interface AgentDispatchOptions {
	/** Receives every projected conversation chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/**
	 * Abort intent. Firing requests a durable abort of the instance's
	 * in-flight work; the call keeps observing and rejects with the
	 * `aborted` settlement once it lands.
	 */
	signal?: AbortSignal;
}

/** The settled reply an awaited handle send resolves with. */
export interface AgentReply {
	/** Final assistant text produced by the submission ('' when none). */
	text: string;
	/** Named client data parts (`useMessageData`) on the reply, keyed by name. */
	data: Record<string, unknown[]>;
	/** Agent-authored response metadata (`useMessageMetadata`), when present. */
	metadata?: Record<string, unknown>;
	/** The contacted incarnation's uid (minted when this send created). */
	uid?: string;
	submissionId: string;
}

/** An awaited send whose submission settled `failed` or `aborted`. */
export class AgentRunError extends Error {
	readonly outcome: 'failed' | 'aborted';
	readonly submissionId: string;

	constructor(options: { outcome: 'failed' | 'aborted'; submissionId: string; cause?: unknown }) {
		super(
			`[flue] Agent run ${options.outcome === 'aborted' ? 'was aborted' : 'failed'} ` +
				`(submission ${options.submissionId}).`,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = 'AgentRunError';
		this.outcome = options.outcome;
		this.submissionId = options.submissionId;
	}
}

/** A programmatic handle addressing one agent instance. */
export interface AgentInstanceHandle {
	/** The instance address this handle targets. */
	readonly id: string;
	/**
	 * Deliver one message — either kind; a string is shorthand for
	 * `{ kind: 'user', body }` — and await its settled reply. Concurrent
	 * sends to one instance serialize (or join a live response at a turn
	 * boundary); a delivery that joined resolves with the coalesced reply
	 * that answered it. Rejects with {@link AgentRunError} on a failed or
	 * aborted settlement. For fire-and-forget delivery, use the top-level
	 * `dispatch()` instead.
	 */
	dispatch(message: DeliveredMessageInput, options?: AgentDispatchOptions): Promise<AgentReply>;
}

/**
 * Address an agent instance for programmatic control.
 *
 * ```ts
 * const agent = init(reporter, { id: `nightly-${date}`, data: { date } });
 * const reply = await agent.dispatch('You have been triggered. Produce the nightly report.');
 * console.log(reply.text);
 * ```
 *
 * The `agent` argument must be a value default-exported by a registered
 * `'use agent'` module (the same contract as `dispatch()`). The runtime is
 * resolved when the handle is used, not when it is created, so `init()` at
 * module scope is safe.
 */
export function init(agent: AgentModuleValue, options: InitOptions = {}): AgentInstanceHandle {
	if (!isAgentDefinitionValue(agent)) {
		throw new InvalidRequestError({
			reason:
				'init() requires an agent definition as its first argument. ' +
				"Pass the default export of a 'use agent' module: init(agent, { id }).",
		});
	}
	if (options.id !== undefined && (typeof options.id !== 'string' || options.id.trim() === '')) {
		throw new Error('[flue] init() requires a non-empty string instance id when one is given.');
	}
	const id = options.id ?? generateInstanceId();

	// The handle's first send carries the creation seed / send condition;
	// afterwards the handle continues the incarnation it contacted.
	let contacted = false;
	let pinnedUid: string | undefined;
	const firstContact = () => ({
		...(options.data !== undefined ? { data: options.data } : {}),
		...('uid' in options && options.uid !== undefined ? { uid: options.uid } : {}),
	});

	const contactOptions = () =>
		contacted ? { ...(pinnedUid !== undefined ? { uid: pinnedUid } : {}) } : firstContact();

	return {
		id,

		async dispatch(message, dispatchOptions = {}) {
			const rt = requireRuntime('init');
			const name = resolveAgentName(rt, agent, 'init');
			const delivered = normalizeMessageInput(message);

			throwIfAborted(dispatchOptions.signal);
			const receipt = await enqueueDispatch({
				request: { agent: name, id, message: delivered, ...contactOptions() },
				dispatchQueue: rt.dispatchQueue,
				rt,
			});
			contacted = true;
			if (receipt.uid !== undefined) pinnedUid = receipt.uid;

			// Observed from the stream origin: a dispatch receipt carries no
			// offset, and an idempotent replay may already be settled — reading
			// from the start finds a past settlement instead of waiting forever.
			return awaitSettledReply(
				createSettlementTransport(rt, name, id),
				{
					submissionId: receipt.dispatchId,
					offset: '-1',
					...(receipt.uid !== undefined ? { uid: receipt.uid } : {}),
				},
				dispatchOptions,
			);
		},
	};
}

/**
 * How one target aborts an instance's in-flight work, observes a submission's
 * settlement, and reads its reply. The awaited choreography above these three
 * operations is target-neutral ({@link awaitSettledReply}).
 */
interface SettlementTransport {
	/** Durable abort intent; the aborted settlement arrives on the stream. */
	requestAbort(): Promise<unknown>;
	observe(target: {
		submissionId: string;
		offset: string;
		onEvent?: (chunk: ConversationStreamChunk) => void;
	}): Promise<SubmissionSettlement>;
	readReply(submissionId: string): Promise<SubmissionReply>;
}

/**
 * The awaited tail of a handle send: watch the stream for the admitted
 * submission's durable settlement (wiring the caller's abort signal as a
 * durable abort intent), then read and return the reply.
 */
async function awaitSettledReply(
	transport: SettlementTransport,
	target: { submissionId: string; offset: string; uid?: string },
	options: AgentDispatchOptions,
): Promise<AgentReply> {
	let abortRequested = false;
	const requestAbort = () => {
		if (abortRequested) return;
		abortRequested = true;
		// Durable abort intent; the aborted settlement arrives on the
		// stream, which the observation below keeps watching.
		void transport.requestAbort().catch((error) => {
			console.error('[flue] init() abort request failed:', error);
		});
	};
	if (options.signal?.aborted) requestAbort();
	options.signal?.addEventListener('abort', requestAbort, { once: true });

	try {
		const settlement = await transport.observe({
			submissionId: target.submissionId,
			offset: target.offset,
			...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
		});
		if (settlement.outcome !== 'completed') {
			throw new AgentRunError({
				outcome: settlement.outcome,
				submissionId: target.submissionId,
				...(settlement.error === undefined ? {} : { cause: settlement.error }),
			});
		}
		const reply = await transport.readReply(target.submissionId);
		return {
			...reply,
			...(target.uid !== undefined ? { uid: target.uid } : {}),
			submissionId: target.submissionId,
		};
	} finally {
		options.signal?.removeEventListener('abort', requestAbort);
	}
}

function createSettlementTransport(
	rt: FlueRuntime,
	agentName: string,
	instanceId: string,
): SettlementTransport {
	return rt.target === 'node'
		? nodeSettlementTransport(rt, agentName, instanceId)
		: cloudflareSettlementTransport(rt, agentName, instanceId);
}

function nodeSettlementTransport(
	node: NodeRuntime,
	agentName: string,
	instanceId: string,
): SettlementTransport {
	const path = agentStreamPath(agentName, instanceId);
	return {
		requestAbort: () => node.abortAgentInstance(agentName, instanceId),
		observe: (target) =>
			observeSubmissionSettlement({
				store: node.conversationStreamStore,
				path,
				submissionId: target.submissionId,
				offset: target.offset,
				...(target.onEvent !== undefined ? { onEvent: target.onEvent } : {}),
			}),
		readReply: (submissionId) =>
			readSubmissionReply({ store: node.conversationStreamStore, path, submissionId }),
	};
}

/**
 * Cloudflare: the conversation stream store lives inside the agent's Durable
 * Object, so observation runs over the DO's existing conversation read route —
 * a loop of bounded long-poll requests (each within the route's 30s window),
 * the same protocol the web client reads. Settlement chunks appear on that
 * stream for every submission kind, so no dedicated wait contract is needed.
 * Requests route with no per-request env; the entry's runtime seed falls back
 * to the worker's module-scope env, which is what lets the handle work in
 * cron callbacks, queue consumers, and Workflow steps.
 */
function cloudflareSettlementTransport(
	cf: CloudflareRuntime,
	agentName: string,
	instanceId: string,
): SettlementTransport {
	const base = `https://flue.invalid/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
	const route = async (request: Request): Promise<Response> => {
		const response = await cf.routeAgentRequest(request, undefined, { agentName, instanceId });
		if (!response) {
			throw new Error(
				`[flue] init() target agent "${agentName}" Durable Object binding is unavailable.`,
			);
		}
		return response;
	};
	return {
		requestAbort: () => route(new Request(`${base}/abort`, { method: 'POST' })),
		async observe(target) {
			let offset = target.offset;
			while (true) {
				const response = await route(
					new Request(`${base}?view=updates&offset=${encodeURIComponent(offset)}&live=long-poll`),
				);
				if (!response.ok) throw routeFailure('conversation observation', agentName, response);
				const chunks = (await response.json()) as ConversationStreamChunk[];
				let settlement: SubmissionSettlement | undefined;
				for (const chunk of chunks) {
					target.onEvent?.(chunk);
					settlement ??= settlementFromChunk(chunk, target.submissionId);
				}
				if (settlement) return settlement;
				offset = response.headers.get('Stream-Next-Offset') ?? offset;
			}
		},
		async readReply(submissionId) {
			const response = await route(new Request(`${base}?view=history`));
			if (!response.ok) throw routeFailure('reply read', agentName, response);
			const snapshot = (await response.json()) as AgentConversationSnapshot;
			return replyFromSnapshot(snapshot, submissionId);
		},
	};
}

function routeFailure(action: string, agentName: string, response: Response): Error {
	return new Error(
		`[flue] init() ${action} for agent "${agentName}" failed with status ${response.status}.`,
	);
}

function requireRuntime(api: string): FlueRuntime {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			`[flue] ${api}() was used before the Flue runtime was configured. ` +
				'Inside a Flue-built server this happens automatically; in a standalone ' +
				"script, call start() from '@flue/runtime/node' first.",
		);
	}
	return rt;
}

function resolveAgentName(rt: FlueRuntime, agent: AgentModuleValue, api: string): string {
	const name = rt.agents.find((record) => record.definition === agent)?.name;
	if (!name) {
		throw new Error(
			`[flue] ${api}() target agent definition is not a discovered default-exported agent in this built application.`,
		);
	}
	return name;
}

function isAgentDefinitionValue(value: unknown): value is AgentModuleValue {
	// Twin: `assertAgentDefinitionValue` in registration.ts — keep in sync.
	if (typeof value !== 'object' || value === null) return false;
	return '__flueFunctionAgent' in value && value.__flueFunctionAgent === true;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
