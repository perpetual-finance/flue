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
	fs.symlinkSync(path.join(repositoryRoot, 'packages', 'runtime'), path.join(flueScope, 'runtime'), 'dir');
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
	fs.writeFileSync(
		path.join(root, 'src', 'agents', `${name}.mjs`),
		`import { defineAgent, registerProvider } from '@flue/runtime';
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';

const faux = registerFauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
faux.setResponses([
	(context) => fauxAssistantMessage('reply from ${name}: context-messages=' + context.messages.length),
]);
registerProvider('faux', { api: faux.api, baseUrl: 'https://faux.invalid' });

export default defineAgent(() => ({ model: 'faux/faux-model' }));
`,
	);
	return path.join('src', 'agents', `${name}.mjs`);
}

/** An agent that streams slowly (newline-separated words) so tests can interrupt it. */
function writeSlowAgent(root) {
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'slow.mjs'),
		`import { defineAgent, registerProvider } from '@flue/runtime';
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

export default defineAgent(() => ({ model: 'faux/faux-model' }));
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
	assert.deepEqual(Object.keys(envelope).sort(), ['agent', 'id', 'message', 'outcome', 'submissionId']);
	assert.equal(envelope.id, 'json-conv');
	assert.equal(envelope.agent, 'hello');
	assert.equal(envelope.outcome, 'completed');
	assert.equal(envelope.message, 'reply from hello: context-messages=1');
	assert.ok(envelope.submissionId.length > 0);
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

test('a module without a defineAgent default export fails clearly', async () => {
	const root = createFixtureRoot();
	fs.writeFileSync(path.join(root, 'src', 'agents', 'bad.mjs'), 'export default { nope: true };\n');

	const result = await runCli(root, ['src/agents/bad.mjs', '--message', 'hi']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Agent "bad" must default-export defineAgent\(\.\.\.\)/);
});

test('a module importing cloudflare:* APIs points at vite dev', async () => {
	const root = createFixtureRoot();
	fs.writeFileSync(
		path.join(root, 'src', 'agents', 'cf.mjs'),
		`import 'cloudflare:workers';
import { defineAgent } from '@flue/runtime';
export default defineAgent(() => ({ model: 'faux/faux-model' }));
`,
	);

	const result = await runCli(root, ['src/agents/cf.mjs', '--message', 'hi']);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /`flue run` is Node-local; platform behavior belongs to `vite dev`/);
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
