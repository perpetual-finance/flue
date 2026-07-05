import type { ToolDefinition } from '../tool-types.ts';

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

/** One completed component: its manifest plus everything attached in its body. */
export interface ComponentRecord {
	key: string;
	description?: string;
	instruction?: string;
	instructions: string[];
	tools: ToolDefinition[];
}

export interface RenderFrame {
	root: AttachScope;
	/** Current attachment target is the last entry; the root sits at index 0. */
	scopeStack: AttachScope[];
	/** Completed components in mount order, flat (nested use() records here too). */
	components: ComponentRecord[];
	componentKeys: Set<string>;
}

let currentFrame: RenderFrame | undefined;

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
export function renderWithFrame<T>(render: () => T): { result: T; frame: RenderFrame } {
	if (currentFrame) {
		throw new Error(
			'[flue] Re-entrant agent render. An agent function must not invoke another agent function directly; compose shared behavior with components instead.',
		);
	}
	const root: AttachScope = { instructions: [], tools: [] };
	const frame: RenderFrame = {
		root,
		scopeStack: [root],
		components: [],
		componentKeys: new Set(),
	};
	currentFrame = frame;
	try {
		return { result: render(), frame };
	} finally {
		currentFrame = undefined;
	}
}
