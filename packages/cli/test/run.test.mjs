import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizedChildEnv } from './child-env.mjs';

const cli = new URL('../dist/flue.js', import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoots = [];

process.on('exit', () => {
	for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createFixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cli-run-'));
	fixtureRoots.push(root);
	const flueScope = path.join(root, 'node_modules', '@flue');
	fs.mkdirSync(flueScope, { recursive: true });
	fs.symlinkSync(
		path.join(repositoryRoot, 'packages', 'runtime'),
		path.join(flueScope, 'runtime'),
		'dir',
	);
	// The faux model provider lives in pi-ai; agents under test register it
	// in-process. It must resolve to the same install the runtime uses.
	const piScope = path.join(root, 'node_modules', '@earendil-works');
	fs.mkdirSync(piScope, { recursive: true });
	fs.symlinkSync(
		path.join(repositoryRoot, 'packages', 'runtime', 'node_modules', '@earendil-works', 'pi-ai'),
		path.join(piScope, 'pi-ai'),
		'dir',
	);
	fs.mkdirSync(path.join(root, 'src', 'agents'), { recursive: true });
	return root;
}

/**
 * An agent whose (faux, keyless) model reports how many messages were in the
 * model context — lets tests observe conversation continuation.
 */
function writeEchoAgent(root, name = 'hello') {
	const fnName = name.charAt(0).toUpperCase() + name.slice(1);
	fs.writeFileSync(
		path.join(root, 'src', 'agents', `${name}.mjs`),
		`import { registerProvider, useModel } from '@flue/runtime';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';

const faux = registerFauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
faux.setResponses([
	(context) => fauxAssistantMessage('reply from ${name}: context-messages=' + context.messages.length),
]);
registerProvider('faux', { api: faux.api, baseUrl: 'https://faux.invalid' });

export function ${fnName}() {
	useModel('faux/faux-model');
}
// The identity override rides the e2e path on purpose: the wire-visible
// agent name stays lower-case while the function keeps the React-style
// capitalized name.
${fnName}.agentName = '${name}';
`,
	);
	return path.join('src', 'agents', `${name}.mjs`);
}

/**
 * A hooks-form agent (bare function default export) whose faux model reports
 * whether the composed system prompt carried its `useInstruction` text.
 */
function writeFunctionAgent(root, name = 'hooked') {
	const fnName = name.charAt(0).toUpperCase() + name.slice(1);
	fs.writeFileSync(
		path.join(root, 'src', 'agents', `${name}.mjs`),
		`import { registerProvider, useInstruction, useModel } from '@flue/runtime';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';

const faux = registerFauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
faux.setResponses([
	(context) =>
		fauxAssistantMessage(
			'instruction-mounted=' + String(context.systemPrompt.includes('Speak only in haiku.')),
		),
]);
registerProvider('faux', { api: faux.api, baseUrl: 'https://faux.invalid' });

export function ${fnName}() {
	useModel('faux/faux-model');
	useInstruction('Speak only in haiku.');
	return 'You are the ${name} agent.';
}
`,
	);
	return path.join('src', 'agents', `${name}.mjs`);
}

/** An agent that streams slowly (newline-separated words) so tests can interrupt it. */
function writeSlowAgent(root) {
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'slow.mjs'),
		`import { registerProvider, useModel } from '@flue/runtime';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';

const faux = registerFauxProvider({
	provider: 'faux',
	models: [{ id: 'faux-model' }],
	tokensPerSecond: 20,
});
faux.setResponses([
	fauxAssistantMessage(Array.from({ length: 400 }, (_, i) => 'word' + i).join('\\n')),
]);
registerProvider('faux', { api: faux.api, baseUrl: 'https://faux.invalid' });

export function Slow() {
	useModel('faux/faux-model');
}
`,
	);
	return path.join('src', 'agents', 'slow.mjs');
}

// ─── Spawning ────────────────────────────────────────────────────────────────

