/**
 * Agent identity registry and the mountable per-agent router.
 *
 * An agent's *identity* is the module-derived slug (`'use agent'` file
 * basename) that keys durable storage: conversation streams on Node
 * (`agentStreamPath(identity, id)`) and the Durable Object class on
 * Cloudflare. It generalizes the legacy wire name — the legacy generated
 * entry registered agents under exactly these filename-derived names — so
 * both routers drive the same name-keyed runtime machinery.
 *
 * Two sources populate identity knowledge:
 *
 *   1. {@link __flueBindAgentModule} — injected into each `'use agent'`
 *      module by the build transform; binds the module's identity and named
 *      exports (`route`, `description`) to the definition at
 *      module-evaluation time.
 *   2. {@link registerFlueAgents} — called once by the generated bootstrap
 *      with the full scanned agent set; the app-membership registry.
 *
 * `AgentDefinition.route()` (built by {@link createAgentRouter}) is a pure
 * router factory over that knowledge: no side effects, callable any number of
 * times, mountable at any path. Handlers re-resolve identity, metadata, and
 * the runtime at request time, so mounting order relative to bootstrap
 * registration does not matter.
 */

import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { MethodNotAllowedError, toHttpResponse } from '../errors.ts';
import type { AgentModuleValue } from '../types.ts';
import {
	assertAgentInstanceId,
	executeAgentAbort,
	executeAgentAttachmentRead,
	executeAgentConversationRead,
	executeAgentPrompt,
	runAttachedMiddleware,
	validated,
} from './agent-routes.ts';
import { getFlueRuntime } from './flue-app.ts';
import { AgentMountRouteParamSchema, InvocationQuerySchema } from './schemas.ts';

/**
 * MODULE-METADATA BINDING CONTRACT — consumed by the `@flue/vite`
 * `'use agent'` transform (Phase 3).
 *
 * For a marked module, the transform appends after the module body (using a
 * local reference to the default export and the module's own named exports):
 *
 * ```ts
 * import { __flueBindAgentModule } from '@flue/runtime';
 * __flueBindAgentModule(<defaultExport>, {
 *   identity: '<identity slug>',        // required; non-empty, no ':'
 *   route,                              // only when the module exports it
 *   description,                        // only when the module exports it
 * });
 * ```
 *
 * `route` is middleware applied to every route the definition's `.route()`
 * serves — including attachment downloads — and `description` is static
 * human-facing metadata.
 */
export interface AgentModuleBinding {
	/** Module identity (file basename, or its `name` export). Keys durable storage; non-empty, no `:`. */
	identity: string;
	/** Middleware applied to all of the agent's routes (module `route` export). */
	route?: MiddlewareHandler;
	/** Static description (module `description` export). */
	description?: string;
}

/** One registered agent: a definition joined to its identity and module metadata. */
export interface FlueAgentRegistration extends AgentModuleBinding {
	definition: AgentModuleValue;
}

let moduleBindings = new WeakMap<AgentModuleValue, AgentModuleBinding>();
let registeredAgents = new Map<string, FlueAgentRegistration>();

/**
 * Bind a module's identity and metadata to its default-exported definition.
 *
 * Not public API — the `'use agent'` build transform injects calls to this
 * (see {@link AgentModuleBinding} for the exact emitted shape). Idempotent
 * for the same definition/identity pair: re-evaluation of a module (dev
 * reload) replaces the metadata in place. Rebinding one definition to a
 * different identity is an authoring error and throws.
 *
 * Returns the definition so the transform may also use it in expression
 * position.
 */
export function __flueBindAgentModule<TDefinition extends AgentModuleValue>(
	definition: TDefinition,
	binding: AgentModuleBinding,
): TDefinition {
	assertAgentDefinitionValue(definition, binding?.identity ?? '(unknown)');
	assertAgentModuleBinding(binding);
	const existing = moduleBindings.get(definition);
	if (existing && existing.identity !== binding.identity) {
		throw new Error(
			`[flue] Agent definition is already bound to identity "${existing.identity}" and cannot be rebound as "${binding.identity}". ` +
				'Each defineAgent(...) value carries exactly one module identity.',
		);
	}
	moduleBindings.set(definition, { ...binding });
	return definition;
}

/**
 * Register the application's full agent set (the scanned `'use agent'`
 * modules). Called by the generated bootstrap; replaces any previous
 * registration wholesale, so a dev-reload bootstrap simply registers again.
 *
 * Not public API — exposed via `@flue/runtime/internal` for generated code.
 */
