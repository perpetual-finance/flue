/**
 * Cloudflare target adapter for the `flue()` plugin.
 *
 * Flue's job on Cloudflare is input preparation, not serving: the sibling
 * `@cloudflare/vite-plugin` owns the Worker environments, workerd dev, build
 * output, and preview. Flue prepares two generated inputs at
 * config-resolution time — before the sibling resolves its configuration —
 * and keeps them fresh in dev:
 *
 *   1. `<root>/.flue-vite/_entry.ts` — the Worker entry
 *      ({@link generateCloudflareEntry}), and
 *   2. `<root>/.flue-vite.wrangler.jsonc` — the user's wrangler config merged
 *      with Flue's additions (`main` + per-agent Durable Object bindings).
 *
 * The handoff mechanism is the documented
 * `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` environment variable: the sibling
 * plugin resolves its config path as `cloudflare({ configPath }) ??
 * loadEnv(..., 'CLOUDFLARE_')`, and Vite's `loadEnv` includes matching
 * `process.env` variables. Setting the variable in flue's `config` hook —
 * which runs before the sibling's because `flue()` precedes `cloudflare()`
 * in the plugin array (enforced with a diagnostic) — makes the sibling read
 * the generated file. Both files are written content-aware so unchanged
 * regenerations never trigger the sibling's config watcher.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedFlueProject } from '@flue/runtime/config';
import type { AgentScanResult } from './agent-scan.ts';
import { generateCloudflareEntry } from './cloudflare-entry.ts';
import {
	mergeFlueAdditions,
	readUserWranglerConfig,
	validateUserWranglerConfig,
} from './wrangler-merge.ts';

/** The generated Worker entry, relative to the project root (wrangler `main`). */
const GENERATED_ENTRY_RELATIVE_PATH = '.flue-vite/_entry.ts';

/** The generated wrangler config the sibling plugin consumes, relative to root. */
const GENERATED_WRANGLER_BASENAME = '.flue-vite.wrangler.jsonc';

/** The env var `@cloudflare/vite-plugin` reads its config path from. */
export const CLOUDFLARE_WRANGLER_CONFIG_PATH_ENV = 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH';

/** Authored wrangler config basenames (the user's file, never modified). */
const AUTHORED_WRANGLER_BASENAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function generatedEntryPath(root: string): string {
	return path.join(root, '.flue-vite', '_entry.ts');
}

function generatedWranglerPath(root: string): string {
	return path.join(root, GENERATED_WRANGLER_BASENAME);
}

/** Whether a (posix-normalized) watched path is one of Flue's generated Cloudflare outputs. */
export function isGeneratedCloudflarePath(filePath: string, normalizedRoot: string): boolean {
	return (
		filePath === `${normalizedRoot}/${GENERATED_WRANGLER_BASENAME}` ||
		filePath.startsWith(`${normalizedRoot}/.flue-vite/`) ||
		filePath.startsWith(`${normalizedRoot}/.wrangler/`)
	);
}

/** Whether a (posix-normalized) watched path is the user's authored wrangler config. */
export function isAuthoredWranglerPath(filePath: string, normalizedRoot: string): boolean {
	return AUTHORED_WRANGLER_BASENAMES.some(
		(basename) => filePath === `${normalizedRoot}/${basename}`,
	);
}

/** Parity with the legacy Cloudflare build (build-plugin-cloudflare.ts). */
function dbOnCloudflareError(): Error {
	return new Error(
		`[flue] Custom persistence (db.ts) is not supported on the Cloudflare target. ` +
			`Cloudflare agents use Durable Object SQLite automatically. ` +
			`Remove the db.ts file or move it outside the source root.`,
	);
}

export interface PrepareCloudflareInputsOptions {
	readonly root: string;
	readonly project: ResolvedFlueProject;
	readonly agents: readonly AgentScanResult[];
}

export interface PreparedCloudflareInputs {
	/** Absolute path of the generated wrangler config. */
	readonly wranglerConfigPath: string;
	/** Whether either generated file's content actually changed on disk. */
	readonly changed: boolean;
}

/**
 * Generate (content-aware) the Worker entry and the merged wrangler config.
 * Throws — without touching either file — when the project uses `db.ts` or
 * the user's wrangler config fails validation, so a broken regeneration never
 * clobbers the last good inputs.
 */
export async function prepareCloudflareInputs(
	options: PrepareCloudflareInputsOptions,
): Promise<PreparedCloudflareInputs> {
	const { root, project, agents } = options;
	if (project.db) throw dbOnCloudflareError();
	if (!project.app) {
		throw new Error('[flue] Internal: prepareCloudflareInputs requires a resolved app entry.');
	}

	const entrySource = generateCloudflareEntry({
		appEntry: project.app,
		cloudflareEntry: project.cloudflare,
		agents,
	});

	// Read and validate the user's wrangler config (if any). The user's file
	// lives at the project root and is never modified; the composed input
	// config is also written at the project root so the official plugin's
	// local variable discovery continues to find `.dev.vars` and `.env` files.
	const { config: userConfig, effectiveConfig } = await readUserWranglerConfig(root);
	validateUserWranglerConfig({ config: userConfig, effectiveConfig });

	// Flue's contributions to the wrangler config. Everything else in the
	// user's wrangler.jsonc passes through untouched during merge. Migration
	// history stays entirely user-authored (adding an agent = file + mount +
	// migration tag).
	const merged = mergeFlueAdditions(userConfig, {
		defaultName: path.basename(root) || 'flue-agents',
		main: GENERATED_ENTRY_RELATIVE_PATH,
		doBindings: agents.map((agent) => ({
			name: agent.bindingName,
			class_name: agent.className,
		})),
	});

	// Always include the wrangler JSON schema reference if absent so the
	// generated file gets editor validation if someone opens it directly.
	if (typeof merged.$schema !== 'string') {
		merged.$schema = './node_modules/wrangler/config-schema.json';
	}

	const entryChanged = writeFileIfChanged(generatedEntryPath(root), entrySource);
	const wranglerConfigPath = generatedWranglerPath(root);
	const wranglerChanged = writeFileIfChanged(
		wranglerConfigPath,
		`${JSON.stringify(merged, null, 2)}\n`,
	);
	return { wranglerConfigPath, changed: entryChanged || wranglerChanged };
}

/**
 * Content-aware write: only touch the file when the content differs, so
 * watchers (notably the sibling plugin's config watcher, which restarts the
 * dev server on change) never see spurious mtime updates.
 */
function writeFileIfChanged(filePath: string, content: string): boolean {
	if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) return false;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, 'utf8');
	return true;
}
