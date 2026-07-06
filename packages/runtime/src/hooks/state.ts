import * as v from 'valibot';
import { type HookStateStore, isRendering, requireRenderFrame } from './frame.ts';

/**
 * Durable agent state: an API over the record log of the agent instance.
 *
 * `useState` reads the value as of this render (reduced from the instance's
 * `state_write` records) and returns a setter that persists a new value.
 * Reads are render-time snapshots; writes are silent — they never post a
 * message, never wake the agent, and never re-render mid-run. The next
 * input-triggered run reads the latest persisted values ("fresh at next run").
 *
 * ```ts
 * export default function SupportAgent() {
 *   const [phase, setPhase] = useState({
 *     name: 'phase',
 *     schema: v.picklist(['gathering', 'drafting', 'done']),
 *     default: 'gathering',
 *   });
 *
 *   useTool({
 *     name: 'begin_draft',
 *     description: 'Call once the case facts are verified.',
 *     run: () => setPhase('drafting'),
 *   });
 *
 *   return { model: '...', instruction: `Current phase: ${phase}.` };
 * }
 * ```
 *
 * Semantics:
 * - Values are JSON: writes are normalized through a JSON round-trip and
 *   throw on non-serializable input. There is no unset — a name, once
 *   written, always has a value (`default` fills in before the first write
 *   and is never persisted itself).
 * - Writing the current value again is a no-op: no record is appended.
 * - Writes made by tools become durable atomically with the tool batch that
 *   made them — if the batch settles, the write is durable; if recovery
 *   settles the batch as interrupted, the write never happened.
 * - The setter throws during render: a render is a pure read of the record
 *   stream. Write from tool `run` functions and other runtime callbacks.
 * - State is scoped to the agent instance (its whole stream), keyed by
 *   `name`; declaring the same name twice in one render throws.
 */
export function useState<TSchema extends v.GenericSchema>(options: {
	name: string;
	schema: TSchema;
	default: v.InferOutput<TSchema>;
}): [v.InferOutput<TSchema>, StateSetter<v.InferOutput<TSchema>>];
export function useState<TSchema extends v.GenericSchema>(options: {
	name: string;
	schema: TSchema;
}): [v.InferOutput<TSchema> | undefined, StateSetter<v.InferOutput<TSchema>>];
export function useState<T>(options: { name: string; default: T }): [T, StateSetter<T>];
export function useState<T = unknown>(options: { name: string }): [T | undefined, StateSetter<T>];
export function useState(options: {
	name: string;
	schema?: v.GenericSchema;
	default?: unknown;
}): [unknown, StateSetter<unknown>] {
	const frame = requireRenderFrame('useState');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useState() is not available in a subagent render. Durable state is scoped to the agent instance; delegates run detached tasks with no state channel. Pass what the delegate needs through the task prompt instead.',
		);
	}
	const { name, schema } = assertUseStateOptions(options);
	if (frame.stateNames.has(name)) {
		throw new Error(
			`[flue] Duplicate useState name "${name}" in one render. State names identify a value across renders and must be unique.`,
		);
	}
	frame.stateNames.add(name);

	const store = frame.state?.store;
	const persisted = readPersisted(name, frame.state?.snapshot, store);
	let value: unknown;
	if (persisted) {
		value = schema ? parsePersisted(name, schema, persisted.value) : persisted.value;
	} else {
		value = options.default;
	}

	const setValue: StateSetter<unknown> = (next) => {
		if (isRendering()) {
			throw new Error(
				`[flue] State "${name}" was written during render. Renders are pure reads of the record stream — write from tool run functions or other runtime callbacks, and use \`default\` for the initial value.`,
			);
		}
		if (!store) {
			throw new Error(
				`[flue] State "${name}" has no durable runtime behind this render, so writes are unavailable.`,
			);
		}
		if (schema) {
			const parsed = v.safeParse(schema, next);
			if (!parsed.success) {
				throw new Error(
					`[flue] State "${name}" write does not match its schema: ${formatIssues(parsed.issues)}.`,
				);
			}
			next = parsed.output;
		}
		store.write(name, normalizeStateValue(name, next));
	};
	return [value, setValue];
}

