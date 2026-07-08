/// <reference path="../types/skill-md.d.ts" />
/// <reference path="../types/markdown-md.d.ts" />

export { defineAgent } from './agent-definition.ts';
export {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	AttachmentNotAvailableError,
	DelegationDepthExceededError,
	FlueError,
	InstrumentationAlreadyInstalledError,
	OperationFailedError,
	ProductEventVersionError,
	ProviderRegistrationError,
	SandboxOperationUnsupportedError,
	SessionAlreadyExistsError,
	SessionBusyError,
	SessionNotFoundError,
	SkillDefinitionValidationError,
	SkillNotRegisteredError,
	SubagentNotDeclaredError,
	SubmissionAbortedError,
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
	ToolInputValidationError,
	ToolLegacyDefinitionError,
	ToolNameConflictError,
	ToolOutputSerializationError,
	ToolOutputValidationError,
	type ToolValidationIssue,
	type ValidationIssue,
} from './errors.ts';
export { IMAGE_DATA_OMITTED } from './event-redaction.ts';
export type {
	FlueExecutionContext,
	FlueExecutionInterceptor,
	FlueExecutionOperation,
} from './execution-interceptor.ts';
export { type StateSetter, useState } from './hooks/state.ts';
export { useAgentFinish } from './hooks/use-agent-finish.ts';
export { useAgentStart } from './hooks/use-agent-start.ts';
export { useDelivery } from './hooks/use-delivery.ts';
export { useDispatchMessage } from './hooks/use-dispatch-message.ts';
export { useInitialData } from './hooks/use-initial-data.ts';
export { useInstruction } from './hooks/use-instruction.ts';
export { useMessageData } from './hooks/use-message-data.ts';
export { useMessageMetadata } from './hooks/use-message-metadata.ts';
export { useSandbox } from './hooks/use-sandbox.ts';
export { useSkill } from './hooks/use-skill.ts';
export { useSubagent } from './hooks/use-subagent.ts';
export { useTool } from './hooks/use-tool.ts';
export { type FlueInstrumentation, instrument } from './instrumentation.ts';
export type { JsonValue } from './json-snapshot.ts';
export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';
export { connectMcpServer } from './mcp.ts';
export type {
	AgentAppendMessage,
	AgentFinishContext,
	AgentResponseToolCall,
	AgentSignalAppend,
	AgentStartContext,
	MessageMetadataEvent,
	MessageMetadataPoint,
	MessageMetadataProducer,
} from './message-output.ts';
export type { FlueObservationSubscriber } from './observation.ts';
export { ResultUnavailableError } from './result.ts';
export type { ChannelRouteDefinition, MountableChannel } from './runtime/channel-routes.ts';
export { createChannelRouter } from './runtime/channel-routes.ts';
export { type FlueEventSubscriber, observe } from './runtime/events.ts';
export { type AgentInstanceInfo, dispatch, getAgentInstance } from './runtime/flue-app.ts';
export {
	type HttpProviderRegistration,
	type ProviderRegistration,
	registerApiProvider,
	registerProvider,
} from './runtime/providers.ts';
export type { AgentModuleBinding } from './runtime/registration.ts';
export { __flueBindAgentModule } from './runtime/registration.ts';
export { bash, createSandboxSessionEnv, type SandboxApi } from './sandbox.ts';
export { type DefineSkillOptions, defineSkill } from './skill-definition.ts';
export { defineTool } from './tool.ts';
export type {
	AgentDispatchRequest,
	AgentFunction,
	AgentModuleValue,
	AgentProps,
	AgentRouteHandler,
	AgentRuntimeConfig,
	AttachedAgentEvent,
	BashFactory,
	BashLike,
	CallHandle,
	CompactionConfig,
	DeliveredAttachment,
	DeliveredMessage,
	DispatchReceipt,
	DurabilityConfig,
	FileStat,
	FlueEvent,
	FlueEventContext,
	FlueFs,
	FlueHarness,
	FlueLogger,
	FlueObservation,
	FlueSession,
	FlueSessions,
	FunctionAgentConfig,
	FunctionAgentDefinition,
	LlmAssistantMessage,
	LlmImageContent,
	LlmMessage,
	LlmTextContent,
	LlmThinkingContent,
	LlmTool,
	LlmToolCall,
	LlmToolResultMessage,
	LlmTurnPurpose,
	LlmUserMessage,
	ModelRequest,
	ModelRequestInfo,
	ModelRequestInput,
	ModelResponse,
	PackagedSkillDirectory,
	PackagedSkillFile,
	PromptImage,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
	SessionToolFactoryOptions,
	ShellOptions,
	ShellResult,
	Skill,
	SkillOptions,
	SkillReference,
	SubagentDefinition,
	TaskOptions,
	ThinkingLevel,
	ToolContext,
	ToolDefinition,
	ToolInput,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
} from './types.ts';
export { FLUE_EVENT_SCHEMA_REVISION } from './types.ts';

// Note: the `Fetchable` interface for user-authored `app.ts` entries lives at
// `@flue/runtime/routing`, not on the root barrel.
//
// Note: createFlueContext, bashFactoryToSessionEnv, and the
// FlueContextConfig/FlueContextInternal types are intentionally NOT re-exported
// here. They are internal runtime helpers consumed exclusively by the generated
// server entry point — see `@flue/runtime/internal`. User agent code should not
// need to import any of them directly.
//
// Note: `build`, `dev`, and the build/dev/env helpers used to be re-exported
// from this barrel when the package was `@flue/sdk`. They moved into
// `@flue/cli` when build tooling was extracted from the runtime. Import them
// from `@flue/cli` if you're driving the build programmatically.
