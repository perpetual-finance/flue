/**
 * The `"use agent"` module transform.
 *
 * For every scanned agent module, appends a call to
 * `__flueBindAgentModule(defaultExport, { identity, ...presentNamedExports })`
 * — the module-metadata binding contract defined by
 * `@flue/runtime` (see packages/runtime/src/runtime/registration.ts). The
 * binding runs at module-evaluation time, so `app.ts` can call
 * `agent.route()` during its own evaluation, before the generated bootstrap
 * registers the scanned set.
 *
 * The appended code references the module's own namespace via a self-import,
 * which works for every default-export form (expression, named declaration,
 * re-export) without rewriting authored code, and adds no dependency beyond
 * `@flue/runtime` (which every agent module already imports for
 * `defineAgent`).
 */
import MagicString from 'magic-string';
import { parseAstAsync } from 'vite';
import {
	findAgentDirectiveStatement,
	parserLangForFile,
	sourcePosition,
} from './agent-scan.ts';

/** Named exports the binding contract carries onto the definition. */
const BOUND_NAMED_EXPORTS = ['route', 'description', 'initialDataSchema', 'durability'] as const;

export interface UseAgentTransformResult {
	code: string;
	map: ReturnType<MagicString['generateMap']>;
}

/**
 * Transform an agent module (already known to be part of the scanned agent
 * set) by appending the metadata-binding call. Returns `null` when the
 * module's directive prologue does not actually declare `'use agent'` (e.g.
 * the marker text only appears in a string or comment).
 */
export async function transformUseAgentModule(options: {
	code: string;
	/** The Vite module id, used verbatim as the self-import specifier. */
	id: string;
	/** Filesystem path (id without query), for parser dialect detection. */
	filePath: string;
	/** The module's scanned identity (file basename). */
	identity: string;
}): Promise<UseAgentTransformResult | null> {
	const { code, id, filePath, identity } = options;
	const program = await parseAstAsync(code, { lang: parserLangForFile(filePath) }, filePath);
	const body = program.body as readonly unknown[];
	const directive = findAgentDirectiveStatement(body);
	if (!directive) return null;

	const exports = collectExportedNames(body);
	if (!exports.hasDefault) {
		const { line, column } = sourcePosition(code, directive.start ?? 0);
		throw new Error(
			`[flue] Agent module ${filePath}:${line}:${column} declares 'use agent' but has no default export. ` +
				`The directive marks the module as an agent, and its default export must be the defineAgent(...) definition.`,
		);
	}

	const boundFields = [`identity: ${JSON.stringify(identity)}`];
	for (const name of BOUND_NAMED_EXPORTS) {
		if (exports.named.has(name)) boundFields.push(`${name}: __flue_agent_module__.${name}`);
	}

	const ms = new MagicString(code);
	ms.append(
		[
			'',
			'',
			'// Injected by @flue/vite ("use agent" module-metadata binding).',
			`import { __flueBindAgentModule as __flue_bind_agent_module__ } from '@flue/runtime';`,
			`import * as __flue_agent_module__ from ${JSON.stringify(id)};`,
			`__flue_bind_agent_module__(__flue_agent_module__.default, { ${boundFields.join(', ')} });`,
			'',
		].join('\n'),
	);
	// `source` + `includeContent` keep the original module text in the emitted
	// map; without them Vite's sourcemap composition can drop the original
	// source and downstream consumers fall back to transformed code.
	return {
		code: ms.toString(),
		map: ms.generateMap({ hires: 'boundary', source: id, includeContent: true }),
	};
}

interface CollectedExports {
	hasDefault: boolean;
	named: Set<string>;
}

interface AstNode {
	type?: string;
	id?: { type?: string; name?: string } | null;
	declaration?: AstNode | null;
	declarations?: Array<{ id?: unknown }>;
	specifiers?: Array<{ exported?: { type?: string; name?: unknown; value?: unknown } }>;
}

/**
 * Statically collect the module's exported names. `export * from` re-exports
 * are not followed — the binding contract requires `route`/`attachments`/
 * `description` to be declared by the agent module itself (the generated
 * bootstrap's runtime registration reads the full namespace, so star
 * re-exports still register correctly; they just aren't bound at
 * module-evaluation time).
 */
function collectExportedNames(body: readonly unknown[]): CollectedExports {
	const named = new Set<string>();
	let hasDefault = false;
	for (const entry of body) {
		const node = entry as AstNode;
		if (node.type === 'ExportDefaultDeclaration') {
			hasDefault = true;
			continue;
		}
		if (node.type !== 'ExportNamedDeclaration') continue;
		const declaration = node.declaration;
		if (declaration) {
			if (declaration.type === 'VariableDeclaration') {
				for (const declarator of declaration.declarations ?? []) {
					collectPatternNames(declarator.id, named);
				}
			} else if (declaration.id && typeof declaration.id.name === 'string') {
				// FunctionDeclaration / ClassDeclaration / TS enum-free equivalents.
				named.add(declaration.id.name);
			}
		}
		for (const specifier of node.specifiers ?? []) {
			const exported = specifier.exported;
			const name =
				typeof exported?.name === 'string'
					? exported.name
					: typeof exported?.value === 'string'
						? exported.value
						: undefined;
			if (name === 'default') hasDefault = true;
			else if (name) named.add(name);
		}
	}
	return { hasDefault, named };
}

/** Collect bound identifiers from a binding pattern (id of a declarator). */
function collectPatternNames(pattern: unknown, into: Set<string>): void {
	const node = pattern as {
		type?: string;
		name?: string;
		properties?: unknown[];
		elements?: unknown[];
		left?: unknown;
		argument?: unknown;
		value?: unknown;
	} | null;
	if (!node || typeof node !== 'object') return;
	switch (node.type) {
		case 'Identifier':
			if (typeof node.name === 'string') into.add(node.name);
			return;
		case 'ObjectPattern':
			for (const property of node.properties ?? []) {
				const entry = property as { type?: string; value?: unknown; argument?: unknown };
				if (entry.type === 'RestElement') collectPatternNames(entry.argument, into);
				else collectPatternNames(entry.value, into);
			}
			return;
		case 'ArrayPattern':
			for (const element of node.elements ?? []) collectPatternNames(element, into);
			return;
		case 'AssignmentPattern':
			collectPatternNames(node.left, into);
			return;
		case 'RestElement':
			collectPatternNames(node.argument, into);
			return;
		default:
			return;
	}
}
