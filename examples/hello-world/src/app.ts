/**
 * Example `app.ts`: the application's route map. Every agent the app serves
 * over HTTP is mounted here explicitly — `app.ts` IS the routing table.
 * Runtime providers are registered here too.
 */
import { registerProvider } from '@flue/runtime';
import { Hono } from 'hono';
import childSession from './agents/child-session.ts';
import compactionTest from './agents/compaction-test.ts';
import fsSurfaceTest from './agents/fs-surface-test.ts';
import fsTest from './agents/fs-test.ts';
import hello from './agents/hello.ts';
import localEnvSmoke from './agents/local-env-smoke.ts';
import sessionTest from './agents/session-test.ts';
import withAbort from './agents/with-abort.ts';
import withImage from './agents/with-image.ts';
import withRegisteredProvider from './agents/with-registered-provider.ts';
import withRequest from './agents/with-request.ts';
import withSandbox from './agents/with-sandbox.ts';
import withSkill from './agents/with-skill.ts';
import withSubagent from './agents/with-subagent.ts';
import withThinking from './agents/with-thinking.ts';
import withTools from './agents/with-tools.ts';

// A brand-new provider ID for a local OpenAI-compatible server.
// (The `ollama` provider registers itself inside
// `./agents/with-registered-provider.ts`, so that demo also works under
// `flue run`, which never loads app.ts.)
registerProvider('lmstudio', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:1234/v1',
});

// Route a catalog provider through a gateway. Catalog metadata (cost,
// context window, wire protocol) is preserved; these options layer on top.
if (process.env.ANTHROPIC_GATEWAY_URL) {
	registerProvider('anthropic', {
		baseUrl: process.env.ANTHROPIC_GATEWAY_URL,
		apiKey: process.env.ANTHROPIC_API_KEY,
	});
}

const app = new Hono();

// Plain Hono middleware.
app.use('*', async (c, next) => {
	const started = Date.now();
	await next();
	const ms = Date.now() - started;
	console.log(`[${c.res.status}] ${c.req.method} ${c.req.path} ${ms}ms`);
});

// Custom route outside Flue's agent API.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Mount every agent explicitly. `.route()` is a pure router factory: the
// mount path is user-chosen (these preserve the conventional
// /agents/<file-basename> addresses), and per-agent middleware comes from
// the module's own `route` named export.
app.route('/agents/child-session', childSession.route());
app.route('/agents/compaction-test', compactionTest.route());
app.route('/agents/fs-surface-test', fsSurfaceTest.route());
app.route('/agents/fs-test', fsTest.route());
app.route('/agents/hello', hello.route());
app.route('/agents/local-env-smoke', localEnvSmoke.route());
app.route('/agents/session-test', sessionTest.route());
app.route('/agents/with-abort', withAbort.route());
app.route('/agents/with-image', withImage.route());
app.route('/agents/with-registered-provider', withRegisteredProvider.route());
app.route('/agents/with-request', withRequest.route());
app.route('/agents/with-sandbox', withSandbox.route());
app.route('/agents/with-skill', withSkill.route());
app.route('/agents/with-subagent', withSubagent.route());
app.route('/agents/with-thinking', withThinking.route());
app.route('/agents/with-tools', withTools.route());

export default app;
