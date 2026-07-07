import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Node-based export-map smoke tests cannot load the Cloudflare virtual module
// referenced from @flue/runtime/cloudflare/internal's graph; real Cloudflare
// runtime behavior is covered by explicit boundary and integration suites.
vi.mock('cloudflare:workers', () => ({
	DurableObject: class {},
}));

beforeAll(() => {
	if (!existsSync('dist/internal.mjs')) {
		execFileSync('pnpm', ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' });
	}
});

describe('package entrypoints', () => {
	it('exposes core authoring APIs when a consumer imports @flue/runtime', async () => {
		const runtime = await import('@flue/runtime');

		expect(runtime).toMatchObject({
			DelegationDepthExceededError: expect.any(Function),
			connectMcpServer: expect.any(Function),
			defineAgent: expect.any(Function),
			createSandboxSessionEnv: expect.any(Function),
			defineAgentProfile: expect.any(Function),
			defineSkill: expect.any(Function),
			defineTool: expect.any(Function),
			dispatch: expect.any(Function),
			observe: expect.any(Function),
			registerApiProvider: expect.any(Function),
			registerProvider: expect.any(Function),
			createChannelRouter: expect.any(Function),
			__flueBindAgentModule: expect.any(Function),
		});
		expect(runtime).not.toHaveProperty('Type');
		expect(runtime).not.toHaveProperty('interceptExecution');
		expect(runtime).not.toHaveProperty('registerExecutionInterceptor');
		expect(runtime).not.toHaveProperty('resetFlueRuntimeForTests');
		expect(runtime).not.toHaveProperty('resetProviderRuntime');
	});

	it('exposes no workflow surface from the public type declarations', () => {
		const declarations = readFileSync('dist/index.d.mts', 'utf8');

		expect(declarations).not.toContain('WorkflowDefinition');
		expect(declarations).not.toContain('defineWorkflow');
	});

	it('exposes current context names without unreleased legacy names', () => {
		const declarations = readFileSync('dist/index.d.mts', 'utf8');

		expect(declarations).toContain('FlueEventContext');
		expect(declarations).not.toContain('AgentInitializerContext');
		expect(declarations).not.toContain('FlueContext,');
		expect(declarations).not.toContain('AgentCreateContext');
		expect(declarations).not.toContain('inputJsonSchema');
	});

	it('exposes no runtime values from @flue/runtime/routing (types only)', async () => {
		const routing = await import('@flue/runtime/routing');

		expect(routing).not.toHaveProperty('flue');
		expect(routing).not.toHaveProperty('admin');
	});

	it('exposes the project config authoring API from @flue/runtime/config', async () => {
		const config = await import('@flue/runtime/config');

		expect(config).toMatchObject({
			defineConfig: expect.any(Function),
			loadFlueConfig: expect.any(Function),
			parseFlueConfig: expect.any(Function),
			resolveFlueProject: expect.any(Function),
			resolveSourceRoot: expect.any(Function),
		});
	});

	it('exposes the portable tool authoring API from @flue/runtime/tool', async () => {
		const tool = await import('@flue/runtime/tool');

		expect(tool).toMatchObject({
			defineTool: expect.any(Function),
		});
		expect(tool).not.toHaveProperty('normalizeToolDefinition');
	});

	it('exposes canonical tool types without legacy declaration names', () => {
		const declaration = readFileSync('dist/tool-entrypoint.d.mts', 'utf8');

		expect(declaration).toContain('ToolContext');
		expect(declaration).toContain('ToolInput');
		expect(declaration).toContain('ToolOutput');
		expect(declaration).not.toContain('ToolArgs');
		expect(declaration).not.toContain('ToolParameters');
	});

	it('exposes generated-runtime APIs when generated code imports @flue/runtime/internal', async () => {
		const internal = await import('@flue/runtime/internal');

		expect(internal).toMatchObject({
			configureFlueRuntime: expect.any(Function),
			resolveModel: expect.any(Function),
		});
		expect(internal).not.toHaveProperty('createDefaultFlueApp');
	});

	it('exposes local() when a consumer imports @flue/runtime/node', async () => {
		const node = await import('@flue/runtime/node');

		expect(node.local).toEqual(expect.any(Function));
	});

	it('exposes Cloudflare authoring APIs when a consumer imports @flue/runtime/cloudflare', async () => {
		const cloudflare = await import('@flue/runtime/cloudflare');

		expect(cloudflare).toMatchObject({
			cloudflareSandbox: expect.any(Function),
			extend: expect.any(Function),
			getCloudflareContext: expect.any(Function),
			getDurableObjectIdentity: expect.any(Function),
		});
		expect(cloudflare).not.toHaveProperty('FlueRegistry');
		expect(cloudflare).not.toHaveProperty('cfSandboxToSessionEnv');
		expect(cloudflare).not.toHaveProperty('resolveCloudflareExtension');
	});

	it('exposes generated Worker plumbing when generated code imports @flue/runtime/cloudflare/internal', async () => {
		const internal = await import('@flue/runtime/cloudflare/internal');

		expect(internal).toMatchObject({
			cfSandboxToSessionEnv: expect.any(Function),
			getCloudflareAIBindingApiProvider: expect.any(Function),
			resolveCloudflareExtension: expect.any(Function),
			runWithCloudflareContext: expect.any(Function),
		});
		expect(internal).not.toHaveProperty('FlueRegistry');
		expect(internal).not.toHaveProperty('createCloudflareRunStore');
	});

	it('exposes the adapter contract suites when an adapter author imports @flue/runtime/test-utils', async () => {
		const testUtils = await import('@flue/runtime/test-utils');

		expect(testUtils).toMatchObject({
			defineAttachmentStoreContractTests: expect.any(Function),
			defineConversationStreamStoreContractTests: expect.any(Function),
			defineStoreContractTests: expect.any(Function),
		});
		expect(testUtils).not.toHaveProperty('defineRunStoreContractTests');
		expect(testUtils).not.toHaveProperty('defineEventStreamStoreContractTests');
	});
});
