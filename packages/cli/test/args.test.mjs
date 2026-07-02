import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';

const cli = new URL('../dist/flue.js', import.meta.url);

async function runCli(args) {
	const child = spawn(process.execPath, [cli.pathname, ...args], {
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
	const [code, signal] = await once(child, 'exit');
	return { code, signal, stdout, stderr };
}

describe('flue (argument parsing)', () => {
	it('treats the positional as the module path when flags precede it in `flue run`', async () => {
		const result = await runCli(['run', '--message', 'hi', 'hello']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('takes a module path, not a name'), result.stderr);
		assert.ok(!result.stderr.includes('Unknown flag'), result.stderr);
	});

	it('reports the missing module path when `flue run` receives flags but no positional', async () => {
		const result = await runCli(['run', '--message', 'hi']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing agent module path'), result.stderr);
	});

	it('treats `--message=hi` the same as `--message hi`', async () => {
		const result = await runCli(['run', '--message=hi']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing agent module path'), result.stderr);
		assert.ok(!result.stderr.includes('Unknown flag'), result.stderr);
	});

	it('reports a missing string value when the next argument is another flag', async () => {
		const result = await runCli(['run', 'agent.mjs', '--message', '--id', 'x']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing value for --message'), result.stderr);
	});

	it('reports a missing string value when the next argument is an inline flag', async () => {
		const result = await runCli(['run', 'agent.mjs', '--message', '--id=x']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Missing value for --message'), result.stderr);
	});

	it('accepts a flag-like string value when provided inline', async () => {
		const result = await runCli(['run', 'agent.mjs', '--message=--id']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Agent module not found: agent.mjs'), result.stderr);
		assert.ok(!result.stderr.includes('Missing value for --message'), result.stderr);
	});

	it('rejects --input when passed to `flue build`', async () => {
		const result = await runCli(['build', '--input', '{"x":1}']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue build` does not accept --input'), result.stderr);
	});

	it('rejects --port when passed to `flue build`', async () => {
		const result = await runCli(['build', '--port', '8080']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue build` does not accept --port'), result.stderr);
	});

	it('rejects --input when passed to `flue dev`', async () => {
		const result = await runCli(['dev', '--input', '{}']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('`flue dev` does not accept --input'), result.stderr);
	});

	it('rejects a dropped legacy flag with a pointer at its replacement', async () => {
		const result = await runCli(['run', 'agent.mjs', '--input', '{}', '--message', 'hi']);
		assert.equal(result.code, 1);
		assert.ok(
			result.stderr.includes('`flue run` no longer accepts --input. Pass the message text with --message'),
			result.stderr,
		);
	});

	it('rejects the removed --payload flag when passed to `flue run`', async () => {
		const result = await runCli(['run', 'hello', '--payload', '{}']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Unknown flag for `flue run`: --payload'), result.stderr);
	});

	it('rejects an unknown flag when passed to `flue run`', async () => {
		const result = await runCli(['run', 'hello', '--bogus']);
		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes('Unknown flag for `flue run`: --bogus'), result.stderr);
	});
});
