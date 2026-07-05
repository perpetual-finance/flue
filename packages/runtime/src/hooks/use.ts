import type { Capability } from '../types.ts';
import { requireRenderFrame } from './frame.ts';
import { isPromiseLike } from './render.ts';

/**
 * Mount a capability for this render.
 *
 * A capability is a function with the same shape as an agent: Flue Hooks in
 * the body attach what it provides (tools, instructions, state); the returned
 * string is its instruction — teaching prose the author formats themselves
 * (headings included). Return nothing for a tools-only capability.
 *
 * Flue invokes the capability — pass the function, never its result — so the
 * attachments made in its body are attributed to it:
 *
 * ```ts
 * use(CaseContext);
 * use(GatheringPhase, { check: inPhase('gathering'), onComplete: () => enter('drafting') });
 * ```
 *
 * Capabilities are always connected: `use()` is never conditional, and the
 * set of mounted capabilities must be identical across renders. State informs
 * the agent — through props, guards, and interpolated text — it does not
 * reshape the agent. Capabilities may use() other capabilities; all mounts
 * record flat, in mount order.
 */
export function use(capability: Capability): void;
export function use<TProps>(capability: Capability<TProps>, props: TProps): void;
export function use<TProps>(capability: Capability<TProps>, props?: TProps): void {
	const frame = requireRenderFrame('use');
	if (typeof capability !== 'function') {
		throw new Error(
			'[flue] use() requires a capability function. Flue invokes capabilities — pass the function itself (use(Retention)), not its result (use(Retention())).',
		);
	}
	const scope = { instructions: [], tools: [] };
	frame.scopeStack.push(scope);
	let result: unknown;
	try {
		result = (capability as (props?: TProps) => unknown)(props);
	} finally {
		frame.scopeStack.pop();
	}
	assertCapabilityResult(result);
	frame.capabilities.push({
		capability: capability as (props?: never) => unknown,
		...(typeof result === 'string' && result.length > 0 ? { instruction: result } : {}),
		instructions: scope.instructions,
		tools: scope.tools,
	});
}

function assertCapabilityResult(value: unknown): asserts value is string | undefined {
	if (isPromiseLike(value)) {
		throw new Error(
			'[flue] Capabilities must be synchronous. Move async work into tools, actions, or resource factories.',
		);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new Error(
			'[flue] A capability returns its instruction string (or nothing for a tools-only capability). Objects are not supported — compose with hooks in the body instead.',
		);
	}
}
