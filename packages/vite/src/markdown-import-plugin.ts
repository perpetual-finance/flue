/**
 * Flue's markdown/skill import transform.
 *
 * Detection is by SPECIFIER, not by import attribute — TypeScript already
 * types these imports purely by suffix (the ambient `*.md`, `SKILL.md`, and
 * `*?skill` module declarations), so the specifier carries all the
 * information and an attribute would duplicate it:
 *
 *   - an import that resolves to a file named `SKILL.md` packages the whole
 *     skill directory (bundle, metadata, reference);
 *   - a `?skill` query opts any other `.md` file in explicitly;
 *   - every other bare `.md` import loads as a markdown text module;
 *   - Vite-native queries (`?raw`, `?url`, ...) are left to Vite.
 *
 * The legacy `with { type: 'skill' | 'markdown' }` attributes are rejected
 * with a pointer at the new forms.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackagedSkillDirectory } from '@flue/runtime';
import { buildPackagedSkill, parseSkillMarkdown } from '@flue/runtime/internal';
import { ulid } from 'ulidx';
import { normalizePath, type Plugin, transformWithOxc } from 'vite';

const MARKDOWN_MODULE_PREFIX = '\0flue-markdown:';
const SKILL_MODULE_PREFIX = '\0flue-skill:';
const ENCODED_SKILL_MODULE_PREFIX = '__x00__flue-skill:';
const PACKAGED_FILE_WARNING_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'.cache',
	'.turbo',
	'.wrangler',
	'dist',
	'node_modules',
]);
const SENSITIVE_DIRECTORIES = new Set(['.aws', '.gnupg', '.ssh']);
const EXCLUDED_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '_netrc', 'credentials.json']);
const SENSITIVE_FILE_PATTERNS = [/\.key$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^secrets?(?:\.|$)/i];

/**
 * Handles Flue's markdown and skill imports in one plugin so each module in
 * the graph is type-stripped and parsed once per (re)build, and so the two
 * module kinds cannot drift apart.
 */
