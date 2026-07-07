#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParseArgsOptionsConfig, parseArgs as parseNodeArgs } from 'node:util';
import { resolveFlueConfigPath } from '@flue/runtime/config';
import type { ConversationStreamChunk } from '@flue/sdk';
import { determineAgent } from '@vercel/detect-agent';
import MiniSearch from 'minisearch';
import pc from 'picocolors';
import {
	type AbortableExecution,
	closeExecutionForSignal,
} from '../src/lib/console-shutdown.ts';
import { createEnvLoader, type EnvLoader, selectEnvFile } from '../src/lib/env.ts';
import { createLineEventPresenter } from '../src/lib/line-event-presenter.ts';
import { createLocalAgentRun } from '../src/lib/run-local.ts';
import { brand, brandRows, error as cliError, note, row, success } from '../src/lib/terminal.ts';
import { BLUEPRINTS, KIND_ROOTS } from './_blueprints.generated.ts';

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function printUsage(log: (message: string) => void = console.error) {
	log(
		'Usage:\n' +
			'  flue run    <path> --message <text> [--id <conversation-id>] [--data <json>] [--env <path>] [--json]\n' +
			'  flue init   --target <node|cloudflare> [--root <path>] [--force]\n' +
			'  flue add    [<kind> <name|url>] [--print]\n' +
			'  flue update <kind> <name|url> [--print]\n' +
			'  flue docs   [read <path> | search <query>]\n' +
			'\n' +
			'Commands:\n' +
			'  run    Run one agent module locally (transport-free, no HTTP), print its reply, then exit.\n' +
			'  init   Scaffold a starter project skeleton (flue.config.ts, vite.config.ts, src/app.ts) in the target directory.\n' +
			'  add    Fetch a blueprint implementation guide for an AI coding agent to follow.\n' +
			'  update Fetch an updated blueprint implementation guide for an AI coding agent to follow.\n' +
			'  docs   Browse the Flue docs. No args lists pages; `read` prints a page as markdown; `search` prints JSON results.\n' +
			'\n' +
			'  Dev servers and production builds are owned by Vite (`vite dev` / `vite build`\n' +
			'  with the `flue()` plugin from @flue/vite in vite.config.ts).\n' +
			'\n' +
			'Flags:\n' +
			'  --message <text>     (flue run) The user message submitted to the agent. Required.\n' +
			'  --id <id>            (flue run) Conversation id to create or continue. Default: a fresh id, printed.\n' +
			'  --data <json>        (flue run) Instance-creation data (JSON). Takes effect only on the conversation\'s first contact; read with useInitialData().\n' +
			'  --json               (flue run) Print a JSON result envelope to stdout instead of the message text.\n' +
			'  --env <path>         (flue run) Select one alternate .env-format file, loaded before the run.\n' +
			'                       Without --env, `flue run` loads <project>/.env when present. Shell values win.\n' +
			'  --print              (flue add/update) Print the raw blueprint Markdown to stdout regardless of whether the caller is an agent.\n' +
			'  --target <t>         (flue init) Project target: node or cloudflare. Required.\n' +
			'  --root <path>        (flue init) Directory to scaffold into. Default: current working directory.\n' +
			'  --force              (flue init) Overwrite an existing flue.config.* in the target directory.\n' +
			'                       Other scaffolded files are only created when absent, never overwritten.\n' +
			'\n' +
			'Examples:\n' +
			'  flue run src/agents/hello.ts --message "Hi there"\n' +
			'  flue run src/agents/hello.ts --message "And then?" --id support-4821 --env .env.staging\n' +
			'  flue init --target node\n' +
			'  flue add\n' +
			'  flue add sandbox daytona | claude\n' +
			'  flue add channel slack | codex\n' +
			'  flue add sandbox https://e2b.dev | claude\n' +
			'  flue add channel https://developers.notion.com/reference/webhooks | codex\n' +
			'  flue update channel slack | claude\n' +
			'  flue docs\n' +
			'  flue docs read guide/sandboxes\n' +
			'  flue docs search "durable execution"\n' +
			'\n' +
			'Note: set the model in `defineAgent(() => ({ model: "provider-id/model-id" }))` ' +
			'or per-call `{ model: ... }` on prompt/skill/task.',
	);
}

interface RunArgs {
	command: 'run';
	/** Path of the agent module (relative or absolute). */
	modulePath: string;
	message: string;
	id: string | undefined;
	data: unknown;
	json: boolean;
	envFile: string | undefined;
}

interface BlueprintCommandOptions {
	kind: string;
	target: string;
	print: boolean;
}

interface AddArgs extends BlueprintCommandOptions {
	command: 'add';
}

interface UpdateArgs extends BlueprintCommandOptions {
	command: 'update';
}

type BlueprintCommandArgs = AddArgs | UpdateArgs;

