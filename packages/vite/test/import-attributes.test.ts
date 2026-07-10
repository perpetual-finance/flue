import { build, createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { flue } from '../src/index.ts';
import {
	createFixture,
	type Fixture,
	getAvailablePort,
	TEST_MODEL_MODULE,
	waitFor,
} from './helpers/fixture.ts';

const fixtures: Fixture[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await server.close().catch(() => undefined);
	}
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function attributedImportsFixture(): Fixture {
	const fixture = createFixture({
		'src/test-model.ts': TEST_MODEL_MODULE,
		'src/guide.md': '# Fixture guide\n',
		'src/skills/explore/SKILL.md':
			'---\nname: explore\ndescription: Explore a repository.\n---\nExplore carefully.\n',
		'src/agents/echo.ts': `'use agent';
import { defineAgent, useInstruction, useModel, useSkill } from '@flue/runtime';
import explore from '../skills/explore/SKILL.md' with { type: 'skill' };
import guide from '../guide.md' with { type: 'markdown' };
function echo() {
	useModel('flue-test/fake-model');
	useSkill(explore);
	useInstruction(guide);
}
export default defineAgent(echo);
`,
		'src/app.ts': `import { Hono } from 'hono';
import './test-model.ts';
import echo from './agents/echo.ts';
import explore from './skills/explore/SKILL.md' with { type: 'skill' };
import guide from './guide.md' with { type: 'markdown' };

const app = new Hono();
app.get('/api/guide', (c) => c.text(guide));
app.get('/api/skill', (c) => c.json({ name: explore.name }));
app.route('/agents/echo', echo.route());
export default app;
`,
	});
	fixtures.push(fixture);
	return fixture;
}

describe('import attributes through the outer Vite graph', () => {
	it('serves markdown and packaged-skill imports in dev and admits prompts on the importing agent', async () => {
		const fixture = attributedImportsFixture();
		const port = await getAvailablePort();
		const server = await createServer({
			root: fixture.root,
			configFile: false,
			logLevel: 'error',
			plugins: flue(),
			server: { port, strictPort: true, host: '127.0.0.1' },
		});
		await server.listen();
		servers.push(server);
		const baseUrl = `http://127.0.0.1:${port}`;

		const guide = await waitFor(
			async () => {
				const response = await fetch(`${baseUrl}/api/guide`);
				return response.ok ? response.text() : false;
			},
			{ description: 'the markdown import route' },
		);
		expect(guide).toBe('# Fixture guide\n');

		const skill = await fetch(`${baseUrl}/api/skill`);
		expect(await skill.json()).toEqual({ name: 'explore' });

		const admitted = await fetch(`${baseUrl}/agents/echo/attr-1`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'user', body: 'hello' }),
		});
		expect(admitted.status).toBe(202);
	}, 60_000);

	it('packages markdown and skill imports into the production build', async () => {
		const fixture = attributedImportsFixture();
		await build({ root: fixture.root, configFile: false, logLevel: 'error', plugins: flue() });
	}, 120_000);
});