export function markdownImportPlugin(): Plugin {
	let viteRoot = '';
	const internalModuleToken = ulid();
	const internalSkillModulePrefix = `${SKILL_MODULE_PREFIX}${internalModuleToken}:`;
	const encodedInternalSkillModulePrefix = `__x00__flue-skill:${internalModuleToken}:`;
	const trackedSkillDirectories = new Set<string>();

	return {
		name: 'flue-markdown-imports',
		enforce: 'pre',
		configResolved(config) {
			viteRoot = config.root;
		},
		buildStart() {
			// Vite app builds can run multiple build phases with fresh plugin
			// drivers; per-build bookkeeping must not leak across phases.
			trackedSkillDirectories.clear();
		},
		transform: {
			// Only modules that could carry a `.md` import (including `?skill`
			// forms and legacy attributes) reach the handler, which type-strips
			// and parses — by far this plugin's hottest path.
			filter: {
				id: { include: /\.[cm]?[jt]sx?(?:\?|$)/i },
				code: { include: [/\.md/] },
			},
			async handler(code, id) {
				if (!/\.[cm]?[jt]sx?(?:\?|$)/i.test(id)) return null;
				const importerPath = id.split('?')[0] ?? id;
			const parseableCode = /\.[cm]?tsx?(?:\?|$)/i.test(id)
				? (await transformWithOxc(code, importerPath, {})).code
				: code;
			const ast = this.parse(parseableCode) as unknown as ModuleAst;
			assertNoDynamicSkillImports(ast);
			const markdownImports = collectMarkdownImports(ast);
			if (markdownImports.length === 0) return null;
			const replacements: Array<MarkdownImport & { moduleId: string }> = [];
			for (const declaration of markdownImports) {
				const query = importQuery(declaration.specifier);
				if (query !== undefined && query !== 'skill') continue; // ?raw, ?url, ... — Vite's
				const bareSpecifier = stripQueryAndHash(declaration.specifier);
				const rootRelativePath = bareSpecifier.startsWith('/')
					? path.resolve(viteRoot, bareSpecifier.slice(1))
					: undefined;
				const resolved = rootRelativePath
					? { id: rootRelativePath, external: false }
					: await this.resolve(bareSpecifier, importerPath, { skipSelf: true });
				if (!resolved || resolved.external) {
					throw new Error(`[flue] Unable to resolve markdown import: ${declaration.specifier}`);
				}
				const filesystemPath = stripQueryAndHash(resolved.id);
				if (!path.isAbsolute(filesystemPath)) {
					throw new Error(
						`[flue] Markdown imports must resolve to a filesystem path: ${declaration.specifier}`,
					);
				}
				const resolvedPath = canonicalPath(filesystemPath);
				// A skill: the explicit `?skill` opt-in, or any import that
				// RESOLVES to a file named SKILL.md (aliases included).
				if (query === 'skill' || isSkillMarkdownPath(resolvedPath)) {
					replacements.push({
						...declaration,
						moduleId: `${internalSkillModulePrefix}${resolvedPath}`,
					});
					continue;
				}
				replacements.push({ ...declaration, moduleId: `${MARKDOWN_MODULE_PREFIX}${resolvedPath}` });
			}
			if (replacements.length === 0) return null;
			let transformed = parseableCode;
			for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
				transformed = `${transformed.slice(0, replacement.start)}${JSON.stringify(replacement.moduleId)}${transformed.slice(replacement.end)}`;
			}
			return { code: transformed, map: null };
			},
		},
		resolveId(source, importer) {
			if (source.startsWith(MARKDOWN_MODULE_PREFIX)) return source;
			const internalModuleId = decodeSkillModuleId(
				source,
				internalSkillModulePrefix,
				encodedInternalSkillModulePrefix,
			);
			if (internalModuleId) return internalModuleId;
			if (source.startsWith(SKILL_MODULE_PREFIX) || source.includes(ENCODED_SKILL_MODULE_PREFIX)) {
				throw new Error(
					'[flue] Internal packaged-skill module IDs cannot be imported directly. Use a static SKILL.md import.',
				);
			}
			if (!importer) return null;
			if (isSkillMarkdownPath(source) || importQuery(source) === 'skill') {
				// The transform packages these automatically; reaching raw
				// resolution means the importer was outside the transform's
				// module filter (a non-JS/TS importer, say).
				throw new Error(
					`[flue] Skill import "${source}" reached resolution untransformed. Skill imports are packaged automatically from .ts/.js importers; import it from a module the Flue transform processes.`,
				);
			}
			return null;
		},
		hotUpdate(options) {
			const changedPath = canonicalPath(options.file);

			// A single-file (`?skill`) skill module's id is the file itself.
			const fileModule = this.environment.moduleGraph.getModuleById(
				`${internalSkillModulePrefix}${changedPath}`,
			);
			if (fileModule) {
				this.environment.moduleGraph.invalidateModule(fileModule);
				return [fileModule];
			}

			const directory = [...trackedSkillDirectories].find((trackedDirectory) =>
				isWithinDirectory(changedPath, trackedDirectory),
			);
			if (directory) {
				const skillPath = `${directory}/SKILL.md`;
				const modules = [
					this.environment.moduleGraph.getModuleById(`${internalSkillModulePrefix}${skillPath}`),
				].filter((module) => module !== undefined);
				for (const module of modules) this.environment.moduleGraph.invalidateModule(module);
				return modules;
			}
		},
		async load(id) {
			if (id.startsWith(MARKDOWN_MODULE_PREFIX)) {
				const markdownPath = id.slice(MARKDOWN_MODULE_PREFIX.length);
				this.addWatchFile(markdownPath);
				return `export default ${JSON.stringify(await fs.promises.readFile(markdownPath, 'utf8'))};`;
			}
			if (!id.startsWith(internalSkillModulePrefix)) return null;
			const skillPath = id.slice(internalSkillModulePrefix.length);
			// Dev invalidation needs no addWatchFile: the dev watcher covers the
			// source root, and hotUpdate maps changed files back to skill modules
			// (single-file skills by module id, SKILL.md layouts by directory).
			if (isSkillMarkdownPath(skillPath)) {
				trackedSkillDirectories.add(canonicalPath(path.dirname(skillPath)));
			}
			const packagedSkill = await packageSkill(skillPath);
			return [
				`import { createSkillReference } from '@flue/runtime/internal';`,
				`const directory = ${JSON.stringify(packagedSkill)};`,
				'export default createSkillReference(directory);',
			].join('\n');
		},
	};
}

