/**
 * Runtime-safe application composition for the authored `app.ts` entrypoint.
 *
 * `app.ts` IS the route map: its default {@link Fetchable} export owns the
 * request pipeline and mounts agent and channel routers explicitly (e.g.
 * `app.route('/agents/triage', agent(triage).route())`).
 */

import type { Hono } from 'hono';
import { createAgentRouter } from './runtime/registration.ts';
import type { AgentModuleValue } from './types.ts';

/**
 * Structural contract for the default export of an authored `app.ts` entry.
 * Any object exposing a compatible `fetch()` method satisfies it, including a
 * `new Hono()` instance.
 *
 * On Cloudflare, `env` contains bindings and `ctx` is the
 * `ExecutionContext`. On Node, `env` contains Hono's Node adapter bindings for
 * the incoming and outgoing messages, and `ctx` is `undefined`.
 */
export interface Fetchable {
	fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

/**
 * Wrap a `'use agent'` module's default export — an agent function or a
 * `defineAgent(...)` value — for mounting in `app.ts`:
 *
 * ```ts
 * import { agent } from '@flue/runtime/routing';
 * import assistant from './agents/assistant.ts';
 *
 * app.route('/api/agents/assistant', agent(assistant).route());
 * ```
 *
 * `route()` builds the same mountable Hono sub-app as
 * `AgentDefinition.route()`: `POST /:id` (prompt; 202 admission),
 * `GET|HEAD /:id` (DS conversation stream), `POST /:id/abort`, and the
 * opt-in attachment download. Pure factory — no registration side effects;
 * safe to call any number of times. Requires the module to carry the
 * `'use agent'` directive (which binds the agent's identity).
 */
export function agent(value: AgentModuleValue): { route(): Hono } {
	if (
		typeof value !== 'function' &&
		(typeof value !== 'object' || value === null || value.__flueAgentDefinition !== true)
	) {
		throw new Error(
			"[flue] agent() requires a 'use agent' module's default export (an agent function or defineAgent(...) value).",
		);
	}
	return { route: () => createAgentRouter(value) };
}