export type StateSetter<T> = (value: T) => void;

/** One durable write, in call order, as drained by the session for appending. */
export interface HookStateWrite {
	name: string;
	value: unknown;
	previousValue: unknown;
}

/**
 * The runtime's write buffer for one harness lifetime (one submission
 * attempt). Setters push into it; the session drains it into the same append
 * batch as the tool batch's `tool_results_committed` record. No-op writes
 * (deep-equal to the current value) are dropped here, so "one actual change →
 * one record" holds no matter how often a setter is called.
 */
export interface HookStateBuffer extends HookStateStore {
	drain(): HookStateWrite[];
}

export function createHookStateBuffer(snapshot: ReadonlyMap<string, unknown>): HookStateBuffer {
	const overlay = new Map<string, unknown>();
	let pending: HookStateWrite[] = [];
	const currentValue = (name: string): { value: unknown } | undefined => {
		if (overlay.has(name)) return { value: overlay.get(name) };
		if (snapshot.has(name)) return { value: snapshot.get(name) };
		return undefined;
	};
	return {
		current: currentValue,
		write(name, value) {
			const current = currentValue(name);
			if (current && JSON.stringify(current.value) === JSON.stringify(value)) return;
			pending.push({ name, value, previousValue: current?.value });
			overlay.set(name, value);
		},
		drain() {
			const drained = pending;
			pending = [];
			return drained;
		},
	};
}

const UseStateOptionsSchema = v.strictObject(
	{
		name: v.pipe(v.string(), v.minLength(1)),
		schema: v.optional(v.custom<v.GenericSchema>(looksLikeSchema)),
		default: v.optional(v.unknown()),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown useState option ${issue.received}`
			: issue.message,
);

function assertUseStateOptions(options: unknown): { name: string; schema?: v.GenericSchema } {
	const parsed = v.safeParse(UseStateOptionsSchema, options);
	if (!parsed.success) {
		throw new Error(`[flue] useState() options are invalid: ${formatIssues(parsed.issues)}.`);
	}
	const { name, schema } = parsed.output;
	if (schema && 'default' in (options as object)) {
		const checked = v.safeParse(schema, (options as { default?: unknown }).default);
		if (!checked.success) {
			throw new Error(
				`[flue] State "${name}" default does not match its schema: ${formatIssues(checked.issues)}.`,
			);
		}
	}
	return { name, ...(schema ? { schema } : {}) };
}

function looksLikeSchema(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { kind?: unknown }).kind === 'schema' &&
		(value as { async?: unknown }).async === false
	);
}

function readPersisted(
	name: string,
	snapshot: ReadonlyMap<string, unknown> | undefined,
	store: HookStateStore | undefined,
): { value: unknown } | undefined {
	// The store's view wins: it overlays writes made since the snapshot was
	// taken (same submission), so a re-render would read its own writes.
	const current = store?.current(name);
	if (current) return current;
	if (snapshot?.has(name)) return { value: snapshot.get(name) };
	return undefined;
}

function parsePersisted(name: string, schema: v.GenericSchema, value: unknown): unknown {
	const parsed = v.safeParse(schema, value);
	if (!parsed.success) {
		throw new Error(
			`[flue] Persisted value for state "${name}" does not match its schema: ${formatIssues(parsed.issues)}. The stored value likely predates a schema change — migrate the value or widen the schema.`,
		);
	}
	return parsed.output;
}

function normalizeStateValue(name: string, value: unknown): unknown {
	if (value === undefined) {
		throw new Error(
			`[flue] State "${name}" cannot be set to undefined. State values are JSON; there is no unset.`,
		);
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`[flue] State "${name}" value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
	if (text === undefined) {
		throw new Error(`[flue] State "${name}" value is not JSON-serializable.`);
	}
	return JSON.parse(text);
}

function formatIssues(issues: readonly { message: string }[]): string {
	return issues.map((issue) => issue.message).join('; ');
}
