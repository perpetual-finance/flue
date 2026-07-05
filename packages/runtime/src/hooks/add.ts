import * as v from 'valibot';
import type { ComponentManifest } from '../types.ts';
import { requireRenderFrame } from './frame.ts';
import { isPromiseLike } from './render.ts';

const ComponentManifestSchema = v.strictObject(
	{
		key: v.pipe(v.string(), v.minLength(1)),
		description: v.optional(v.string()),
		instruction: v.optional(v.string()),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown component manifest field ${issue.received}`
			: issue.message,
);

/**
 * Mount a component for the current render.
 *
 * A component is a function with the same shape as an agent: Flue Hooks in
 * the body attach its implements (tools, instructions); the returned manifest
 * `{ key, description?, instruction? }` describes it. The component's
 * attachments render as one named capability section in the system prompt,
 * keyed by `key`.
 *
 * Flue invokes the component — pass the function, never its result — so the
 * attachments made in its body are attributed to it:
 *
 * ```ts
 * if (sentiment === 'churn-risk') add(RetentionIncentives);
 * if (phase === 'gathering') add(GatheringPhase, { next: () => setPhase('drafting') });
 * ```
 *
 * Conditional mounting is the idiom: a component that is not added simply
 * isn't part of the agent this render. Components may add() other components;
 * all mounts record flat, and a duplicate `key` in one render throws.
 */
export function add(component: () => ComponentManifest): void;
export function add<TProps>(component: (props: TProps) => ComponentManifest, props: TProps): void;
export function add<TProps>(
	component: (props?: TProps) => ComponentManifest,
	props?: TProps,
): void {
	const frame = requireRenderFrame('add');
	if (typeof component !== 'function') {
		throw new Error(
			'[flue] add() requires a component function. Flue invokes components — pass the function itself (add(Retention)), not its result (add(Retention())).',
		);
	}
	const scope = { instructions: [], tools: [] };
	frame.scopeStack.push(scope);
	let manifest: unknown;
	try {
		manifest = component(props);
	} finally {
		frame.scopeStack.pop();
	}
	assertComponentManifest(manifest);
	if (frame.componentKeys.has(manifest.key)) {
		throw new Error(
			`[flue] Duplicate component key "${manifest.key}" in one render. Component keys identify a capability across renders and must be unique.`,
		);
	}
	frame.componentKeys.add(manifest.key);
	frame.components.push({
		key: manifest.key,
		...(manifest.description !== undefined ? { description: manifest.description } : {}),
		...(manifest.instruction !== undefined ? { instruction: manifest.instruction } : {}),
		instructions: scope.instructions,
		tools: scope.tools,
	});
}

function assertComponentManifest(value: unknown): asserts value is ComponentManifest {
	if (isPromiseLike(value)) {
		throw new Error(
			'[flue] Component functions must be synchronous. Move async work into tools, actions, or resource factories.',
		);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			'[flue] Component functions must return a manifest object ({ key, description, instruction }).',
		);
	}
	const parsed = v.safeParse(ComponentManifestSchema, value);
	if (!parsed.success) {
		throw new Error(
			`[flue] Component returned an invalid manifest: ${parsed.issues
				.map((issue) => issue.message)
				.join('; ')}.`,
		);
	}
}