interface DocsArgs {
	command: 'docs';
	action: 'list' | 'read' | 'search';
	/** Page path for `read`, query for `search`, empty for `list`. */
	value: string;
}

interface InitArgs {
	command: 'init';
	target: 'node' | 'cloudflare';
	/** Explicit --root value, or undefined to default to cwd. Absolute when set. */
	explicitRoot: string | undefined;
	force: boolean;
}

type ParsedArgs = RunArgs | BlueprintCommandArgs | DocsArgs | InitArgs;

type ParsedOptionToken = Extract<
	NonNullable<ReturnType<typeof parseNodeArgs>['tokens']>[number],
	{ kind: 'option' }
>;
type CliValue = string | boolean | Array<string | boolean> | undefined;
type CliValues = Record<string, CliValue>;

function fail(message: string, usage = false): never {
	console.error(message);
	if (usage) printUsage();
	process.exit(1);
}

function parseCommandOptions(
	command: string,
	args: string[],
	options: ParseArgsOptionsConfig,
	allowed: ReadonlySet<string>,
	known: ReadonlySet<string> = allowed,
) {
	const parsed = parseNodeArgs({
		args,
		options,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});
	for (const token of (parsed.tokens ?? []).filter(
		(token): token is ParsedOptionToken => token.kind === 'option',
	)) {
		const optionName = token.name;
		if (!known.has(token.rawName)) {
			fail(`Unknown flag for \`flue ${command}\`: ${token.rawName}`, true);
		}
		if (!allowed.has(token.rawName)) {
			fail(`\`flue ${command}\` does not accept ${token.rawName}.`);
		}
		// Prevent a following known flag from being consumed as this string option's value.
		if (
			options[optionName]?.type === 'string' &&
			token.inlineValue === false &&
			token.value !== undefined
		) {
			const separator = token.value.indexOf('=');
			const valueName = separator === -1 ? token.value : token.value.slice(0, separator);
			if (known.has(valueName)) fail(`Missing value for ${token.rawName}`);
		}
		if (options[optionName]?.type === 'boolean' && token.value !== undefined) {
			fail(`${token.rawName} does not accept a value`);
		}
	}
	return { positionals: parsed.positionals, values: parsed.values as CliValues };
}

function stringFlag(values: CliValues, name: string, missingMessage: string): string | undefined {
	const value = values[name];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.length === 0) fail(missingMessage);
	return value;
}

function stringListFlag(values: CliValues, name: string, missingMessage: string): string[] {
	const value = values[name];
	const valuesList = value === undefined ? [] : Array.isArray(value) ? value : [value];
	const strings: string[] = [];
	for (const item of valuesList) {
		if (typeof item !== 'string' || item.length === 0) fail(missingMessage);
		strings.push(item);
	}
	return strings;
}

function booleanFlag(values: CliValues, name: string, flag: string): boolean {
	const value = values[name];
	if (value === undefined) return false;
	if (value !== true) fail(`${flag} does not accept a value`);
	return true;
}

function targetFlag(value: string | undefined): 'node' | 'cloudflare' | undefined {
	if (value !== undefined && value !== 'node' && value !== 'cloudflare') {
		fail(`Invalid target: "${value}". Supported targets: node, cloudflare`);
	}
	return value;
}

