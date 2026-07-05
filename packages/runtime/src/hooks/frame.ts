import type { ToolDefinition } from '../tool-types.ts';
import type { SandboxFactory } from '../types.ts';

/**
 * The render frame: the module-global slot Flue Hooks resolve against while
 * an agent function runs. Same discipline as Preact's `currentComponent` —
 * agent functions are synchronous, so a single slot never interleaves; it is
 * set for exactly the duration of one render, and hooks throw when it is
 * empty (called from tools, events, or module scope).
 *
 * Attachments land in the *current scope*: the root scope for hooks called
 * directly in the agent body, or a component scope while `use()` runs a
 * component function. Scopes form a stack because components may use()
 * other components; completed components are recorded flat, keyed by their
 * manifest `key`.
 */

/** Attachments collected for one scope (the root, or one component render). */
export interface AttachScope {
	/** `useInstruction()` contributions, in call order. */
	instructions: string[];
	/** `useTool()` mounts, in call order. */
	tools: ToolDefinition[];
}

/** One mounted capability: its returned instruction plus everything attached in its body. */
export interface CapabilityRecord {
	/** The capability function itself — identity for the structural-invariance guard. */
	capability: (props?: never) => unknown;
	/** The capability's returned instruction string, when it returned one. */
	instruction?: string;
	/** `useInstruction()` contributions made in the capability's body, in call order. */
	instructions: string[];
	tools: ToolDefinition[];
}

/**
 * Durable hook state made available to one render: the reduced snapshot to
 * read values from, and the store setters write through. Absent when there is
 * no durable runtime behind the render (direct `renderAgentFunction` calls in
 * tests/tooling) — `useState` then reads defaults and its setters throw.
 */
export interface RenderStateContext {
	snapshot: ReadonlyMap<string, unknown>;
	store: HookStateStore | undefined;
}

/** The write channel `useState` setters push into; drained by the session. */
export interface HookStateStore {
	write(name: string, value: unknown): void;
	current(name: string): { value: unknown } | undefined;
}

export interface RenderFrame {
	root: AttachScope;
	/** Current attachment target is the last entry; the root sits at index 0. */
	scopeStack: AttachScope[];
	/** Mounted capabilities in mount order, flat (nested use() records here too). */
	capabilities: CapabilityRecord[];
	/** `useState` names declared this render; duplicates throw. */
	stateNames: Set<string>;
	/** The render's `useSandbox` attachment; at most one per render. */
	sandbox: SandboxFactory | undefined;
	state: RenderStateContext | undefined;
}

let currentFrame: RenderFrame | undefined;

/** Whether an agent render is currently on the stack (setters must throw then). */
export function isRendering(): boolean {
	return currentFrame !== undefined;
}

/** Resolve the active render frame, or throw the outside-render error. */
export function requireRenderFrame(hookName: string): RenderFrame {
	if (!currentFrame) {
		throw new Error(
			`[flue] ${hookName}() was called outside an agent function. ` +
				'Flue Hooks compose an agent while it renders: call them synchronously in the agent function body (or in a component it adds), not from tools, actions, event handlers, or module scope.',
		);
	}
	return currentFrame;
}

/** The scope attachments currently land in (root, or the component being rendered). */
export function currentScope(frame: RenderFrame): AttachScope {
	return frame.scopeStack[frame.scopeStack.length - 1] as AttachScope;
}

/** Run one synchronous render inside a fresh frame; always clears the slot. */
export function renderWithFrame<T>(
	render: () => T,
	state?: RenderStateContext,
): { result: T; frame: RenderFrame } {
	if (currentFrame) {
		throw new Error(
			'[flue] Re-entrant agent render. An agent function must not invoke another agent function directly; compose shared behavior with components instead.',
		);
	}
	const root: AttachScope = { instructions: [], tools: [] };
	const frame: RenderFrame = {
		root,
		scopeStack: [root],
		capabilities: [],
		stateNames: new Set(),
		sandbox: undefined,
		state,
	};
	currentFrame = frame;
	try {
		return { result: render(), frame };
	} finally {
		currentFrame = undefined;
	}
}
