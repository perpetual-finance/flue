import type { SandboxFactory } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Attach the environment this agent instance runs in: the sandbox adapter's
 * `createSessionEnv()` builds the filesystem/exec surface at initialization
 * (once per initialized harness — adapters key durable resources on the
 * instance id; see {@link SandboxFactory.createSessionEnv}), and its
 * `tools()` — when present — REPLACES the framework's default model-facing
 * tool set (a codemode sandbox ships a `code` tool instead of bash, say).
 * Re-renders never rebuild the environment.
 *
 * Takes the `SandboxFactory` value directly — the factory itself is already
 * lazy (constructing it is cheap; the expensive `createSessionEnv()` call
 * happens once, at initialization):
 *
 * ```ts
 * function IssueTriage() {
 *   useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }));
 *   // ...
 * }
 * ```
 *
 * Callable from the agent body, a capability, or a custom hook — but at most
 * once per render (an agent has one environment), and never conditionally.
 * Without it, the runtime's default environment applies.
 */
export function useSandbox(sandbox: SandboxFactory): void {
	const frame = requireRenderFrame('useSandbox');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useSandbox() is not available in a subagent render. Delegates share the parent agent's environment (scope work with the task call's cwd instead).",
		);
	}
	if (
		!sandbox ||
		typeof sandbox !== 'object' ||
		typeof (sandbox as Partial<SandboxFactory>).createSessionEnv !== 'function'
	) {
		throw new Error(
			'[flue] useSandbox() requires a sandbox factory (an object with createSessionEnv()), like the value local() returns.',
		);
	}
	if (sandbox.tools !== undefined && typeof sandbox.tools !== 'function') {
		throw new Error('[flue] useSandbox() sandbox `tools` must be a function when present.');
	}
	if (frame.sandbox !== undefined) {
		throw new Error(
			'[flue] useSandbox() was called twice in one render. An agent has one environment — attach it once, in the agent body or a single capability.',
		);
	}
	frame.sandbox = sandbox;
}