function startRun(cwd, args, env = {}) {
	const childEnv = sanitizedChildEnv({ NO_COLOR: '1', ...env });
	delete childEnv.FORCE_COLOR;
	const child = spawn(process.execPath, [cli.pathname, 'run', ...args], {
		cwd,
		env: childEnv,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	return {
		child,
		stdout: () => stdout,
		stderr: () => stderr,
		waitForStderr(text, timeoutMs = 60_000) {
			return waitFor(
				() => stderr.includes(text),
				timeoutMs,
				() => `Timed out waiting for stderr: ${text}\n\nstderr:\n${stderr}\nstdout:\n${stdout}`,
			);
		},
		async exited() {
			const [code, signal] = await once(child, 'exit');
			return { code, signal, stdout, stderr };
		},
	};
}

function runCli(cwd, args, env = {}) {
	return startRun(cwd, args, env).exited();
}

async function waitFor(predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message());
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test('streams activity to stderr, prints the final message to stdout, persists the default db, binds no port', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	// Any net.Server.listen() call in the child marks the run as a failure.
	const guardPath = path.join(root, 'listen-guard.mjs');
	fs.writeFileSync(
		guardPath,
		`import net from 'node:net';
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
	process.stderr.write('LISTEN-DETECTED\\n');
	return originalListen.apply(this, args);
};
`,
	);

	const result = await runCli(root, [agent, '--message', 'Hi there'], {
		NODE_OPTIONS: `--import ${pathToFileURL(guardPath).href}`,
	});

	assert.equal(result.code, 0, result.stderr);
	// stdout carries exactly the final assistant message (pipeable).
	assert.equal(result.stdout, 'reply from hello: context-messages=1\n');
	// stderr carries the banner, the echoed user message, the streamed
	// assistant text, and the conversation id.
	assert.match(result.stderr, /flue run/);
	assert.match(result.stderr, /agent\s+hello/);
	assert.match(result.stderr, /user\n\s+Hi there/);
	assert.match(result.stderr, /assistant\n\s+reply from hello/);
	assert.match(result.stderr, /id\s+\S+/);
	assert.match(result.stderr, /agent completed/);
	assert.ok(!result.stderr.includes('LISTEN-DETECTED'), `a port was bound:\n${result.stderr}`);
	// Default persistence lands in the project-local cache and is not wiped.
	assert.ok(fs.existsSync(path.join(root, 'node_modules', '.cache', 'flue', 'run.db')));
	// No build artifacts are written: the run is module-loading only.
	assert.equal(fs.existsSync(path.join(root, 'dist')), false);
	assert.equal(fs.existsSync(path.join(root, '.flue-vite')), false);
	assert.equal(fs.existsSync(path.join(root, 'node_modules', '.vite')), false);
});

test('--id continues the same conversation across invocations', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	const first = await runCli(root, [agent, '--message', 'first', '--id', 'conv-1']);
	assert.equal(first.code, 0, first.stderr);
	assert.equal(first.stdout, 'reply from hello: context-messages=1\n');
	assert.match(first.stderr, /id\s+conv-1/);

	// Second process, same id: the model context now holds the first
	// exchange's user+assistant messages plus the new user message.
	const second = await runCli(root, [agent, '--message', 'second', '--id', 'conv-1']);
	assert.equal(second.code, 0, second.stderr);
	assert.equal(second.stdout, 'reply from hello: context-messages=3\n');

	// A different id starts fresh in the same db.
	const other = await runCli(root, [agent, '--message', 'other', '--id', 'conv-2']);
	assert.equal(other.code, 0, other.stderr);
	assert.equal(other.stdout, 'reply from hello: context-messages=1\n');
});

