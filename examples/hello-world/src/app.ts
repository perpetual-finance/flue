/**
 * Example `app.ts`: the application's route map. Every agent the app serves
 * over HTTP is mounted here explicitly — `app.ts` IS the routing table.
 * Runtime providers are registered here too.
 */
import { registerProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { CompactionTest } from './agents/compaction-test.ts';
import { FsSurfaceTest } from './agents/fs-surface-test.ts';
import { FsTest } from './agents/fs-test.ts';
import { Hello } from './agents/hello.ts';
import { LocalEnvSmoke } from './agents/local-env-smoke.ts';
import { SessionTest } from './agents/session-test.ts';
import { WithAbort } from './agents/with-abort.ts';
import { WithImage } from './agents/with-image.ts';
import { WithRegisteredProvider } from './agents/with-registered-provider.ts';
import { WithRequest } from './agents/with-request.ts';
import { WithSandbox } from './agents/with-sandbox.ts';
import { WithSkill } from './agents/with-skill.ts';
import { WithSubagent } from './agents/with-subagent.ts';
import { WithThinking } from './agents/with-thinking.ts';
import { WithTools } from './agents/with-tools.ts';

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

// Per-agent middleware composes here, as plain Hono, before the mount it
// applies to. This one logs every request bound for `with-request` and
// requires an `authorization` header.
app.use('/agents/with-request/*', async (c, next) => {
	const request = c.req.raw;
	console.log('[with-request] method:', request.method);
	console.log('[with-request] url:', request.url);
	console.log('[with-request] user-agent:', request.headers.get('user-agent'));
	console.log('[with-request] raw body:', await request.clone().text());
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	console.log('[with-request] ip:', ip);
	if (!request.headers.get('authorization')) return c.json({ error: 'unauthorized' }, 401);
	await next();
});

// Mount every agent explicitly. `createAgentRouter(Fn)` builds a pure router:
// the mount path is user-chosen (these preserve the conventional
// /agents/<file-basename> addresses), and per-agent middleware composes
// above, before the mount it applies to.
app.route('/agents/compaction-test', createAgentRouter(CompactionTest));
app.route('/agents/fs-surface-test', createAgentRouter(FsSurfaceTest));
app.route('/agents/fs-test', createAgentRouter(FsTest));
app.route('/agents/hello', createAgentRouter(Hello));
app.route('/agents/local-env-smoke', createAgentRouter(LocalEnvSmoke));
app.route('/agents/session-test', createAgentRouter(SessionTest));
app.route('/agents/with-abort', createAgentRouter(WithAbort));
app.route('/agents/with-image', createAgentRouter(WithImage));
app.route('/agents/with-registered-provider', createAgentRouter(WithRegisteredProvider));
app.route('/agents/with-request', createAgentRouter(WithRequest));
app.route('/agents/with-sandbox', createAgentRouter(WithSandbox));
app.route('/agents/with-skill', createAgentRouter(WithSkill));
app.route('/agents/with-subagent', createAgentRouter(WithSubagent));
app.route('/agents/with-thinking', createAgentRouter(WithThinking));
app.route('/agents/with-tools', createAgentRouter(WithTools));

export default app;
