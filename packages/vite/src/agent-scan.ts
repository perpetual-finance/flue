/**
 * Shared "use agent" scanner.
 *
 * The scanned set of `'use agent'` modules IS the app's agent registry on
 * both targets (Node and Cloudflare): the generated bootstrap imports and
 * registers every scanned file, and the Cloudflare target additionally emits
 * one Durable Object class per scanned file. See
 * plans/2026-07-02-vite-plugin-explicit-routing-redesign.md.
 *
 * The scan is a directory glob over the project source root (overridable via
 * the `agents` glob in flue.config.ts) filtered to files whose ECMAScript
 * directive prologue contains the `use agent` directive. Prologue detection
 * uses the oxc parser that ships with Vite (`parseAstAsync`), so shebangs,
 * comments, `'use strict'` ordering, and ASI all follow real ECMAScript
 * semantics — no regex-over-the-file heuristics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { parseAstAsync } from 'vite';

/** The module directive that marks a file as a Flue agent module. */
export const AGENT_DIRECTIVE = 'use agent';

/**
 * Agent identities (file basenames) must be lower-kebab-case so the generated
 * durable identifiers (Durable Object class + binding names on Cloudflare,
 * conversation storage slugs on Node) remain predictable. Ported from the
 * CLI's Cloudflare build plugin (`CLOUDFLARE_AGENT_NAME_PATTERN`), now
 * enforced uniformly on both targets because the identity keys storage
 * everywhere.
 */
export const AGENT_IDENTITY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Module extensions that can carry the `'use agent'` directive. */
const AGENT_MODULE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

const DEFAULT_SCAN_PATTERNS = ['**/*.{ts,mts,js,mjs}'];

/**
 * Directories that never contain authored agent modules: installed
 * dependencies and build output. Generated directories (`.flue-vite`,
 * `.wrangler`, `.flue`, …) and other dotfiles/dot-directories are excluded
 * by tinyglobby's default `dot: false`, but the Flue-adjacent ones are listed
 * explicitly so an `agents` override with `dot: true` semantics can never
 * resurrect them.
 */
const EXCLUDED_DIRECTORY_PATTERNS = [
	'**/node_modules/**',
	'**/dist/**',
	'**/output/**',
	'**/.flue-vite/**',
	'**/.wrangler/**',
];

export interface ScanAgentsOptions {
	/** Absolute path to the project source root the scan runs over. */
	readonly sourceRoot: string;
	/**
	 * Optional glob(s), relative to {@link ScanAgentsOptions.sourceRoot},
	 * narrowing the scan (the `agents` field of flue.config.ts). Defaults to a
	 * recursive scan of the source root. Matches are still restricted to
	 * `.ts`/`.mts`/`.js`/`.mjs` modules and the standard exclusions.
	 */
	readonly agents?: string | readonly string[];
}

export interface AgentScanResult {
	/** Absolute path of the agent module. */
	readonly filePath: string;
	/** File basename without extension; keys durable storage on both targets. */
	readonly identity: string;
	/** Generated Durable Object class name, e.g. `FlueTriageAgent`. */
	readonly className: string;
	/** Generated Durable Object binding name, e.g. `FLUE_TRIAGE_AGENT`. */
	readonly bindingName: string;
}

/** Base class for structured `scanAgents()` failures. */
export class AgentScanError extends Error {}

/** Two or more scanned agent modules share a file basename. */
export class DuplicateAgentIdentityError extends AgentScanError {
	readonly duplicates: ReadonlyArray<{
		readonly identity: string;
		readonly filePaths: readonly string[];
	}>;

	constructor(
		duplicates: ReadonlyArray<{ readonly identity: string; readonly filePaths: readonly string[] }>,
	) {
		const list = duplicates
			.map(({ identity, filePaths }) => `"${identity}" (${filePaths.join(', ')})`)
			.join('; ');
		super(
			`[flue] Duplicate agent identit${duplicates.length === 1 ? 'y' : 'ies'} among 'use agent' modules: ${list}. ` +
				`The file basename is the agent's durable identity, so it must be unique across the app. Rename the conflicting file(s).`,
		);
		this.duplicates = duplicates;
	}
}

/** A scanned agent module's file basename is not lower-kebab-case. */
export class InvalidAgentIdentityError extends AgentScanError {
	readonly invalidAgents: ReadonlyArray<{
		readonly identity: string;
		readonly filePath: string;
	}>;

	constructor(
		invalidAgents: ReadonlyArray<{ readonly identity: string; readonly filePath: string }>,
	) {
		const list = invalidAgents
			.map(({ identity, filePath }) => `${filePath} (agent: ${identity})`)
			.join(', ');
		super(
			`[flue] Agent filenames must use lower-kebab-case so generated durable identifiers ` +
				`remain predictable. Invalid file(s): ${list}. Rename them to match ${AGENT_IDENTITY_PATTERN}.`,
		);
		this.invalidAgents = invalidAgents;
	}
}

/** A `'use agent'` candidate module could not be parsed. */
export class AgentModuleParseError extends AgentScanError {
	readonly filePath: string;