test('a discovered db entry supplies persistence instead of the default cache db', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);
	fs.writeFileSync(
		path.join(root, 'src', 'db.mjs'),
		`import path from 'node:path';
import { sqlite } from '@flue/runtime/node';
export default sqlite(path.resolve(process.cwd(), 'custom.sqlite'));
`,
	);

	const result = await runCli(root, [agent, '--message', 'hi']);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stderr, /db\s+src[\\/]db\.mjs/);
	assert.ok(fs.existsSync(path.join(root, 'custom.sqlite')));
	assert.ok(!fs.existsSync(path.join(root, 'node_modules', '.cache', 'flue', 'run.db')));
});

test('flue.config db field is honored and legacy config fields are ignored', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);
	fs.writeFileSync(
		path.join(root, 'db-entry.mjs'),
		`import path from 'node:path';
import { sqlite } from '@flue/runtime/node';
export default sqlite(path.resolve(process.cwd(), 'configured.sqlite'));
`,
	);
	// `root`/`output` are pre-redesign fields; `flue run` must not choke on them.
	fs.writeFileSync(
		path.join(root, 'flue.config.mjs'),
		`export default { target: 'node', root: '.', output: 'dist-legacy', db: './db-entry.mjs' };\n`,
	);

	const result = await runCli(root, [agent, '--message', 'hi']);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stderr, /config\s+flue\.config\.mjs/);
	assert.ok(fs.existsSync(path.join(root, 'configured.sqlite')));
});

test('--json prints a machine-readable envelope to stdout', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	const result = await runCli(root, [agent, '--message', 'hi', '--id', 'json-conv', '--json']);
	assert.equal(result.code, 0, result.stderr);
	const envelope = JSON.parse(result.stdout);
	assert.deepEqual(Object.keys(envelope).sort(), [
		'agent',
		'id',
		'message',
		'outcome',
		'submissionId',
		'uid',
	]);
	assert.equal(envelope.id, 'json-conv');
	assert.equal(envelope.agent, 'hello');
	assert.equal(envelope.outcome, 'completed');
	assert.equal(envelope.message, 'reply from hello: context-messages=1');
	assert.ok(envelope.submissionId.length > 0);
	assert.match(envelope.uid, /^inst_/);
});

test('conditional sends: --uid continues the incarnation, --new rejects an existing id', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	const created = await runCli(root, [agent, '--message', 'hi', '--id', 'cond-conv', '--json']);
	assert.equal(created.code, 0, created.stderr);
	const uid = JSON.parse(created.stdout).uid;
	assert.match(uid, /^inst_/);

	// Continue with the receipt's uid: same incarnation, uid echoed.
	const continued = await runCli(root, [
		agent,
		'--message',
		'again',
		'--id',
		'cond-conv',
		'--uid',
		uid,
		'--json',
	]);
	assert.equal(continued.code, 0, continued.stderr);
	assert.equal(JSON.parse(continued.stdout).uid, uid);

	// A stale/wrong uid names a dead incarnation.
	const stale = await runCli(root, [
		agent,
		'--message',
		'again',
		'--id',
		'cond-conv',
		'--uid',
		'inst_nonexistent',
	]);
	assert.notEqual(stale.code, 0);
	assert.match(stale.stderr, /was not found/);

	// --new against an existing id rejects and hands back the uid.
	const conflict = await runCli(root, [
		agent,
		'--message',
		'fresh',
		'--id',
		'cond-conv',
		'--new',
	]);
	assert.notEqual(conflict.code, 0);
	assert.match(conflict.stderr, /already exists/);
	assert.ok(conflict.stderr.includes(uid), conflict.stderr);

	// --uid and --new together are rejected at flag parse.
	const both = await runCli(root, [
		agent,
		'--message',
		'x',
		'--id',
		'cond-conv',
		'--uid',
		uid,
		'--new',
	]);
	assert.notEqual(both.code, 0);
	assert.match(both.stderr, /pass one or the other/i);
});