export function registerFlueAgents(records: readonly FlueAgentRegistration[]): void {
	const next = new Map<string, FlueAgentRegistration>();
	for (const record of records) {
		const identity = record?.identity ?? '(unknown)';
		assertAgentDefinitionValue(record?.definition, identity);
		assertAgentModuleBinding(record);
		const duplicateIdentity = next.get(record.identity);
		if (duplicateIdentity) {
			throw new Error(
				`[flue] Duplicate agent identity "${record.identity}". ` +
					'Agent identities derive from file basenames (or their `export const name` override) and must be unique.',
			);
		}
		const duplicateDefinition = [...next.values()].find(
			(existing) => existing.definition === record.definition,
		);
		if (duplicateDefinition) {
			throw new Error(
				`[flue] Agents "${duplicateDefinition.identity}" and "${record.identity}" default-export the same agent definition value. ` +
					'Use distinct defineAgent(...) values for agent modules.',
			);
		}
		const bound = moduleBindings.get(record.definition);
		if (bound && bound.identity !== record.identity) {
			throw new Error(
				`[flue] Agent definition is already bound to identity "${bound.identity}" and cannot be registered as "${record.identity}".`,
			);
		}
		next.set(record.identity, { ...record });
	}
	registeredAgents = next;
	// Registration also binds, so `.route()` works for definitions registered
	// without the build transform (tests, hand-written bootstraps).
	for (const record of next.values()) {
		moduleBindings.set(record.definition, {
			identity: record.identity,
			...(record.route !== undefined ? { route: record.route } : {}),
			...(record.description !== undefined ? { description: record.description } : {}),
		});
	}
}

/** The currently registered agent set, in registration order. */
export function getRegisteredFlueAgents(): readonly FlueAgentRegistration[] {
	return [...registeredAgents.values()];
}

/**
 * Resolve a definition's identity and module metadata, preferring the
 * registered record (app membership) over the module binding.
 */
export function resolveAgentModuleBinding(
	definition: AgentModuleValue,
): AgentModuleBinding | undefined {
	const binding = moduleBindings.get(definition);
	if (!binding) return undefined;
	const registered = registeredAgents.get(binding.identity);
	if (registered && registered.definition === definition) return registered;
	return binding;
}

export function resetFlueAgentRegistrationForTests(): void {
	moduleBindings = new WeakMap();
	registeredAgents = new Map();
}

// ─── The mountable per-agent router ─────────────────────────────────────────

/**
 * Build the mountable Hono sub-app behind `AgentDefinition.route()`.
 *
 * Routes, relative to wherever the caller mounts the sub-app:
 *
 * - `POST /:id` — send a prompt (202 admission)
 * - `GET|HEAD /:id` — DS conversation stream read
 * - `POST /:id/abort` — abort in-flight/queued work
 * - `ALL /:id/attachments/:attachmentId` — attachment byte download
 *
 * The module's `route` export (middleware) wraps every route above —
 * mounting is the exposure decision, and `route` is the one auth point.
 * Handlers resolve identity/metadata and the runtime at request time and
 * dispatch through the same machinery as the legacy name-addressed router,
 * so both surfaces share storage keying and wire behavior.
 */