function pathFlag(values: CliValues, name: string, missingMessage: string): string | undefined {
	const value = stringFlag(values, name, missingMessage);
	return value ? path.resolve(value) : undefined;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseBlueprintCommandArgs(
	command: 'add' | 'update',
	rest: string[],
): BlueprintCommandArgs {
	const { positionals, values } = parseCommandOptions(
		command,
		rest,
		{ print: { type: 'boolean' } },
		new Set(['--print']),
	);
	const print = booleanFlag(values, 'print', '--print');

	if (command === 'add' && positionals.length === 0) {
		return { command, kind: '', target: '', print };
	}

	if (positionals.length < 2) {
		console.error(
			`Missing blueprint ${positionals.length === 0 ? 'kind and name or URL' : 'name or URL'}.\n\nUsage:\n  flue ${command} <kind> <name|url> [--print]`,
		);
		process.exit(1);
	}

	const extra = positionals[2];
	if (extra !== undefined) {
		console.error(`Unexpected extra argument for \`flue ${command}\`: ${extra}`);
		printUsage();
		process.exit(1);
	}

	return {
		command,
		kind: positionals[0] ?? '',
		target: positionals[1] ?? '',
		print,
	};
}

function parseDocsArgs(rest: string[]): DocsArgs {
	const [action, ...values] = rest;

	if (action === undefined) {
		return { command: 'docs', action: 'list', value: '' };
	}

	if (action === 'read') {
		const value = values[0];
		if (!value) {
			console.error('Missing docs page path.\n\nUsage:\n  flue docs read <path>');
			process.exit(1);
		}
		const extra = values[1];
		if (extra !== undefined) {
			console.error(`Unexpected extra argument for \`flue docs read\`: ${extra}`);
			process.exit(1);
		}
		return { command: 'docs', action: 'read', value };
	}

	if (action === 'search') {
		const value = values.join(' ').trim();
		if (!value) {
			console.error('Missing search query.\n\nUsage:\n  flue docs search <query>');
			process.exit(1);
		}
		return { command: 'docs', action: 'search', value };
	}

	console.error(
		`Unknown \`flue docs\` subcommand: ${action}\n\n` +
			'Usage:\n' +
			'  flue docs                  List all documentation pages\n' +
			'  flue docs read <path>      Print a documentation page as markdown\n' +
			'  flue docs search <query>   Search the documentation (JSON results)\n' +
			(action.includes('/') ? `\nDid you mean \`flue docs read ${action}\`?\n` : ''),
	);
	process.exit(1);
}

function parseInitArgs(rest: string[]): InitArgs {
	const { positionals, values } = parseCommandOptions(
		'init',
		rest,
		{
			target: { type: 'string' },
			root: { type: 'string' },
			force: { type: 'boolean' },
		},
		new Set(['--target', '--root', '--force']),
	);
	const target = targetFlag(stringFlag(values, 'target', 'Missing value for --target'));

	for (const positional of positionals) {
		fail(`Unexpected argument for \`flue init\`: ${positional}`, true);
	}

	if (!target) {
		fail('Missing required --target flag for init command.', true);
	}

	return {
		command: 'init',
		target,
		explicitRoot: pathFlag(values, 'root', 'Missing value for --root'),
		force: booleanFlag(values, 'force', '--force'),
	};
}

/**
 * Flags the legacy HTTP-based `flue run <name>` accepted. Each one hard-errors
 * with a pointer at its replacement so old invocations fail loudly and
 * helpfully rather than as generic "unknown flag" noise.
 */
const DROPPED_RUN_FLAGS: Record<string, string> = {
	'--input': 'Pass the message text with --message <text>.',
	'--server':
		'`flue run` executes the agent module in-process without HTTP. ' +
		'To call a deployed server, use the SDK (`createFlueClient`).',
	'--header':
		'`flue run` executes the agent module in-process without HTTP. ' +
		'To call a deployed server, use the SDK (`createFlueClient`).',
	'--target': '`flue run` is always Node-local; there is no target to select.',
	'--root': 'Run `flue run` from the project directory; the module path is resolved from cwd.',
	'--output': '`flue run` executes the agent module directly and writes no build artifacts.',
	'--config': 'flue.config.* is discovered from the current working directory.',
};

function parseRunArgs(rest: string[]): RunArgs {
	for (const arg of rest) {
		if (arg === '--') break;
		const flagName = arg.startsWith('--') ? (arg.split('=', 1)[0] ?? arg) : arg;
		const hint = DROPPED_RUN_FLAGS[flagName];
		if (hint !== undefined) {
			fail(`\`flue run\` no longer accepts ${flagName}. ${hint}`);
		}
	}

	const { positionals, values } = parseCommandOptions(
		'run',
		rest,
		{
			message: { type: 'string' },
			id: { type: 'string' },
			data: { type: 'string' },
			json: { type: 'boolean' },
			env: { type: 'string', multiple: true },
		},
		new Set(['--message', '--id', '--data', '--json', '--env']),
	);

	const [modulePath, ...extra] = positionals;
	if (!modulePath) {
		console.error(
			'Missing agent module path for `flue run`.\n\nUsage:\n  flue run <path> --message <text> [--id <conversation-id>] [--env <path>] [--json]',
		);
		process.exit(1);
	}
	if (extra.length > 0) {
		console.error(`Unexpected extra arguments for \`flue run\`: ${extra.join(' ')}`);
		printUsage();
		process.exit(1);
	}

	const message = stringFlag(values, 'message', 'Missing value for --message');
	if (message === undefined) {
		fail('`flue run` requires --message <text>.');
	}

	const envFiles = stringListFlag(values, 'env', 'Missing value for --env');
	if (envFiles.length > 1) {
		fail('`--env` accepts one file. Combine values into one file or provide shell overrides.');
	}

	const rawData = stringFlag(values, 'data', 'Missing value for --data');
	let data: unknown;
	if (rawData !== undefined) {
		try {
			data = JSON.parse(rawData);
		} catch {
			fail('`--data` must be valid JSON, e.g. --data \'{"issue": 17307}\'.');
		}
	}

	return {
		command: 'run',
		modulePath,
		message,
		id: stringFlag(values, 'id', 'Missing value for --id'),
		data,
		json: booleanFlag(values, 'json', '--json'),
		envFile: envFiles[0],
	};
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command, ...rest] = argv;

	if (command === '--help' || command === '-h' || command === 'help') {
		printUsage(console.log);
		process.exit(0);
	}

	if (command === '--version' || command === '-v') {
		console.log(readCliVersion());
		process.exit(0);
	}

	if (command === 'add' || command === 'update') {
		return parseBlueprintCommandArgs(command, rest);
	}

	if (command === 'docs') {
		return parseDocsArgs(rest);
	}

	if (command === 'init') {
		return parseInitArgs(rest);
	}

	// Dev servers and builds moved to Vite (the @flue/vite plugin owns both
	// targets). The old commands hard-error with a pointer, never a wrapper.
	if (command === 'dev') {
		fail('flue dev was removed — run `vite dev` (see the migration guide)');
	}

	if (command === 'build') {
		fail('flue build was removed — run `vite build`');
	}

	if (command === 'run') {
		return parseRunArgs(rest);
	}

	printUsage();
	process.exit(1);
}