test('--data seeds creation and is ignored on continues, like dispatch initialData', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	// Creation with a chosen id and data works (the CI pattern).
	const created = await runCli(root, [
		agent,
		'--message',
		'hi',
		'--id',
		'seeded-conv',
		'--data',
		'{"issue": 17307}',
		'--json',
	]);
	assert.equal(created.code, 0, created.stderr);
	const uid = JSON.parse(created.stdout).uid;
	assert.match(uid, /^inst_/);

	// --data at an existing conversation continues it; the seed is silently
	// ignored (dispatch initialData semantics), the incarnation unchanged.
	const continued = await runCli(root, [
		agent,
		'--message',
		'again',
		'--id',
		'seeded-conv',
		'--data',
		'{"issue": 99999}',
		'--json',
	]);
	assert.equal(continued.code, 0, continued.stderr);
	assert.equal(JSON.parse(continued.stdout).uid, uid);

	// --uid forbids creation, so the seed could never apply.
	const withUid = await runCli(root, [
		agent,
		'--message',
		'x',
		'--id',
		'seeded-conv',
		'--uid',
		uid,
		'--data',
		'{}',
	]);
	assert.notEqual(withUid.code, 0);
	assert.match(withUid.stderr, /--data/);

	// Malformed JSON is rejected at flag parse.
	const badJson = await runCli(root, [agent, '--message', 'x', '--data', '{nope']);
	assert.notEqual(badJson.code, 0);
	assert.match(badJson.stderr, /must be valid JSON/);
});

// ─── SIGINT ──────────────────────────────────────────────────────────────────

test('SIGINT aborts through the coordinator, drains, and exits non-zero', async () => {
	const root = createFixtureRoot();
	const agent = writeSlowAgent(root);

	const run = startRun(root, [agent, '--message', 'go']);
	// Wait until assistant text is streaming, then interrupt.
	await run.waitForStderr('word1');
	run.child.kill('SIGINT');
	const result = await run.exited();

	assert.equal(result.code, 130, `stderr:\n${result.stderr}`);
	assert.match(result.stderr, /Agent run aborted\./);
	// The final message never reaches stdout on an aborted run.
	assert.equal(result.stdout, '');
});

// ─── Diagnostics ─────────────────────────────────────────────────────────────

test('a bare name that is not a file asks for a module path', async () => {
	const root = createFixtureRoot();
	writeEchoAgent(root);

	const result = await runCli(root, ['hello', '--message', 'hi']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /takes a module path, not a name/);
	assert.match(result.stderr, /src\/agents\/hello\.ts/);
});

test('a path that does not exist reports the missing module', async () => {
	const root = createFixtureRoot();

	const result = await runCli(root, ['src/agents/missing.mjs', '--message', 'hi']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Agent module not found: src\/agents\/missing\.mjs/);
});

test('runs a bare agent function module with its hooks composed', async () => {
	const root = createFixtureRoot();
	const agent = writeFunctionAgent(root);

	const result = await runCli(root, [agent, '--message', 'Hi there']);

	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, 'instruction-mounted=true\n');
});

test('a module with no agent exports fails clearly', async () => {
	const root = createFixtureRoot();
	fs.writeFileSync(path.join(root, 'src', 'agents', 'bad.mjs'), 'export default { nope: true };\n');

	const result = await runCli(root, ['src/agents/bad.mjs', '--message', 'hi']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /exports no agents/);
	assert.match(result.stderr, /export function MyAgent/);
});