export function createAgentRouter(definition: AgentModuleValue): Hono {
	// Fail fast at build/mount time when the module was never marked — but
	// request-time resolution below stays authoritative, so calling `.route()`
	// before the generated bootstrap registers the scanned set is fine.
	requireBinding(definition);

	const resolve = () => requireBinding(definition);
	const app = new Hono();

	app.post(
		'/:id',
		validated('param', AgentMountRouteParamSchema),
		validated('query', InvocationQuerySchema),
		async (c) => {
			const binding = resolve();
			const rt = requireRuntime();
			const id = c.req.param('id') ?? '';
			assertAgentInstanceId(id);
			const request = c.req.raw.clone();
			return runAttachedMiddleware(c, binding.route, () =>
				executeAgentPrompt(rt, {
					agentName: binding.identity,
					instanceId: id,
					request,
					env: c.env,
				}),
			);
		},
	);

	// Abort all in-flight/queued work for an agent instance. A distinct
	// (longer) path, so it never collides with the prompt/stream routes.
	app.all('/:id/abort', async (c) => {
		const binding = resolve();
		const rt = requireRuntime();
		if (c.req.method !== 'POST') {
			throw new MethodNotAllowedError({ method: c.req.method, allowed: ['POST'] });
		}
		const id = c.req.param('id') ?? '';
		assertAgentInstanceId(id);
		const request = c.req.raw.clone();
		return runAttachedMiddleware(c, binding.route, () =>
			executeAgentAbort(rt, {
				agentName: binding.identity,
				instanceId: id,
				request,
				env: c.env,
			}),
		);
	});

	// Attachment byte download. A distinct (longer) path, so it never
	// collides with the prompt/stream routes.
	app.all('/:id/attachments/:attachmentId', async (c) => {
		const binding = resolve();
		const rt = requireRuntime();
		if (c.req.method !== 'GET') {
			throw new MethodNotAllowedError({ method: c.req.method, allowed: ['GET'] });
		}
		const id = c.req.param('id') ?? '';
		const attachmentId = c.req.param('attachmentId') ?? '';
		const request = c.req.raw.clone();
		return runAttachedMiddleware(c, binding.route, () =>
			executeAgentAttachmentRead(rt, {
				agentName: binding.identity,
				instanceId: id,
				attachmentId,
				request,
				env: c.env,
			}),
		);
	});

	// GET/HEAD stream reads, and the canonical 405 envelope for any other
	// unmatched method (instead of Hono's default 404).
	app.all('/:id', async (c) => {
		const binding = resolve();
		const rt = requireRuntime();
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'POST') {
			throw new MethodNotAllowedError({
				method: c.req.method,
				allowed: ['GET', 'HEAD', 'POST'],
			});
		}
		const id = c.req.param('id') ?? '';
		assertAgentInstanceId(id);
		return runAttachedMiddleware(c, binding.route, () =>
			executeAgentConversationRead(rt, {
				agentName: binding.identity,
				instanceId: id,
				request: c.req.raw,
				env: c.env,
			}),
		);
	});

	app.onError((err) => toHttpResponse(err));

	return app;
}

function requireBinding(definition: AgentModuleValue): AgentModuleBinding {
	const binding = resolveAgentModuleBinding(definition);
	if (!binding) {
		throw new Error(
			"[flue] .route() requires an agent identity, and this definition has none. Add the 'use agent' directive as the first statement of the agent module so the build registers it (unit tests can use registerFlueAgents from @flue/runtime/internal).",
		);
	}
	return binding;
}

function requireRuntime() {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			'[flue] Agent route invoked before the runtime was configured. ' +
				'This usually means the mounted app is served outside a Flue-built server entry.',
		);
	}
	return rt;
}

function assertAgentDefinitionValue(
	value: unknown,
	identity: string,
): asserts value is AgentModuleValue {
	// Twin: `isAgentDefinitionValue` in flue-app.ts — keep in sync.
	if (typeof value === 'function') {
		// A bare agent function is the likeliest authoring mistake: it
		// carries no model. Point at the wrapper.
		throw new Error(
			`[flue] Agent "${identity}" default-exports a bare function. Wrap it: defineAgent(${value.name || 'Agent'}, { model: 'provider-id/model-id' }).`,
		);
	}
	const candidate = value as { __flueFunctionAgent?: unknown } | null;
	const isFunctionAgent =
		!!candidate && typeof candidate === 'object' && candidate.__flueFunctionAgent === true;
	if (!isFunctionAgent) {
		throw new Error(
			`[flue] Agent "${identity}" must default-export defineAgent(Agent, { model }).`,
		);
	}
}

function assertAgentModuleBinding(binding: AgentModuleBinding): void {
	if (!binding || typeof binding !== 'object') {
		throw new Error('[flue] Agent module binding must be an object.');
	}
	assertAgentIdentity(binding.identity);
	if (binding.route !== undefined && typeof binding.route !== 'function') {
		throw new Error(
			`[flue] Agent "${binding.identity}" route export must be a callable Hono middleware value.`,
		);
	}
	if (
		binding.description !== undefined &&
		(typeof binding.description !== 'string' || binding.description.trim().length === 0)
	) {
		throw new Error(
			`[flue] Agent "${binding.identity}" description export must be a non-empty string.`,
		);
	}
}

/**
 * Identity charset, ported from the legacy filename-derived agent names:
 * non-empty, and no `:` (URL addressing reserves a single namespace segment).
 */
function assertAgentIdentity(identity: unknown): asserts identity is string {
	if (typeof identity !== 'string' || identity.length === 0 || identity.includes(':')) {
		throw new Error(
			`[flue] Agent identity "${String(identity)}" is invalid. Agent identities must be non-empty and must not contain ":".`,
		);
	}
}