async function packageSkill(skillPath: string): Promise<PackagedSkillDirectory> {
	if (!isSkillMarkdownPath(skillPath)) return packageSingleFileSkill(skillPath);
	const directory = path.dirname(skillPath);
	const parsed = parseSkillMarkdown(await fs.promises.readFile(skillPath, 'utf8'), {
		directoryName: path.basename(directory),
		path: skillPath,
	});
	const files = [];
	for (const filePath of await collectFiles(directory)) {
		const content = await fs.promises.readFile(filePath);
		if (content.byteLength > PACKAGED_FILE_WARNING_BYTES) {
			console.warn(
				`[flue] Skill file "${filePath}" exceeds 1MB and will be packaged into the deployed application for lazy access.`,
			);
		}
		files.push({
			path: normalizePath(path.relative(directory, filePath)),
			content: new Uint8Array(content),
		});
	}
	return buildPackagedSkill({ name: parsed.name, description: parsed.description, files });
}

/**
 * An odd-named `?skill` file is a SINGLE-FILE skill: the frontmatter name is
 * authoritative (no directory exists to match against — the Agent Skills
 * name↔directory rule presumes the SKILL.md layout), and only the file itself
 * is packaged. Packaging its containing directory would sweep in unrelated
 * siblings — a free-floating skill file makes no claim over its neighbors.
 * Inside the package the file becomes `SKILL.md`, so the packaged output is
 * spec-shaped like every other skill. Supporting files want the real
 * `<name>/SKILL.md` layout.
 */
async function packageSingleFileSkill(skillPath: string): Promise<PackagedSkillDirectory> {
	const content = await fs.promises.readFile(skillPath);
	const parsed = parseSkillMarkdown(content.toString('utf8'), { path: skillPath });
	return buildPackagedSkill({
		name: parsed.name,
		description: parsed.description,
		files: [{ path: 'SKILL.md', content: new Uint8Array(content) }],
	});
}

function canonicalPath(filePath: string): string {
	let unresolvedPath = filePath;
	const suffixes: string[] = [];
	while (!fs.existsSync(unresolvedPath)) {
		const parentPath = path.dirname(unresolvedPath);
		if (parentPath === unresolvedPath) return normalizePath(filePath);
		suffixes.unshift(path.basename(unresolvedPath));
		unresolvedPath = parentPath;
	}
	return normalizePath(path.join(fs.realpathSync.native(unresolvedPath), ...suffixes));
}

function isWithinDirectory(filePath: string, directory: string): boolean {
	return filePath === directory || filePath.startsWith(`${directory}/`);
}

async function collectFiles(directory: string, skillRoot = directory): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		const relativePath = normalizePath(path.relative(skillRoot, absolutePath));
		if (entry.isSymbolicLink()) {
			throw new Error(
				`[flue] Skill directory "${skillRoot}" contains symbolic link "${relativePath}", which cannot be packaged. Replace it with a regular file or directory.`,
			);
		}
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRECTORIES.has(entry.name)) {
				console.warn(
					`[flue] Excluding skill directory "${relativePath}" from the deployed application package because it is generated or repository metadata.`,
				);
				continue;
			}
			if (SENSITIVE_DIRECTORIES.has(entry.name.toLowerCase())) {
				throw new Error(
					`[flue] Imported skill directory "${skillRoot}" contains sensitive directory "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			files.push(...(await collectFiles(absolutePath, skillRoot)));
		} else if (entry.isFile()) {
			if (isSensitiveFile(entry.name)) {
				throw new Error(
					`[flue] Imported skill directory "${skillRoot}" contains sensitive file "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			if (isExcludedFile(entry.name)) {
				console.warn(
					`[flue] Excluding skill file "${relativePath}" from the deployed application package because it is generated content.`,
				);
				continue;
			}
			files.push(absolutePath);
		}
	}
	return files.sort();
}

function isSensitiveFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		EXCLUDED_FILES.has(lowerFilename) ||
		lowerFilename === '.dev.vars' ||
		lowerFilename.startsWith('.dev.vars.') ||
		lowerFilename === '.env' ||
		lowerFilename.startsWith('.env.') ||
		SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filename))
	);
}

function isExcludedFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		lowerFilename === '.ds_store' ||
		lowerFilename.endsWith('.swp') ||
		lowerFilename.endsWith('.swo') ||
		lowerFilename.endsWith('~')
	);
}

function decodeSkillModuleId(
	source: string,
	internalPrefix: string,
	encodedInternalPrefix: string,
): string | undefined {
	if (source.startsWith(internalPrefix)) return source;
	const encodedIndex = source.indexOf(encodedInternalPrefix);
	if (encodedIndex !== -1)
		return `${internalPrefix}${source.slice(encodedIndex + encodedInternalPrefix.length)}`;
	return undefined;
}

function stripQueryAndHash(specifier: string): string {
	return specifier.split(/[?#]/, 1)[0] ?? specifier;
}

function isSkillMarkdownPath(specifier: string): boolean {
	return path.basename(stripQueryAndHash(specifier)) === 'SKILL.md';
}

interface ModuleAst {
	body: unknown[];
}

interface AstNode {
	type?: string;
	source?: { value?: unknown; start?: number; end?: number };
	attributes?: Array<{ key?: { name?: unknown; value?: unknown }; value?: { value?: unknown } }>;
}

interface MarkdownImport {
	specifier: string;
	start: number;
	end: number;
}

/** The query string of an import specifier (`'./a.md?skill'` → `'skill'`), if any. */
function importQuery(specifier: string): string | undefined {
	const index = specifier.indexOf('?');
	if (index === -1) return undefined;
	return specifier.slice(index + 1).split('#', 1)[0];
}

/**
 * Every static import whose specifier targets a `.md` file (queries included).
 * A legacy `with { type: 'markdown' | 'skill' }` attribute throws with the
 * replacement forms; other attribute types (`json`, ...) are none of ours.
 */
function collectMarkdownImports(ast: ModuleAst): MarkdownImport[] {
	const imports: MarkdownImport[] = [];
	for (const entry of ast.body) {
		const declaration = entry as AstNode;
		if (
			declaration.type !== 'ImportDeclaration' &&
			declaration.type !== 'ExportNamedDeclaration' &&
			declaration.type !== 'ExportAllDeclaration'
		)
			continue;
		const specifier = declaration.source?.value;
		if (typeof specifier !== 'string') continue;
		const legacyAttribute = declaration.attributes?.find((attribute) => {
			const key = attribute.key?.name ?? attribute.key?.value;
			const value = attribute.value?.value;
			return key === 'type' && (value === 'markdown' || value === 'skill');
		});
		if (legacyAttribute) {
			throw new Error(
				`[flue] Import attributes are no longer used for "${specifier}". ` +
					'SKILL.md imports are packaged automatically, any other .md import loads as markdown text, ' +
					"and `?skill` opts an odd-named skill file in (`import s from './notes.md?skill'`). " +
					'Remove the `with { type: ... }` clause.',
			);
		}
		if (!/\.md$/i.test(stripQueryAndHash(specifier))) continue;
		const start = declaration.source?.start;
		const end = declaration.source?.end;
		if (typeof start !== 'number' || typeof end !== 'number') {
			throw new Error(`[flue] Unable to transform markdown import: ${specifier}`);
		}
		imports.push({ specifier, start, end });
	}
	return imports;
}

function assertNoDynamicSkillImports(ast: ModuleAst): void {
	visitAst(ast, (node) => {
		if (node.type !== 'ImportExpression') return;
		const specifier = node.source?.value;
		if (
			typeof specifier === 'string' &&
			(isSkillMarkdownPath(specifier) || importQuery(specifier) === 'skill')
		) {
			throw new Error(
				`[flue] Dynamic skill import "${specifier}" is unsupported. Use a static SKILL.md import.`,
			);
		}
	});
}

function visitAst(value: unknown, visit: (node: AstNode) => void): void {
	if (!value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) visitAst(item, visit);
		return;
	}
	const node = value as AstNode & Record<string, unknown>;
	if (typeof node.type === 'string') visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key !== 'start' && key !== 'end' && key !== 'loc') visitAst(child, visit);
	}
}
