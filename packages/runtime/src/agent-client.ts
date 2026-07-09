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
 * standalone script after `start()` from `@flue/runtime/node`, and under
 * `flue run`. Awaiting holds no durable state — if the process dies
 * mid-await, the submission itself survives exactly as the configured store
 * persists it, but the awaiting promise is gone. That trade is the point:
 * scripts and CI runs get a plain awaitable call and accept the loss.
 */

import type { ConversationStreamChunk } from './conversation-public.ts';
import { InvalidRequestError } from './errors.ts';
import {
	observeSubmissionSettlement,
	readSubmissionReply,
} from './runtime/conversation-observer.ts';
import { enqueueDispatch } from './runtime/dispatch.ts';
import type { FlueRuntime, NodeRuntime } from './runtime/flue-app.ts';
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

	/**
	 * The awaited tail of a handle send: watch the stream for the admitted
	 * submission's durable settlement (wiring the caller's abort signal as a
	 * durable abort intent), then read and return the reply.
	 */
	const awaitSettledReply = async (
		node: NodeRuntime,
		name: string,
		target: { submissionId: string; offset: string; uid?: string },
		options: AgentDispatchOptions,
	): Promise<AgentReply> => {
		const path = agentStreamPath(name, id);
		let abortRequested = false;
		const requestAbort = () => {
			if (abortRequested) return;
			abortRequested = true;
			// Durable abort intent; the aborted settlement arrives on the
			// stream, which the observation below keeps watching.
			void node.abortAgentInstance(name, id).catch((error) => {
				console.error('[flue] init() abort request failed:', error);
			});
		};
		if (options.signal?.aborted) requestAbort();
		options.signal?.addEventListener('abort', requestAbort, { once: true });

		try {
			const settlement = await observeSubmissionSettlement({
				store: node.conversationStreamStore,
				path,
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
			const reply = await readSubmissionReply({
				store: node.conversationStreamStore,
				path,
				submissionId: target.submissionId,
			});
			return {
				...reply,
				...(target.uid !== undefined ? { uid: target.uid } : {}),
				submissionId: target.submissionId,
			};
		} finally {
			options.signal?.removeEventListener('abort', requestAbort);
		}
	};

	return {
		id,

		async dispatch(message, dispatchOptions = {}) {
			const rt = requireRuntime('init');
			const node = requireNodeRuntime(rt);
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
				node,
				name,
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

function requireNodeRuntime(rt: FlueRuntime): NodeRuntime {
	if (rt.target !== 'node') {
		throw new Error(
			"[flue] init().dispatch() awaits the agent's settled reply, which is not " +
				'supported on the Cloudflare target. A Worker is a server in front of its ' +
				'agent Durable Objects, and holding a handler open to await a whole agent ' +
				'run works against the platform. Deliver input with the top-level ' +
				'dispatch(agent, { id, message }) (fire-and-forget, works everywhere ' +
				'including cron triggers) and let the agent publish its own result, or ' +
				'await a reply from outside the Worker with the @flue/sdk client.',
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