	constructor(filePath: string, cause: unknown) {
		super(
			`[flue] Unable to parse "${filePath}" while scanning for 'use agent' modules: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.filePath = filePath;
	}
}

/**
 * Scan the source root for `'use agent'` modules and derive their durable
 * identifiers. Results are sorted by file path so the scan is deterministic.
 */
export async function scanAgents(options: ScanAgentsOptions): Promise<AgentScanResult[]> {
	const sourceRoot = path.resolve(options.sourceRoot);
	const patterns =
		options.agents === undefined
			? DEFAULT_SCAN_PATTERNS
			: typeof options.agents === 'string'
				? [options.agents]
				: [...options.agents];

	const matches = await glob(patterns, {
		cwd: sourceRoot,
		ignore: EXCLUDED_DIRECTORY_PATTERNS,
		absolute: true,
		onlyFiles: true,
	});

	const filePaths = [...new Set(matches.map((match) => path.normalize(match)))]
		.filter((filePath) => isAgentModulePath(filePath))
		.sort(comparePaths);

	const results: AgentScanResult[] = [];
	await Promise.all(
		filePaths.map(async (filePath) => {
			if (await hasAgentDirective(filePath)) {
				const identity = agentIdentity(filePath);
				results.push({
					filePath,
					identity,
					className: agentClassName(identity),
					bindingName: agentBindingName(identity),
				});
			}
		}),
	);
	results.sort((a, b) => comparePaths(a.filePath, b.filePath));

	assertValidIdentities(results);
	assertUniqueIdentities(results);
	return results;
}

/** Whether `filePath` has an extension that can carry the agent directive. */
export function isAgentModulePath(filePath: string): boolean {
	return AGENT_MODULE_EXTENSIONS.has(path.extname(filePath));
}

/** `Flue<PascalCase>Agent` — matches the CLI Cloudflare codegen exactly. */
export function agentClassName(identity: string): string {
	return `Flue${pascalCaseName(identity)}Agent`;
}

/** `FLUE_<SNAKE_UPPER>_AGENT` — matches the CLI Cloudflare codegen exactly. */
export function agentBindingName(identity: string): string {
	return `FLUE_${identity.replace(/-/g, '_').toUpperCase()}_AGENT`;
}

function pascalCaseName(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

function agentIdentity(filePath: string): string {
	const basename = path.basename(filePath);
	return basename.slice(0, -path.extname(basename).length);
}

function comparePaths(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Minimal structural view of the oxc ESTree output: directive-prologue
 * statements are `ExpressionStatement`s carrying a `directive` field with the
 * RAW source between the quotes. Matching on the raw text mirrors how
 * ECMAScript recognizes `"use strict"` — escape sequences (e.g.
 * `'use\x20agent'`) do not count as the directive.
 */
interface ParsedStatement {
	readonly type: string;
	readonly directive?: string;
	readonly start?: number;
}

/**
 * Whether a parsed program body opens with the `'use agent'` directive in its
 * directive prologue. Shared by the scanner and the `@flue/vite` build
 * transform so the two can never disagree about what counts as an agent
 * module.
 */
export function programBodyHasAgentDirective(body: readonly unknown[]): boolean {
	return findAgentDirectiveStatement(body) !== undefined;
}

/** The `'use agent'` directive-prologue statement of a parsed program body, if any. */
export function findAgentDirectiveStatement(
	body: readonly unknown[],
): ParsedStatement | undefined {
	for (const entry of body) {
		const statement = entry as ParsedStatement;
		// The directive prologue ends at the first non-directive statement.
		if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') {
			break;
		}
		if (statement.directive === AGENT_DIRECTIVE) return statement;
	}
	return undefined;
}

/** 1-based line/column of a character offset, for `file:line:column` diagnostics. */
export function sourcePosition(code: string, offset: number): { line: number; column: number } {
	const bounded = Math.max(0, Math.min(offset, code.length));
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < bounded; index += 1) {
		if (code.charCodeAt(index) === 10) {
			line += 1;
			lineStart = index + 1;
		}
	}
	return { line, column: bounded - lineStart + 1 };
}

/**
 * Whether `code` (an on-disk module's source) declares the `'use agent'`
 * directive. Parse failures throw {@link AgentModuleParseError}: silently
 * skipping a broken candidate would let a build succeed without the agent the
 * file declares.
 */
export async function codeHasAgentDirective(code: string, filePath: string): Promise<boolean> {
	// Cheap candidate pre-filter: the raw directive text must appear somewhere
	// in the file for the prologue to contain it (raw-text matching, so this
	// can never produce a false negative). Only candidates are parsed.
	if (!code.includes(AGENT_DIRECTIVE)) return false;
	let body: readonly unknown[];
	try {
		const program = await parseAstAsync(code, { lang: parserLangForFile(filePath) }, filePath);
		body = program.body as readonly unknown[];
	} catch (error) {
		throw new AgentModuleParseError(filePath, error);
	}
	return programBodyHasAgentDirective(body);
}

/**
 * The dialect must be selected explicitly: `parseAstAsync` does not derive it
 * from the filename argument and otherwise parses in JS mode, rejecting
 * TypeScript-only syntax in agent modules.
 */
export function parserLangForFile(filePath: string): 'ts' | 'js' {
	return /\.(?:ts|mts|cts)$/.test(filePath) ? 'ts' : 'js';
}

async function hasAgentDirective(filePath: string): Promise<boolean> {
	const code = await fs.promises.readFile(filePath, 'utf8');
	return codeHasAgentDirective(code, filePath);
}

function assertValidIdentities(results: readonly AgentScanResult[]): void {
	const invalidAgents = results
		.filter((result) => !AGENT_IDENTITY_PATTERN.test(result.identity))
		.map(({ identity, filePath }) => ({ identity, filePath }));
	if (invalidAgents.length > 0) throw new InvalidAgentIdentityError(invalidAgents);
}

function assertUniqueIdentities(results: readonly AgentScanResult[]): void {
	const byIdentity = new Map<string, string[]>();
	for (const result of results) {
		const filePaths = byIdentity.get(result.identity) ?? [];
		filePaths.push(result.filePath);
		byIdentity.set(result.identity, filePaths);
	}
	const duplicates = [...byIdentity]
		.filter(([, filePaths]) => filePaths.length > 1)
		.map(([identity, filePaths]) => ({ identity, filePaths }));
	if (duplicates.length > 0) throw new DuplicateAgentIdentityError(duplicates);
}
