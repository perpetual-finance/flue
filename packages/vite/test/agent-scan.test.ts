import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentModuleParseError,
	AnonymousAgentExportError,
	DuplicateAgentIdentityError,
	InvalidAgentIdentityError,
	InvalidAgentNameStaticError,
	NoAgentExportsError,
	scanAgents,
} from '../src/agent-scan.ts';

/** One exported capitalized agent function. */
function agentBody(name: string): string {
	return `export function ${name}() {\n  return 'be helpful';\n}`;
}

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
			'agents/triage.ts': `'use agent';\n${agentBody('Triage')}`,
			'nested/deeper/escalation.ts': `'use agent';\n${agentBody('EscalationBot')}`,
			'app.ts': `export default {};`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toEqual([
			{
				filePath: path.join(root, 'agents/triage.ts'),
				exportName: 'Triage',
				identity: 'Triage',
				className: 'FlueTriageAgent',
				bindingName: 'FLUE_TRIAGE_AGENT',
			},
			{
				filePath: path.join(root, 'nested/deeper/escalation.ts'),
				exportName: 'EscalationBot',
				identity: 'EscalationBot',
				className: 'FlueEscalationBotAgent',
				bindingName: 'FLUE_ESCALATION_BOT_AGENT',
			},
		]);
	});

	it('scans multiple agents from one module, in source order', async () => {
		const root = await makeFixture({
			'agents/team.ts': [
				`'use agent';`,
				agentBody('Zeta'),
				agentBody('Alpha'),
				`export const Middle = () => 'arrow agents count';`,
			].join('\n'),
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['Zeta', 'Alpha', 'Middle']);
		expect(results.map((result) => result.exportName)).toEqual(['Zeta', 'Alpha', 'Middle']);
	});

	it('recognizes only capitalized exported functions as agents', async () => {
		const root = await makeFixture({
			'agents/mixed.ts': [
				`'use agent';`,
				agentBody('Agent'),
				`export function helper() { return 1; }`, // lowercase → helper
				`export const also = () => 2;`, // lowercase → helper
				`export const SCHEMA_LIKE = { shape: true };`, // not a function
				`export class Machine {}`, // classes are never agents
				`function Hidden() {}`, // not exported
			].join('\n'),
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['Agent']);
	});

	it('recognizes named default-exported functions under the default export', async () => {
		const root = await makeFixture({
			'agents/main.ts': `'use agent';\nexport default function MainAgent() { return 'x'; }`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toMatchObject([
			{ exportName: 'default', identity: 'MainAgent', className: 'FlueMainAgentAgent' },
		]);
	});

	it('recognizes local functions exported via specifiers, under the exported name', async () => {
		const root = await makeFixture({
			'agents/specifiers.ts': [
				`'use agent';`,
				`function Original() { return 'x'; }`,
				`const Arrow = () => 'y';`,
				`export { Original, Arrow as Renamed };`,
			].join('\n'),
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => [result.exportName, result.identity])).toEqual([
			['Original', 'Original'],
			['Renamed', 'Renamed'],
		]);
	});

	it('never registers re-exports — an agent registers where it is defined', async () => {
		const root = await makeFixture({
			'agents/source.ts': `'use agent';\n${agentBody('Actual')}`,
			'agents/hub.ts': [
				`'use agent';`,
				agentBody('HubAgent'),
				`export { Actual as Smuggled } from './source.ts';`,
				`export * from './source.ts';`,
			].join('\n'),
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['HubAgent', 'Actual']);
	});

	it('rejects anonymous default-exported functions', async () => {
		const root = await makeFixture({
			'agents/anonymous.ts': `'use agent';\nexport default function () { return 'x'; }`,
		});
		const error = await expectRejection(
			scanAgents({ sourceRoot: root }),
			AnonymousAgentExportError,
		);
		expect(error.filePath).toBe(path.join(root, 'agents/anonymous.ts'));

		const arrow = await makeFixture({
			'agents/arrow.ts': `'use agent';\nexport default () => 'x';`,
		});
		await expectRejection(scanAgents({ sourceRoot: arrow }), AnonymousAgentExportError);
	});

	it('rejects a marked module with no agent exports', async () => {
		const root = await makeFixture({
			'agents/empty.ts': `'use agent';\nexport const config = { helpful: true };`,
		});

		const error = await expectRejection(scanAgents({ sourceRoot: root }), NoAgentExportsError);
		expect(error.filePath).toBe(path.join(root, 'agents/empty.ts'));
		expect(error.message).toContain('exports no agents');
	});

	it('returns deterministically path-sorted results', async () => {
		const root = await makeFixture({
			'z-last.ts': `'use agent';\n${agentBody('Zed')}`,
			'a-first.ts': `'use agent';\n${agentBody('Ada')}`,
			'middle/agent-m.ts': `'use agent';\n${agentBody('Mid')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['Ada', 'Mid', 'Zed']);
	});

	it('accepts a shebang and comments ahead of the directive prologue', async () => {
		const root = await makeFixture({
			'cli-agent.mjs': [
				'#!/usr/bin/env node',
				'// a line comment',
				'/* a block',
				'   comment */',
				`'use agent';`,
				agentBody('Cli'),
			].join('\n'),
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['Cli']);
	});

	it('parses TypeScript-only syntax in .ts and .mts agent modules', async () => {
		const root = await makeFixture({
			'typed.ts': `'use agent';\nimport { type FlueConfig } from '@flue/runtime/config';\nconst effort: 'high' | 'low' = 'high' as const;\nexport function Typed(): string { return effort; }\n`,
			'typed-module.mts': `'use agent';\nconst level: number = 1;\nexport const TypedModule = (): number => level;\n`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['TypedModule', 'Typed']);
	});

	it("recognizes the directive in either order alongside 'use strict'", async () => {
		const root = await makeFixture({
			'strict-first.ts': `'use strict';\n'use agent';\n${agentBody('StrictFirst')}`,
			'agent-first.ts': `'use agent';\n'use strict';\n${agentBody('AgentFirst')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['AgentFirst', 'StrictFirst']);
	});

	it('recognizes double-quoted directives and ASI (no semicolon) directives', async () => {
		const root = await makeFixture({
			'double-quoted.ts': `"use agent";\n${agentBody('DoubleQuoted')}`,
			'no-semicolon.ts': `'use agent'\n${agentBody('NoSemicolon')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['DoubleQuoted', 'NoSemicolon']);
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
			'escaped.ts': `'use\\x20agent';\n${agentBody('Escaped')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toEqual([]);
	});

	it('scans .ts, .mts, .js, and .mjs modules and nothing else', async () => {
		const root = await makeFixture({
			'agent-a.ts': `'use agent';\n${agentBody('AgentA')}`,
			'agent-b.mts': `'use agent';\n${agentBody('AgentB')}`,
			'agent-c.js': `'use agent';\n${agentBody('AgentC')}`,
			'agent-d.mjs': `'use agent';\n${agentBody('AgentD')}`,
			'agent-e.tsx': `'use agent';\n${agentBody('AgentE')}`,
			'agent-f.txt': `'use agent';`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual([
			'AgentA',
			'AgentB',
			'AgentC',
			'AgentD',
		]);
	});

	it('excludes dependency, output, generated, and dot directories plus dotfiles', async () => {
		const root = await makeFixture({
			'kept.ts': `'use agent';\n${agentBody('Kept')}`,
			'node_modules/dep/agent-a.ts': `'use agent';\n${agentBody('DepA')}`,
			'nested/node_modules/dep/agent-b.ts': `'use agent';\n${agentBody('DepB')}`,
			'dist/agent-c.ts': `'use agent';\n${agentBody('DistC')}`,
			'output/agent-d.ts': `'use agent';\n${agentBody('OutD')}`,
			'.flue-vite/agent-e.ts': `'use agent';\n${agentBody('GenE')}`,
			'.wrangler/agent-f.ts': `'use agent';\n${agentBody('GenF')}`,
			'.hidden/agent-g.ts': `'use agent';\n${agentBody('HidG')}`,
			'.dotfile-agent.ts': `'use agent';\n${agentBody('DotH')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['Kept']);
	});

	it('honors an agents glob override while keeping the standard exclusions', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${agentBody('Triage')}`,
			'agents/node_modules/dep/vendored.ts': `'use agent';\n${agentBody('Vendored')}`,
			'elsewhere/other.ts': `'use agent';\n${agentBody('Other')}`,
		});

		const results = await scanAgents({ sourceRoot: root, agents: 'agents/**/*.ts' });

		expect(results.map((result) => result.identity)).toEqual(['Triage']);
	});

	it('accepts an array of agents glob overrides', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${agentBody('Triage')}`,
			'bots/helper.mts': `'use agent';\n${agentBody('Helper')}`,
			'elsewhere/other.ts': `'use agent';\n${agentBody('Other')}`,
		});

		const results = await scanAgents({
			sourceRoot: root,
			agents: ['agents/**/*.ts', 'bots/**/*.mts'],
		});

		// Path-sorted: agents/triage.ts before bots/helper.mts.
		expect(results.map((result) => result.identity)).toEqual(['Triage', 'Helper']);
	});

	it('rejects duplicate identities across scanned files, naming both agents', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${agentBody('Triage')}`,
			'more/other.mts': `'use agent';\n${agentBody('Triage')}`,
			'unique.ts': `'use agent';\n${agentBody('Unique')}`,
		});

		const error = await expectRejection(
			scanAgents({ sourceRoot: root }),
			DuplicateAgentIdentityError,
		);
		expect(error.duplicates).toEqual([
			{
				identity: 'Triage',
				filePaths: [
					`${path.join(root, 'agents/triage.ts')}#Triage`,
					`${path.join(root, 'more/other.mts')}#Triage`,
				],
			},
		]);
		expect(error.message).toContain(path.join(root, 'agents/triage.ts'));
		expect(error.message).toContain(path.join(root, 'more/other.mts'));
	});

	it('rejects duplicate identities within one file', async () => {
		const root = await makeFixture({
			'agents/twins.ts': [
				`'use agent';`,
				agentBody('First'),
				agentBody('Second'),
				`First.agentName = 'twin';`,
				`Second.agentName = 'twin';`,
			].join('\n'),
		});

		await expectRejection(scanAgents({ sourceRoot: root }), DuplicateAgentIdentityError);
	});

	it('accepts PascalCase and kebab-case identities, rejects everything else', async () => {
		const valid = await makeFixture({
			'agents/pascal.ts': `'use agent';\n${agentBody('IssueTriage')}`,
			'agents/kebab.ts': `'use agent';\n${agentBody('Kebab')}\nKebab.agentName = 'issue-helper';`,
		});
		const results = await scanAgents({ sourceRoot: valid });
		expect(results.map((result) => result.identity)).toEqual(['issue-helper', 'IssueTriage']);

		const invalid = await makeFixture({
			'agents/snake.ts': `'use agent';\n${agentBody('Snake_Case')}`,
		});
		const error = await expectRejection(
			scanAgents({ sourceRoot: invalid }),
			InvalidAgentIdentityError,
		);
		expect(error.invalidAgents).toEqual([
			{ identity: 'Snake_Case', filePath: path.join(invalid, 'agents/snake.ts') },
		]);
	});

	it('splits camel boundaries in generated binding names', async () => {
		const root = await makeFixture({
			'agents/triage.ts': `'use agent';\n${agentBody('IssueTriage')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results).toMatchObject([
			{
				identity: 'IssueTriage',
				className: 'FlueIssueTriageAgent',
				bindingName: 'FLUE_ISSUE_TRIAGE_AGENT',
			},
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
			'kept.ts': `'use agent';\n${agentBody('Kept')}`,
		});

		const results = await scanAgents({ sourceRoot: root });

		expect(results.map((result) => result.identity)).toEqual(['Kept']);
	});

	it('returns an empty list for a project with no agents', async () => {
		const root = await makeFixture({
			'app.ts': `export default {};`,
			'lib/util.ts': `export const helper = () => 1;`,
		});

		await expect(scanAgents({ sourceRoot: root })).resolves.toEqual([]);
	});

	describe('`agentName` static identity override', () => {
		it('prefers the agentName static over the function name for all derived identifiers', async () => {
			const root = await makeFixture({
				'agents/foo.ts': `'use agent';\n${agentBody('Foo')}\nFoo.agentName = 'issue-triage';`,
			});

			const results = await scanAgents({ sourceRoot: root });

			expect(results).toEqual([
				{
					filePath: path.join(root, 'agents/foo.ts'),
					exportName: 'Foo',
					identity: 'issue-triage',
					className: 'FlueIssueTriageAgent',
					bindingName: 'FLUE_ISSUE_TRIAGE_AGENT',
				},
			]);
		});

		it('applies to default-exported agents through the function name', async () => {
			const root = await makeFixture({
				'agents/main.ts': [
					`'use agent';`,
					`export default function Main() { return 'x'; }`,
					`Main.agentName = 'the-main-agent';`,
				].join('\n'),
			});

			const results = await scanAgents({ sourceRoot: root });

			expect(results).toMatchObject([{ exportName: 'default', identity: 'the-main-agent' }]);
		});

		it('accepts TS type-position wrappers around the literal', async () => {
			const root = await makeFixture({
				'agents/foo.ts': `'use agent';\n${agentBody('Foo')}\nFoo.agentName = 'wrapped' as const;`,
			});

			const results = await scanAgents({ sourceRoot: root });

			expect(results.map((result) => result.identity)).toEqual(['wrapped']);
		});

		it('rejects a computed agentName static', async () => {
			const root = await makeFixture({
				'agents/foo.ts': `'use agent';\n${agentBody('Foo')}\nconst n = 'x';\nFoo.agentName = n + '-agent';`,
			});

			const error = await expectRejection(
				scanAgents({ sourceRoot: root }),
				InvalidAgentNameStaticError,
			);
			expect(error.filePath).toBe(path.join(root, 'agents/foo.ts'));
			expect(error.message).toContain('statically readable');
		});

		it('ignores agentName assignments on non-agent identifiers', async () => {
			const root = await makeFixture({
				'agents/foo.ts': [
					`'use agent';`,
					agentBody('Foo'),
					`const somethingElse = { agentName: '' };`,
					`somethingElse.agentName = computeIt();`,
					`function computeIt() { return 'x'; }`,
				].join('\n'),
			});

			const results = await scanAgents({ sourceRoot: root });

			expect(results.map((result) => result.identity)).toEqual(['Foo']);
		});

		it('applies the identity pattern to the override', async () => {
			const root = await makeFixture({
				'agents/foo.ts': `'use agent';\n${agentBody('Foo')}\nFoo.agentName = 'not valid!';`,
			});

			const error = await expectRejection(
				scanAgents({ sourceRoot: root }),
				InvalidAgentIdentityError,
			);
			expect(error.invalidAgents).toEqual([
				{ identity: 'not valid!', filePath: path.join(root, 'agents/foo.ts') },
			]);
		});

		it('detects duplicates between an override and a function name', async () => {
			const root = await makeFixture({
				'agents/foo.ts': `'use agent';\n${agentBody('Foo')}\nFoo.agentName = 'Triage';`,
				'agents/triage.ts': `'use agent';\n${agentBody('Triage')}`,
			});

			const error = await expectRejection(
				scanAgents({ sourceRoot: root }),
				DuplicateAgentIdentityError,
			);
			expect(error.duplicates).toMatchObject([{ identity: 'Triage' }]);
		});

		it('ignores agentName statics in modules without the directive', async () => {
			const root = await makeFixture({
				'lib/helper.ts': `export function Helper() {}\nHelper.agentName = compute();\nfunction compute() { return 'x'; }`,
				'agents/kept.ts': `'use agent';\n${agentBody('Kept')}`,
			});

			const results = await scanAgents({ sourceRoot: root });

			expect(results.map((result) => result.identity)).toEqual(['Kept']);
		});
	});
});