// ─── Main ───────────────────────────────────────────────────────────────────

function readCliVersion(): string {
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
		version: string;
	};
	return pkg.version;
}

function displayPath(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

let activeExecution: AbortableExecution | undefined;

function loadRunEnvironment(envFile: string | undefined): EnvLoader {
	try {
		const cwd = process.cwd();
		const configPath = resolveFlueConfigPath({ cwd });
		const baseDir = configPath ? path.dirname(configPath) : cwd;
		const envLoader = createEnvLoader(selectEnvFile(envFile, baseDir));
		envLoader.apply();
		return envLoader;
	} catch (err) {
		cliError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

function describeRunError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	if (error && typeof error === 'object' && 'message' in error) {
		const message = (error as { message: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return JSON.stringify(error);
}

async function run(args: RunArgs) {
	const envLoader = loadRunEnvironment(args.envFile);
	const stderrLine = (line: string) => process.stderr.write(`${line}\n`);
	// The presenter writes through process.stderr directly (not console.error)
	// so it is unaffected by the run's console redirection.
	const presenter = createLineEventPresenter({
		write: stderrLine,
		dim: pc.dim,
		textHeading: pc.bold('assistant'),
		textIndent: '  ',
	});
	const execution = createLocalAgentRun({
		modulePath: args.modulePath,
		message: args.message,
		data: args.data,
		conversationId: args.id,
		onEvent: (chunk) => presenter.present(chunk as ConversationStreamChunk),
		onRuntimeOutput: (line) => {
			if (line.trim()) stderrLine(pc.dim(line));
		},
		onReady: (info) => {
			brandRows('flue run', [
				['agent', info.identity],
				['id', info.conversationId],
				['config', info.configPath ? displayPath(info.root, info.configPath) : undefined],
				['db', info.dbEntry ?? info.dbPath],
				['env', fs.existsSync(envLoader.file) ? displayPath(info.root, envLoader.file) : undefined],
			]);
			stderrLine('');
			stderrLine(pc.bold('user'));
			for (const line of args.message.split('\n')) stderrLine(`  ${line}`);
			stderrLine('');
		},
	});
	activeExecution = execution;
	try {
		const result = await execution.start();
		presenter.flush();
		stderrLine('');
		if (result.outcome === 'completed') {
			if (args.json) {
				// The stable machine-readable envelope; documented in run-local.ts.
				console.log(
					JSON.stringify({
						id: result.conversationId,
						agent: result.identity,
						submissionId: result.submissionId,
						outcome: result.outcome,
						message: result.message,
					}),
				);
			} else if (result.message !== '') {
				console.log(result.message);
			}
			row('id', result.conversationId);
			success('agent completed');
		} else {
			row('id', result.conversationId);
			if (result.outcome === 'aborted') {
				cliError('Agent run aborted.');
				if (process.exitCode === undefined) process.exitCode = 130;
			} else {
				cliError(`Agent failed: ${describeRunError(result.error)}`);
				process.exitCode = 1;
			}
		}
	} catch (err) {
		presenter.flush();
		if (!execution.signal.aborted) {
			// Setup failures (module resolution, config, persistence) surface here;
			// agent-execution failures settle and land in the branch above.
			cliError(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	} finally {
		try {
			await execution.close();
		} finally {
			if (activeExecution === execution) activeExecution = undefined;
			envLoader.restore();
		}
	}
}

// ─── `flue init` ────────────────────────────────────────────────────────────

function renderConfigTemplate(target: 'node' | 'cloudflare'): string {
	return (
		`import { defineConfig } from '@flue/runtime/config';\n` +
		`\n` +
		`export default defineConfig({\n` +
		`\ttarget: '${target}',\n` +
		`});\n`
	);
}

function renderViteConfigTemplate(target: 'node' | 'cloudflare'): string {
	if (target === 'cloudflare') {
		return (
			`import { cloudflare } from '@cloudflare/vite-plugin';\n` +
			`import { flue } from '@flue/vite';\n` +
			`import { defineConfig } from 'vite';\n` +
			`\n` +
			`export default defineConfig({\n` +
			`\tplugins: [flue(), cloudflare()],\n` +
			`});\n`
		);
	}
	return (
		`import { flue } from '@flue/vite';\n` +
		`import { defineConfig } from 'vite';\n` +
		`\n` +
		`export default defineConfig({\n` +
		`\tplugins: [flue()],\n` +
		`});\n`
	);
}

function renderAppTemplate(): string {
	return (
		`import { Hono } from 'hono';\n` +
		`\n` +
		`const app = new Hono();\n` +
		`\n` +
		`// Mount every route explicitly. An agent module starts with the\n` +
		`// 'use agent' directive; create one and mount it here:\n` +
		`//\n` +
		`//   import assistant from './agents/assistant.ts';\n` +
		`//   app.route('/agents/assistant', assistant.route());\n` +
		`\n` +
		`export default app;\n`
	);
}

function renderWranglerTemplate(): string {
	return (
		`{\n` +
		`\t"$schema": "./node_modules/wrangler/config-schema.json",\n` +
		`\t"name": "my-flue-worker",\n` +
		`\t"compatibility_date": "2026-06-01",\n` +
		`\t"compatibility_flags": ["nodejs_compat"],\n` +
		`\t// Every 'use agent' file generates a Durable Object class named after\n` +
		`\t// its basename (assistant.ts -> FlueAssistantAgent). Cloudflare requires\n` +
		`\t// a migration entry for each generated class, so when you add your\n` +
		`\t// first agent, declare it here:\n` +
		`\t//\n` +
		`\t//   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueAssistantAgent"] }]\n` +
		`}\n`
	);
}

function initCommand(args: InitArgs) {
	const targetDir = args.explicitRoot ?? process.cwd();

	if (!fs.existsSync(targetDir)) {
		cliError(`Target directory does not exist: ${targetDir}`);
		process.exit(1);
	}

	// Detect any existing flue.config.* in the target dir, using the same
	// discovery rule the rest of the CLI uses. This catches `.mts`, `.js`,
	// etc. — not just `.ts`.
	let existing: string | undefined;
	try {
		existing = resolveFlueConfigPath({ cwd: targetDir });
	} catch (err) {
		cliError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	if (existing && !args.force) {
		const rel = path.relative(process.cwd(), existing) || existing;
		cliError(`A Flue config already exists at ${rel}.\n  Re-run with --force to overwrite.`);
		process.exit(1);
	}

	// The project skeleton. flue.config.ts honors --force (checked above);
	// every other file is created only when absent — init never overwrites
	// user-authored files.
	const files: Array<{ relPath: string; content: string; overwritable: boolean }> = [
		{ relPath: 'flue.config.ts', content: renderConfigTemplate(args.target), overwritable: true },
		{
			relPath: 'vite.config.ts',
			content: renderViteConfigTemplate(args.target),
			overwritable: false,
		},
		{ relPath: path.join('src', 'app.ts'), content: renderAppTemplate(), overwritable: false },
	];
	if (args.target === 'cloudflare') {
		files.push({ relPath: 'wrangler.jsonc', content: renderWranglerTemplate(), overwritable: false });
	}

	const wrote: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		const outPath = path.join(targetDir, file.relPath);
		const relOut = path.relative(process.cwd(), outPath) || outPath;
		if (!file.overwritable && fs.existsSync(outPath)) {
			skipped.push(relOut);
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, file.content);
		} catch (err) {
			cliError(`Failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
		wrote.push(relOut);
	}

	console.error(brand(['flue init', `target ${args.target}`, `wrote ${wrote.join(', ')}`]));
	if (skipped.length > 0) {
		note(`kept existing ${skipped.join(', ')}`);
	}

	// If --force overwrote a non-`.ts` variant, the new flue.config.ts will
	// take precedence (FLUE_CONFIG_BASENAMES priority), but the old file still
	// sits on disk. Surface that so the user isn't surprised later.
	if (existing && path.basename(existing) !== 'flue.config.ts') {
		const relExisting = path.relative(process.cwd(), existing) || existing;
		note(
			`${relExisting} is still on disk. flue.config.ts now takes precedence; delete the old file if you no longer need it.`,
		);
	}

	console.error('');
	note('next: fetch https://flueframework.com/start.md to create your first agent');
}

// ─── `flue add` ─────────────────────────────────────────────────────────────

// Default blueprint registry base. FLUE_REGISTRY_URL is an internal-only
// override used for local development against `pnpm --filter @flue/www dev`.
const DEFAULT_REGISTRY_URL = 'https://flueframework.com/cli/blueprints';

function registryUrlFor(slug: string): string {
	const base = (process.env.FLUE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
	return `${base}/${slug}.md`;
}

function resolveBlueprint(kind: string, name: string): (typeof BLUEPRINTS)[number] | undefined {
	const blueprints = BLUEPRINTS.filter((blueprint) => blueprint.kind === kind);
	const bySlug = blueprints.find((blueprint) => blueprint.slug === name);
	if (bySlug) return bySlug;
	const byAlias = blueprints.find((blueprint) => blueprint.aliases.includes(name));
	if (byAlias) return byAlias;
	const lower = name.toLowerCase();
	return blueprints.find(
		(blueprint) =>
			blueprint.slug.toLowerCase() === lower ||
			blueprint.aliases.some((alias) => alias.toLowerCase() === lower),
	);
}

/**
 * Render a 3-column table aligned by the longest entry. Simple and
 * intentionally unfussy — blueprint listings are always small.
 */
function renderBlueprintTable(rows: { command: string; kind: string; website: string }[]): string {
	if (rows.length === 0) return '  (none)';
	const commandWidth = Math.max(...rows.map((row) => row.command.length));
	const kindWidth = Math.max(...rows.map((row) => row.kind.length));
	const gap = '     ';
	return rows
		.map(
			(row) =>
				`  ${row.command.padEnd(commandWidth)}${gap}${row.kind.padEnd(kindWidth)}${gap}${row.website}`,
		)
		.join('\n');
}

const blueprintResultByKind: Record<string, string> = {
	sandbox: 'sandbox adapter',
	database: 'database adapter',
	channel: 'channel',
	tooling: 'tooling integration',
};

function kindRootHint(): string {
	if (KIND_ROOTS.length === 0) return '';
	const lines: string[] = [];
	lines.push('');
	lines.push(`Don't see what you need?`);
	for (const root of KIND_ROOTS) {
		lines.push('');
		lines.push(`  flue add ${root.kind} <url>`);
		lines.push(
			`    Build a ${blueprintResultByKind[root.kind] ?? root.kind} from scratch. Pass a URL pointing at the`,
		);
		lines.push(`    provider's docs (homepage, SDK reference, GitHub repo, anything useful) as`);
		lines.push(`    the agent's starting point. Pipe to your coding agent.`);
	}
	return lines.join('\n');
}

function availableBlueprintRows(kind?: string) {
	return BLUEPRINTS.filter((blueprint) => !kind || blueprint.kind === kind).map((blueprint) => ({
		command: `flue add ${blueprint.kind} ${blueprint.slug}`,
		kind: blueprint.kind,
		website: blueprint.website,
	}));
}

function printListing(stream: NodeJS.WriteStream) {
	stream.write('flue add <kind> <name|url>\n\n');
	stream.write('Available blueprints:\n');
	stream.write(renderBlueprintTable(availableBlueprintRows()));
	stream.write('\n');
	const hint = kindRootHint();
	if (hint) stream.write(`${hint}\n`);
}

function printUnknownBlueprint(kind: string, name: string, stream: NodeJS.WriteStream) {
	stream.write(`Blueprint "${name}" not found for kind "${kind}".\n\n`);
	stream.write(`Available ${kind} blueprints:\n`);
	stream.write(renderBlueprintTable(availableBlueprintRows(kind)));
	stream.write('\n\nTo build one from scratch with your coding agent:\n');
	stream.write(`  flue add ${kind} <url>\n`);
}

async function fetchBlueprintMarkdown(
	slug: string,
): Promise<{ body: string } | { notFound: true }> {
	const url = registryUrlFor(slug);
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		cliError(
			`Failed to reach the blueprint registry at ${url}.\n  ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
	if (res.status === 404) return { notFound: true };
	if (!res.ok) {
		cliError(`Blueprint registry returned HTTP ${res.status} for ${url}.`);
		process.exit(1);
	}
	return { body: await res.text() };
}

// ─── flue docs ───────────────────────────────────────────────────────────────

interface DocsPage {
	/** Page path without extension, e.g. `guide/sandboxes`. */
	path: string;
	title: string;
	description: string;
	/** Markdown body without frontmatter. */
	body: string;
}

/**
 * Locate the documentation markdown tree.
 *
 * For users of the published package this is always `<package root>/docs`,
 * placed there by `scripts/prepare-publish.mjs` at release time. Both `bin/`
 * (dev via tsx) and `dist/` (built) sit directly under the package root, so
 * the relative hop is identical in both contexts.
 *
 * The `apps/docs` candidate exists only for development inside the Flue
 * monorepo itself and can never resolve in a user's `node_modules`. It is
 * checked first because in a repo checkout the docs site content is the
 * source of truth, and a stale `<package root>/docs` snapshot left behind by
 * a local release (gitignored, only refreshed at the next release) must not
 * shadow it.
 */
function resolveDocsRoot(): string | undefined {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(here, '../../../apps/docs/src/content/docs'),
		path.join(here, '../docs'),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function parseDocsFrontmatter(source: string): { data: Record<string, string>; body: string } {
	if (!source.startsWith('---\n')) return { data: {}, body: source };
	const end = source.indexOf('\n---\n', 4);
	if (end === -1) return { data: {}, body: source };

	const data: Record<string, string> = {};
	for (const line of source.slice(4, end).split('\n')) {
		const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		const key = match?.[1];
		let value = match?.[2]?.trim();
		if (!key || value === undefined) continue;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		data[key] = value;
	}
	return { data, body: source.slice(end + '\n---\n'.length) };
}

function loadDocsPages(root: string): DocsPage[] {
	const pages: DocsPage[] = [];
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(md|mdx)$/.test(entry.name)) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const relative = path.relative(root, filePath).split(path.sep).join('/');
		const { data, body } = parseDocsFrontmatter(fs.readFileSync(filePath, 'utf8'));
		// `foo/index.md` is addressed as `foo`, matching the website's URLs.
		const pagePath = relative.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
		pages.push({
			path: pagePath,
			title: data.title ?? relative,
			description: data.description ?? '',
			body,
		});
	}
	return pages.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reduces markdown/MDX source to plain text for search indexing. This is
 * intentionally a lightweight approximation: minor artifacts are acceptable
 * since the output is only used for search matching and excerpts.
 */
function docsMarkdownToPlainText(source: string): string {
	return source
		.replace(/^(?:import|export)\s.*$/gm, '')
		.replace(/^```.*$/gm, '')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<\/?[A-Za-z][^>]*>/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^>\s?/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/^\s*---+\s*$/gm, '')
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
		.replace(/(^|\s)_{1,3}([^_]+)_{1,3}(?=[\s.,;:!?)]|$)/g, '$1$2')
		.replace(/\|/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractDocsHeadings(source: string): string {
	const matches = [...source.matchAll(/^#{2,4}\s+(.+)$/gm)];
	return matches.map((match) => docsMarkdownToPlainText(match[1] ?? '')).join(' ');
}

const DOCS_DESCRIPTION_MAX_LENGTH = 120;

function truncateDocsDescription(description: string): string {
	const characters = [...description];
	if (characters.length <= DOCS_DESCRIPTION_MAX_LENGTH) return description;
	const truncated = characters.slice(0, DOCS_DESCRIPTION_MAX_LENGTH - 1).join('');
	const boundary = truncated.search(/\s+\S*$/u);
	return boundary > 0 ? `${truncated.slice(0, boundary)}…` : '…';
}

const DOCS_EXCERPT_RADIUS = 120;

function buildDocsExcerpt(content: string, terms: string[]): string {
	const lowered = content.toLowerCase();
	let position = -1;
	for (const term of terms) {
		const index = lowered.indexOf(term.toLowerCase());
		if (index !== -1 && (position === -1 || index < position)) {
			position = index;
		}
	}
	if (position === -1) position = 0;

	const start = Math.max(0, position - DOCS_EXCERPT_RADIUS);
	const end = Math.min(content.length, position + DOCS_EXCERPT_RADIUS);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < content.length ? '…' : '';
	return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

/** Accepts `guide/sandboxes`, `/docs/guide/sandboxes/`, full website URLs, and `.md`/`.mdx` paths. */
function normalizeDocsPath(input: string): string {
	let value = input.trim();
	if (/^https?:\/\//.test(value)) {
		try {
			value = new URL(value).pathname;
		} catch {
			// fall through with the raw value
		}
	}
	return value
		.replace(/^\.?\/+/, '')
		.replace(/^docs\//, '')
		.replace(/\/+$/, '')
		.replace(/\.(md|mdx)$/, '')
		.replace(/\/index$/, '');
}

function docsCommand(args: DocsArgs): void {
	const root = resolveDocsRoot();
	if (!root) {
		cliError(
			'Could not locate the bundled documentation. Your @flue/cli installation may be incomplete — try reinstalling it.',
		);
		process.exit(1);
	}
	const pages = loadDocsPages(root);

	if (args.action === 'list') {
		process.stderr.write(
			'Flue documentation\n\n' +
				'  flue docs read <path>      Print a documentation page as markdown\n' +
				'  flue docs search <query>   Search the documentation (JSON results)\n\n' +
				`Pages (${pages.length}):\n\n`,
		);
		for (const page of pages) {
			process.stdout.write(`${page.path} -- ${page.title}\n`);
			if (page.description && !page.path.startsWith('ecosystem/')) {
				process.stdout.write(`  ${truncateDocsDescription(page.description)}\n`);
			}
		}
		return;
	}

	if (args.action === 'read') {
		const target = normalizeDocsPath(args.value);
		const page = pages.find((candidate) => candidate.path === target);
		if (!page) {
			cliError(
				`Unknown docs page: ${args.value}\nRun \`flue docs\` to list available pages, or \`flue docs search <query>\` to find one.`,
			);
			process.exit(1);
		}
		let output = `# ${page.title}\n`;
		if (page.description) output += `\n> ${page.description}\n`;
		output += `\n${page.body.trim()}\n`;
		process.stdout.write(output);
		return;
	}

	const index = new MiniSearch({
		idField: 'path',
		fields: ['title', 'headings', 'description', 'content'],
		storeFields: ['title', 'description', 'content'],
		searchOptions: {
			boost: { title: 4, headings: 3, description: 2 },
			prefix: true,
			fuzzy: 0.2,
		},
	});
	index.addAll(
		pages.map((page) => ({
			path: page.path,
			title: page.title,
			description: page.description,
			headings: extractDocsHeadings(page.body),
			content: docsMarkdownToPlainText(page.body),
		})),
	);

	const results = index
		.search(args.value)
		.slice(0, 8)
		.map((result) => ({
			path: result.id as string,
			title: result.title as string,
			description: (result.description as string) || undefined,
			excerpt: buildDocsExcerpt((result.content as string) ?? '', result.terms),
			score: Math.round(result.score * 100) / 100,
		}));

	process.stdout.write(`${JSON.stringify({ query: args.value, results }, null, 2)}\n`);
	process.stderr.write('\nRead a page with: flue docs read <path>\n');
}

function printHumanInstructions(args: BlueprintCommandArgs) {
	const cmd = `flue ${args.command} ${args.kind} ${shellQuote(args.target)}`;
	const stream = process.stderr;
	stream.write(`${cmd}\n\n`);
	stream.write('To apply this blueprint, pipe it to your coding agent:\n\n');
	stream.write(`  ${cmd} --print | claude\n`);
	stream.write(`  ${cmd} --print | codex\n`);
	stream.write(`  ${cmd} --print | cursor-agent\n`);
	stream.write(`  ${cmd} --print | opencode\n`);
	stream.write(`  ${cmd} --print | pi\n\n`);
	stream.write('Or paste this prompt into any agent:\n\n');
	stream.write(`  Run "${cmd} --print" and follow the instructions.\n`);
}

/**
 * Shared tail of blueprint commands: fetch blueprint Markdown for `slug`, then write
 * it to stdout in agent mode or print human instructions. `substituteUrl`
 * replaces `{{URL}}` placeholders in kind-root blueprints.
 */
async function emitBlueprintMarkdown(
	args: BlueprintCommandArgs,
	opts: { slug: string; notFoundLabel: string; substituteUrl?: string },
) {
	const result = await fetchBlueprintMarkdown(opts.slug);
	if ('notFound' in result) {
		cliError(
			`The blueprint registry did not have Markdown for ${opts.notFoundLabel}. Your installed CLI may be out of sync with the registry — try updating @flue/cli.`,
		);
		process.exit(1);
	}

	const body =
		opts.substituteUrl === undefined
			? result.body
			: result.body.replaceAll('{{URL}}', opts.substituteUrl);

	const isAgentMode =
		args.print || (await determineAgent().catch(() => ({ isAgent: false }))).isAgent === true;
	if (isAgentMode) {
		process.stdout.write(body);
		if (!body.endsWith('\n')) process.stdout.write('\n');
		return;
	}
	printHumanInstructions(args);
}

async function blueprintCommand(args: BlueprintCommandArgs) {
	if (args.command === 'add' && !args.kind && !args.target) {
		printListing(process.stderr);
		return;
	}

	const root = KIND_ROOTS.find((entry) => entry.kind === args.kind);
	if (!root) {
		cliError(
			`Unknown blueprint kind "${args.kind}". Known kinds: ${KIND_ROOTS.map((entry) => entry.kind).join(', ') || '(none)'}`,
		);
		process.exit(1);
	}

	let url: URL | undefined;
	try {
		url = new URL(args.target);
	} catch {}

	if (url) {
		await emitBlueprintMarkdown(args, {
			slug: root.kind,
			notFoundLabel: `kind "${args.kind}"`,
			substituteUrl: args.target,
		});
		return;
	}

	const known = resolveBlueprint(args.kind, args.target);
	if (!known) {
		printUnknownBlueprint(args.kind, args.target, process.stderr);
		process.exit(1);
	}

	await emitBlueprintMarkdown(args, { slug: known.slug, notFoundLabel: `"${known.slug}"` });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const shutdown = (signal: NodeJS.Signals) => {
	if (activeExecution) {
		void closeExecutionForSignal(signal, activeExecution).catch((error) => {
			cliError(error instanceof Error ? error.message : String(error));
		});
	} else {
		process.exitCode = signal === 'SIGINT' ? 130 : 143;
	}
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
	if (args.command === 'add' || args.command === 'update') {
		await blueprintCommand(args);
	} else if (args.command === 'docs') {
		docsCommand(args);
	} else if (args.command === 'init') {
		initCommand(args);
	} else if (args.command === 'run') {
		await run(args);
	}
}

void main().then(
	() => {
		if (args.command === 'run') process.exit(process.exitCode ?? 0);
	},
	(err) => {
		cliError(err instanceof Error ? err.message : String(err));
		if (process.exitCode === undefined) process.exitCode = 1;
		if (args.command === 'run') process.exit(process.exitCode);
	},
);