test('multi-agent modules run via --name and fail without a selection', async () => {
	const root = createFixtureRoot();
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'team.mjs'),
		`import { registerProvider, useModel } from '@flue/runtime';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';

const faux = registerFauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
faux.setResponses([fauxAssistantMessage('reply from the team')]);
registerProvider('faux', { api: faux.api, baseUrl: 'https://faux.invalid' });

export function First() {
	useModel('faux/faux-model');
}
export function Second() {
	useModel('faux/faux-model');
}
Second.agentName = 'second-shift';
// A default export carries no special weight — it is one agent among several.
export default function Main() {
	useModel('faux/faux-model');
}
`,
	);

	const picked = await runCli(root, [
		'src/agents/team.mjs',
		'--name',
		'First',
		'--message',
		'hi',
		'--json',
	]);
	assert.equal(picked.code, 0, picked.stderr);
	assert.equal(JSON.parse(picked.stdout).agent, 'First');

	// --name matches the agent's name (its identity), not the export key.
	const renamed = await runCli(root, [
		'src/agents/team.mjs',
		'--name',
		'second-shift',
		'--message',
		'hi',
		'--json',
	]);
	assert.equal(renamed.code, 0, renamed.stderr);
	assert.equal(JSON.parse(renamed.stdout).agent, 'second-shift');

	// The default export is selected by its function name, like any other.
	const viaDefault = await runCli(root, [
		'src/agents/team.mjs',
		'--name',
		'Main',
		'--message',
		'hi',
		'--json',
	]);
	assert.equal(viaDefault.code, 0, viaDefault.stderr);
	assert.equal(JSON.parse(viaDefault.stdout).agent, 'Main');

	// Several agents, no --name: fail listing the choices — the default
	// export is NOT silently preferred.
	const unpicked = await runCli(root, ['src/agents/team.mjs', '--message', 'hi']);
	assert.equal(unpicked.code, 1);
	assert.match(unpicked.stderr, /defines 3 agents \(First, second-shift, Main\)/);
	assert.match(unpicked.stderr, /Pick one with --name/);

	// A name that matches nothing lists what exists; the overridden export
	// key is not an agent name.
	const wrong = await runCli(root, ['src/agents/team.mjs', '--name', 'Second', '--message', 'hi']);
	assert.equal(wrong.code, 1);
	assert.match(wrong.stderr, /does not match an agent/);
	assert.match(wrong.stderr, /First, second-shift, Main/);
});

test('a module importing cloudflare:* APIs points at vite dev with the import chain', async () => {
	const root = createFixtureRoot();
	// Indirect import: the diagnostic must name the route to the offending
	// module, not just the module.
	fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'src', 'lib', 'platform.mjs'),
		`import 'cloudflare:workers';
export const onCloudflare = true;
`,
	);
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'cf.mjs'),
		`import '../lib/platform.mjs';
export function Cf() {
	return undefined;
}
`,
	);

	const result = await runCli(root, ['src/agents/cf.mjs', '--message', 'hi']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /depends on 'cloudflare:workers'/);
	assert.match(result.stderr, /`flue run` is Node-local; platform behavior belongs to `vite dev`/);
	assert.match(result.stderr, /Import chain:/);
	assert.match(result.stderr, /src\/agents\/cf\.mjs imports/);
	assert.match(result.stderr, /src\/lib\/platform\.mjs imports/);
	assert.match(result.stderr, /cloudflare:workers$/m);
});

test('missing --message is rejected', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	const result = await runCli(root, [agent]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /`flue run` requires --message <text>\./);
});

test('dropped legacy flags hard-error with their replacement', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	const cases = [
		[['--input', '{}'], /no longer accepts --input\. Pass the message text with --message/],
		[['--server', 'http://x'], /no longer accepts --server\..*without HTTP/],
		[['--header', 'A: b'], /no longer accepts --header\..*without HTTP/],
		[['--target', 'node'], /no longer accepts --target\..*Node-local/],
		[['--root', '.'], /no longer accepts --root\./],
		[['--output', 'dist'], /no longer accepts --output\./],
		[['--config', 'flue.config.ts'], /no longer accepts --config\./],
	];
	for (const [flags, pattern] of cases) {
		const result = await runCli(root, [agent, '--message', 'hi', ...flags]);
		assert.equal(result.code, 1, `${flags[0]} should exit 1`);
		assert.match(result.stderr, pattern, `${flags[0]}\n${result.stderr}`);
	}
});

test('unknown flags are still rejected as unknown', async () => {
	const root = createFixtureRoot();
	const agent = writeEchoAgent(root);

	const result = await runCli(root, [agent, '--message', 'hi', '--bogus']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Unknown flag for `flue run`: --bogus/);
});
