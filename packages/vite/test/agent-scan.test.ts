import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentModuleParseError,
	DuplicateAgentIdentityError,
	InvalidAgentIdentityError,
	scanAgents,
} from '../src/agent-scan.ts';

const AGENT_BODY = [
	`export default { instructions: 'be helpful' };`,
	`export const description = 'an agent';`,
].join('\n');

const fixtureRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		fixtureRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })),
	);
});

/** Writes an on-disk fixture tree and returns its root directory. */
async function makeFixture(files: Record<string, string>): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-agent-scan-'));
	fixtureRoots.push(root);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(root, relativePath);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, content);
	}
	// macOS tmpdir is a symlink (/var → /private/var); resolve so result
	// paths compare cleanly against fixture paths.
	return fs.promises.realpath(root);
}

async function expectRejection<T extends Error>(
	scan: Promise<unknown>,
	errorClass: new (...args: never[]) => T,
): Promise<T> {
	try {
		await scan;
	} catch (error) {
		expect(error).toBeInstanceOf(errorClass);
		return error as T;
	}
	expect.unreachable('expected the scan to reject');
}

describe('scanAgents()', () => {
	it('finds directive-marked modules recursively and derives durable identifiers', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${AGENT_BODY}`,
			'nested/deeper/escalation-bot.ts': `'use agent';\n${AGENT_BODY}`,
			'app.ts': `export default {};`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toEqual([
			{
				filePath: path.join(root, 'agents/triage.ts'),
				identity: 'triage',
				className: 'FlueTriageAgent',
				bindingName: 'FLUE_TRIAGE_AGENT',
			},
			{
				filePath: path.join(root, 'nested/deeper/escalation-bot.ts'),
				identity: 'escalation-bot',
				className: 'FlueEscalationBotAgent',
				bindingName: 'FLUE_ESCALATION_BOT_AGENT',
			},
		]);
	});

	it('returns deterministically path-sorted results', async () => {
		const root = await makeFixture({
			'z-last.ts': `'use agent';\n${AGENT_BODY}`,
			'a-first.ts': `'use agent';\n${AGENT_BODY}`,
			'middle/agent-m.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['a-first', 'agent-m', 'z-last']);
	});

	it('accepts a shebang and comments ahead of the directive prologue', async () => {
		const root = await makeFixture({
			'cli-agent.mjs': [
				'#!/usr/bin/env node',
				'// a line comment',
				'/* a block',
				'   comment */',
				`'use agent';`,
				AGENT_BODY,
			].join('\n'),
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['cli-agent']);
	});

	it('parses TypeScript-only syntax in .ts and .mts agent modules', async () => {
		const root = await makeFixture({
			'typed.ts': `'use agent';\nimport { type FlueConfig } from '@flue/runtime/config';\nconst effort: 'high' | 'low' = 'high' as const;\nexport const description: string = effort;\nexport default { effort };\n`,
			'typed-module.mts': `'use agent';\nconst level: number = 1;\nexport default { level };\n`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['typed-module', 'typed']);
	});

	it("recognizes the directive in either order alongside 'use strict'", async () => {
		const root = await makeFixture({
			'strict-first.ts': `'use strict';\n'use agent';\n${AGENT_BODY}`,
			'agent-first.ts': `'use agent';\n'use strict';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['agent-first', 'strict-first']);
	});

	it('recognizes double-quoted directives and ASI (no semicolon) directives', async () => {
		const root = await makeFixture({
			'double-quoted.ts': `"use agent";\n${AGENT_BODY}`,
			'no-semicolon.ts': `'use agent'\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['double-quoted', 'no-semicolon']);
	});

	it('ignores the directive string outside the prologue position', async () => {
		const root = await makeFixture({
			'after-import.ts': `import * as os from 'node:os';\n'use agent';\nexport default os;`,
			'after-statement.ts': `const x = 1;\n'use agent';\nexport default x;`,
			'in-function.ts': `export default function run() {\n  'use agent';\n}`,
			'as-expression.ts': `const marker = 'use agent';\nexport default marker;`,
			'in-larger-expression.ts': `('use agent').length;\nexport default 1;`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toEqual([]);
	});

	it('does not treat escaped string variants as the directive', async () => {
		const root = await makeFixture({
			// Raw source between the quotes is `use\x20agent`, not `use agent` —
			// same raw-code-unit rule ECMAScript applies to 'use strict'.
			'escaped.ts': `'use\\x20agent';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toEqual([]);
	});

	it('scans .ts, .mts, .js, and .mjs modules and nothing else', async () => {
		const root = await makeFixture({
			'agent-a.ts': `'use agent';\n${AGENT_BODY}`,
			'agent-b.mts': `'use agent';\n${AGENT_BODY}`,
			'agent-c.js': `'use agent';\n${AGENT_BODY}`,
			'agent-d.mjs': `'use agent';\n${AGENT_BODY}`,
			'agent-e.tsx': `'use agent';\nexport default null;`,
			'agent-f.txt': `'use agent';`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual([
			'agent-a',
			'agent-b',
			'agent-c',
			'agent-d',
		]);
	});

	it('excludes dependency, output, generated, and dot directories plus dotfiles', async () => {
		const root = await makeFixture({
			'kept.ts': `'use agent';\n${AGENT_BODY}`,
			'node_modules/dep/agent-a.ts': `'use agent';\n${AGENT_BODY}`,
			'nested/node_modules/dep/agent-b.ts': `'use agent';\n${AGENT_BODY}`,
			'dist/agent-c.ts': `'use agent';\n${AGENT_BODY}`,
			'output/agent-d.ts': `'use agent';\n${AGENT_BODY}`,
			'.flue-vite/agent-e.ts': `'use agent';\n${AGENT_BODY}`,
			'.wrangler/agent-f.ts': `'use agent';\n${AGENT_BODY}`,
			'.hidden/agent-g.ts': `'use agent';\n${AGENT_BODY}`,
			'.dotfile-agent.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['kept']);
	});

	it('honors an agents glob override while keeping the standard exclusions', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${AGENT_BODY}`,
			'agents/node_modules/dep/vendored.ts': `'use agent';\n${AGENT_BODY}`,
			'elsewhere/other.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root, agents: 'agents/**/*.ts' });

		expect(results.map((result) => result.identity)).toEqual(['triage']);
	});

	it('accepts an array of agents glob overrides', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${AGENT_BODY}`,
			'bots/helper.mts': `'use agent';\n${AGENT_BODY}`,
			'elsewhere/other.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({
			sourceRoot: root,
			agents: ['agents/**/*.ts', 'bots/**/*.mts'],
		});

		// Path-sorted: agents/triage.ts before bots/helper.mts.
		expect(results.map((result) => result.identity)).toEqual(['triage', 'helper']);
	});

	it('rejects duplicate identities across scanned files, naming both paths', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${AGENT_BODY}`,
			'more/triage.mts': `'use agent';\n${AGENT_BODY}`,
			'unique.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const error = await expectRejection(
			scanAgents({ sourceRoot: root }),
			DuplicateAgentIdentityError,
		);
		expect(error.duplicates).toEqual([
			{
				identity: 'triage',
				filePaths: [path.join(root, 'agents/triage.ts'), path.join(root, 'more/triage.mts')],
			},
		]);
		expect(error.message).toContain(path.join(root, 'agents/triage.ts'));
		expect(error.message).toContain(path.join(root, 'more/triage.mts'));
	});

	it('rejects identities that are not lower-kebab-case', async () => {
		const root = await makeFixture({
			'agents/MyAgent.ts': `'use agent';\n${AGENT_BODY}`,
			'agents/snake_case.ts': `'use agent';\n${AGENT_BODY}`,
			'agents/fine.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const error = await expectRejection(
			scanAgents({ sourceRoot: root }),
			InvalidAgentIdentityError,
		);
		expect(error.invalidAgents).toEqual([
			{ identity: 'MyAgent', filePath: path.join(root, 'agents/MyAgent.ts') },
			{ identity: 'snake_case', filePath: path.join(root, 'agents/snake_case.ts') },
		]);
	});

	it('fails loud when a directive candidate cannot be parsed', async () => {
		const root = await makeFixture({
			'broken.ts': `'use agent';\nconst = broken syntax here`,
		});

		const error = await expectRejection(scanAgents({ sourceRoot: root }), AgentModuleParseError);
		expect(error.filePath).toBe(path.join(root, 'broken.ts'));
	});

	it('never parses files without the raw directive text, even if unparseable', async () => {
		const root = await makeFixture({
			'broken-non-candidate.ts': `const = broken syntax here`,
			'kept.ts': `'use agent';\n${AGENT_BODY}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['kept']);
	});

	it('returns an empty list for a project with no agents', async () => {
		const root = await makeFixture({
			'app.ts': `export default {};`,
			'lib/util.ts': `export const helper = () => 1;`,
		});

		await expect(scanAgents({ sourceRoot: root })).resolves.toEqual([]);
	});
});
