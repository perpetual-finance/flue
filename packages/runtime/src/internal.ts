/**
 * Internal runtime helpers consumed by the generated server entry point.
 *
 * This subpath is NOT part of the public API. It exists solely so the build
 * plugins (Node, Cloudflare) can emit stable bare-specifier imports that
 * resolve through normal package-exports resolution at both build time and
 * runtime, for both workspace-linked and published-npm installs.
 *
 * User agent code should never import from here.
 */
import { type Api, getModel, type KnownProvider, type Model } from '@earendil-works/pi-ai/compat';

export { Bash, InMemoryFs } from 'just-bash';

import { resolveRegisteredModel } from './runtime/providers.ts';

export type {
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionDurability,
	SubmissionSettlementObligation,
} from './agent-execution-store.ts';
export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { createFlueContext, initializeRootHarness } from './client.ts';
export {
	CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
	CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH,
	createCloudflareAgentRuntime,
} from './cloudflare/agent-coordinator.ts';
export { createSqlConversationStores } from './cloudflare/agent-execution-store.ts';
// Conversation wire types projected onto the HTTP `history`/`updates` views.
// Exposed here only so the SDK can pin its public projection types to the
// runtime's emitted shapes via a compile-time assignability test.
export type {
	AgentConversationSnapshot,
	ConversationStreamChunk,
} from './conversation-public.ts';
export { configureErrorRendering, RuntimeUnavailableError, toHttpResponse } from './errors.ts';
export type { InstrumentationOwner } from './instrumentation.ts';
export {
	createInstrumentationOwner,
	runWithInstrumentationOwner,
} from './instrumentation.ts';
export { createNodeAgentCoordinator, createNodeDispatchQueue } from './node/agent-coordinator.ts';
export type {
	AgentSubmissionInput,
	AttachedAgentSubmissionAdmission,
	AttachedAgentSubmissionOptions,
} from './runtime/agent-submissions.ts';
export type { AttachmentStore } from './runtime/attachment-store.ts';
export { InMemoryAttachmentStore } from './runtime/attachment-store.ts';
// Submission-scoped conversation observation: in-process settlement waits and
// reply reads over the canonical stream (the CLI's `flue run` and the
// programmatic agent client build on these).
export type {
	ObserveSubmissionSettlementOptions,
	ReadSubmissionReplyOptions,
	SubmissionReply,
	SubmissionSettlement,
} from './runtime/conversation-observer.ts';
export {
	observeSubmissionSettlement,
	readSubmissionReply,
} from './runtime/conversation-observer.ts';
export type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';
export {
	InMemoryConversationStreamStore,
	SqliteConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
export type { AgentInteractionStart } from './runtime/dev-lifecycle-logger.ts';
export { installDevLifecycleLogger } from './runtime/dev-lifecycle-logger.ts';
export type { DispatchInput, DispatchQueue } from './runtime/dispatch-queue.ts';
export type {
	AgentRecord,
	CloudflareRuntime,
	FlueRuntime,
	NodeRuntime,
} from './runtime/flue-app.ts';
// `configureFlueRuntime` seeds the module-scoped config that mounted
// `.route()` handlers read at request time. Called once per generated entry,
// before the listener (Node) or `default.fetch` (Cloudflare) takes traffic.
export { configureFlueRuntime } from './runtime/flue-app.ts';
export type {
	CreateAgentContextFn,
	CreateAgentContextOptions,
	HandleAgentOptions,
} from './runtime/handle-agent.ts';
export {
	handleAgentConversationHead,
	handleAgentConversationRead,
} from './runtime/handle-conversation-routes.ts';
export { hasRegisteredProvider, resetProviderRuntime } from './runtime/providers.ts';
// Identity registry consumed by the new generated bootstraps (the scanned
// `'use agent'` set) and by unit tests mounting `AgentDefinition.route()`.
export type { FlueAgentRegistration } from './runtime/registration.ts';
export {
	getRegisteredFlueAgents,
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
	resolveAgentModuleBinding,
} from './runtime/registration.ts';
export type {
	RuntimeActivityGate,
	RuntimeActivityLease,
} from './runtime/runtime-activity-gate.ts';
export { createRuntimeActivityGate } from './runtime/runtime-activity-gate.ts';
// Storage path of an agent instance's canonical conversation stream — the
// durable-storage contract callers pair with the observation helpers above.
export { agentStreamPath } from './runtime/stream-offsets.ts';

export { bashFactoryToSessionEnv } from './sandbox.ts';
export { parseSkillMarkdown } from './skill-frontmatter.ts';
export { buildPackagedSkill, createSkillReference } from './skill-package.ts';

/**
 * Resolve a `provider-id/model-id` model specifier to a pi-ai Model.
 * Registered provider IDs win over pi-ai's catalog; registrations for
 * catalog provider IDs hydrate metadata from the catalog with the
 * registration's options layered on top.
 */
export function resolveModel(model: string): Model<Api> {
	const modelSpecifier = model;

	const slash = modelSpecifier.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model specifier "${modelSpecifier}". ` +
				`Use the "provider-id/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const providerId = modelSpecifier.slice(0, slash);
	const modelId = modelSpecifier.slice(slash + 1);

	const registered = resolveRegisteredModel(providerId, modelId);
	if (registered) {
		if (modelId === '') {
			throw new Error(
				`[flue] Invalid model specifier "${modelSpecifier}". ` +
					`Provider ID "${providerId}" is registered via registerProvider(), but no model ID ` +
					`was given. Use "${providerId}/<model-id>".`,
			);
		}
		return registered;
	}

	// `getModel` is typed for literal model IDs; runtime strings are checked by
	// the null return below.
	const resolved = getModel(providerId as KnownProvider, modelId as never);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model specifier "${modelSpecifier}". ` +
				`Provider ID "${providerId}" / model ID "${modelId}" ` +
				`is not registered with @earendil-works/pi-ai or via registerProvider().`,
		);
	}
	return resolved;
}
