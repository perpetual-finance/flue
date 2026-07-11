/**
 * Target-neutral execution cores for the per-agent HTTP surface.
 *
 * Both routers share these:
 *   - the legacy name-addressed `flue()` router (`/agents/:name/:id`, see
 *     flue-app.ts), where the agent is resolved from the URL, and
 *   - the mounted per-agent router built by `createAgentRouter(agent)`
 *     (registration.ts), where the identity resolves off the agent function
 *     and the mount path is user-chosen.
 *
 * An agent's *identity* is the generalization of the legacy wire name: the
 * legacy generated entry registers agents under filename-derived names, which
 * are exactly the identities the `'use agent'` directive injects. Every
 * function here therefore takes a single `agentName` string that is the wire
 * name on the legacy path and the identity on the mounted path — durable
 * storage keying (`agentStreamPath(agentName, id)`) and target dispatch are
 * identical for both.
 */

import type { MiddlewareHandler } from 'hono';
import { validator } from 'hono-openapi';
import { InvalidRequestError, RouteNotFoundError } from '../errors.ts';
import type { FlueRuntime } from './flue-app.ts';
import { handleAgentRequest } from './handle-agent.ts';
import {
	handleAgentAttachmentRead,
	handleAgentConversationHead,
	handleAgentConversationRead,
} from './handle-conversation-routes.ts';
import { agentStreamPath } from './stream-offsets.ts';

/** One agent-scoped HTTP interaction, already resolved to its storage identity. */
export interface AgentRequestTarget {
	/** Storage identity: the legacy wire name or the module identity. */
	agentName: string;
	/** Caller-chosen conversation/instance id (the trailing URL segment). */
	instanceId: string;
	request: Request;
	/** Platform bindings (`c.env`) — forwarded to the Cloudflare DO router. */
	env: unknown;
}

/** Serve a DS conversation stream read (`GET`/`HEAD`) for one agent instance. */
export async function executeAgentConversationRead(
	rt: FlueRuntime,
	target: AgentRequestTarget,
): Promise<Response> {
	const { agentName, instanceId, request } = target;
	if (rt.target === 'node') {
		const streamPath = agentStreamPath(agentName, instanceId);
		if (request.method === 'HEAD') {
			return handleAgentConversationHead(rt.conversationStreamStore, streamPath);
		}
		return handleAgentConversationRead({
			store: rt.conversationStreamStore,
			path: streamPath,
			request,
		});
	}

	// Cloudflare: forward to the agent DO.
	const response = await rt.routeAgentRequest(request, target.env, {
		agentName,
		instanceId,
	});
	if (response) return response;
	throw routeNotFound(request);
}

/** Admit one attached prompt (`POST`) for an agent instance (202 admission). */
export async function executeAgentPrompt(
	rt: FlueRuntime,
	target: AgentRequestTarget,
): Promise<Response> {
	const { agentName, instanceId, request } = target;
	if (rt.target === 'node') {
		const admitAttachedSubmission = rt.createAgentAdmission(agentName, instanceId);
		if (!admitAttachedSubmission) {
			throw new Error('[flue] Node runtime is missing agent admission configuration.');
		}
		return handleAgentRequest({
			request,
			id: instanceId,
			agentName,
			admitAttachedSubmission,
		});
	}

	const response = await rt.routeAgentRequest(request, target.env, {
		agentName,
		instanceId,
	});
	if (response) return response;
	throw routeNotFound(request);
}

/** Abort all in-flight/queued durable work for one agent instance. */
export async function executeAgentAbort(
	rt: FlueRuntime,
	target: AgentRequestTarget,
): Promise<Response> {
	const { agentName, instanceId, request } = target;
	if (rt.target === 'node') {
		const aborted = await rt.abortAgentInstance(agentName, instanceId);
		return Response.json({ aborted });
	}
	// Cloudflare: forward to the owning agent DO, which recognizes the
	// abort intent by the canonical path tail and settles via its coordinator.
	const response = await rt.routeAgentRequest(canonicalAgentRequest(target, '/abort'), target.env, {
		agentName,
		instanceId,
	});
	if (response) return response;
	throw routeNotFound(request);
}

/** Serve one attachment's bytes. */
export async function executeAgentAttachmentRead(
	rt: FlueRuntime,
	target: AgentRequestTarget & { attachmentId: string },
): Promise<Response> {
	const { agentName, instanceId, request } = target;
	if (rt.target === 'node') {
		return handleAgentAttachmentRead({
			conversationStore: rt.conversationStreamStore,
			attachmentStore: rt.attachmentStore,
			path: agentStreamPath(agentName, instanceId),
			attachmentId: target.attachmentId,
		});
	}
	// Cloudflare: forward to the agent DO, which owns the attachment bytes and
	// recognizes the download intent by the canonical path tail.
	const response = await rt.routeAgentRequest(
		canonicalAgentRequest(target, `/attachments/${encodeURIComponent(target.attachmentId)}`),
		target.env,
		{ agentName, instanceId },
	);
	if (response) return response;
	throw routeNotFound(request);
}

/**
 * Rebuild a DO-bound request on the canonical `/agents/<identity>/<id><tail>`
 * path. The DO coordinator recognizes abort and attachment intent by the URL
 * tail, while the public mount path is user-chosen ("URL shapes are yours") —
 * so the wire shape the DO sees must derive from the identity, never from
 * wherever the agent happens to be mounted. Method, headers, body, and the
 * query string all pass through unchanged.
 */
function canonicalAgentRequest(target: AgentRequestTarget, tail: string): Request {
	const url = new URL(target.request.url);
	url.pathname = `/agents/${encodeURIComponent(target.agentName)}/${encodeURIComponent(
		target.instanceId,
	)}${tail}`;
	return new Request(url, target.request);
}

function routeNotFound(request: Request): RouteNotFoundError {
	return new RouteNotFoundError({
		method: request.method,
		path: new URL(request.url).pathname,
	});
}

/**
 * Wrap a hono-openapi validator so failures render Flue's canonical
 * `invalid_request` envelope instead of the library default.
 */
export function validated(
	target: 'param' | 'query',
	schema: Parameters<typeof validator>[1],
): MiddlewareHandler {
	return validator(target, schema, (result) => {
		if (result.success) return;
		throw new InvalidRequestError({
			reason: `Invalid ${target} parameters: ${describeValidationIssues(result.error)}`,
		});
	}) as MiddlewareHandler;
}

/**
 * Flatten standard-schema validation issues into a caller-safe sentence.
 * The raw issue objects are a validation-library-internal shape and must not
 * reach the wire — clients would freeze that shape into their error handling.
 */
function describeValidationIssues(issues: unknown): string {
	if (!Array.isArray(issues) || issues.length === 0) return 'request validation failed.';
	return issues
		.map((issue: { message?: unknown; path?: unknown }) => {
			const message = typeof issue.message === 'string' ? issue.message : 'Invalid value.';
			const path = Array.isArray(issue.path)
				? issue.path
						.map((segment) =>
							typeof segment === 'object' && segment !== null && 'key' in segment
								? String((segment as { key: unknown }).key)
								: String(segment),
						)
						.join('.')
				: '';
			return path ? `${path}: ${message}` : message;
		})
		.join(' ');
}

/** Guard the caller-chosen conversation id segment (mount-relative `/:id`). */
export function assertAgentInstanceId(id: string): void {
	if (id.trim() === '') {
		throw new InvalidRequestError({
			reason: 'Agent conversation URLs must end with a non-empty conversation id segment.',
		});
	}
}
