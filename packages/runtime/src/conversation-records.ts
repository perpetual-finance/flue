import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ResourceSnapshot } from './resources.ts';
import { generateEntryId, generateRecordId } from './runtime/ids.ts';
import type { PromptUsage } from './types.ts';

interface ConversationRecordEnvelope {
	v: 1;
	id: string;
	type: string;
	conversationId: string;
	harness: string;
	session: string;
	timestamp: string;
	submissionId?: string;
	dispatchId?: string;
	operationId?: string;
	turnId?: string;
	attemptId?: string;
}

export interface AttachmentRef {
	id: string;
	mimeType: string;
	size: number;
	digest: string;
	/**
	 * Original filename, when the uploader provided one. Presentation metadata,
	 * not part of byte identity — excluded from attachment-store equality and not
	 * required by the attachment stores (it travels in the canonical record).
	 */
	filename?: string;
}

export type CanonicalUserContent =
	| { type: 'text'; text: string }
	| { type: 'attachment'; attachment: AttachmentRef };

export type CanonicalToolResultContent =
	| Extract<ToolResultMessage['content'][number], { type: 'text' }>
	| { type: 'attachment'; attachment: AttachmentRef };

interface ConversationCreatedRecordBase extends ConversationRecordEnvelope {
	type: 'conversation_created';
	affinityKey: string;
	createdAt: string;
}

export type ConversationCreatedRecord = ConversationCreatedRecordBase &
	(
		| {
				kind: 'root';
				parentConversationId?: never;
				taskId?: never;
				actionInvocationId?: never;
				agent?: never;
				/**
				 * Instance-creation data, recorded exactly once at birth (the
				 * schema-parsed value when the agent declares `input:`). Read by
				 * `useInitialData()`; never re-validated after creation.
				 */
				data?: unknown;
				/**
				 * The instance uid: a server-minted identifier recorded exactly
				 * once at birth, constant for the incarnation's whole life. The
				 * instance id is the address (client-chosen, reusable); the uid
				 * names this incarnation. Callers use it as a send condition
				 * (`uid` continues only this incarnation; `uid: null` creates
				 * only when fresh). Absent on records written before uids
				 * shipped.
				 */
				uid?: string;
		  }
		| {
				kind: 'task';
				parentConversationId: string;
				taskId: string;
				actionInvocationId?: never;
				/**
				 * Subagent name this task ran, when one was selected.
				 * Absent for agent-less tasks. Presentation metadata for the task
				 * tree — never part of conversation identity.
				 */
				agent?: string;
		  }
		| {
				kind: 'action';
				parentConversationId: string;
				actionInvocationId: string;
				taskId?: never;
				agent?: never;
		  }
	);

interface UserMessageRecord extends ConversationRecordEnvelope {
	type: 'user_message';
	messageId: string;
	parentId: string | null;
	content: CanonicalUserContent[];
}

interface SignalRecord extends ConversationRecordEnvelope {
	type: 'signal';
	messageId: string;
	parentId: string | null;
	signalType: string;
	tagName?: string;
	content: string;
	attributes?: Record<string, string>;
}

type AssistantModelInfo = Omit<
	AssistantMessage,
	'role' | 'content' | 'stopReason' | 'errorMessage' | 'timestamp' | 'usage'
>;

export interface AssistantMessageStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_started';
	messageId: string;
	parentId: string | null;
	modelInfo: AssistantModelInfo;
	/**
	 * Custom response metadata from the render's `useResponseStart` hooks
	 * producers. Stamped only on a submission's first assistant message (the
	 * response message); merged with any later `message_metadata` records in
	 * stream order.
	 */
	responseMetadata?: Record<string, unknown>;
}

interface AssistantTextStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

interface AssistantTextDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

interface AssistantTextCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	/** Provider signature for the completed text block, captured at completion so
	 *  it round-trips back to the provider on the next turn. */
	textSignature?: string;
}

interface AssistantReasoningStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

interface AssistantReasoningDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

interface AssistantReasoningCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	encrypted?: string;
	redacted?: boolean;
}

interface AssistantToolCallRecord extends ConversationRecordEnvelope {
	type: 'assistant_tool_call';
	messageId: string;
	blockId: string;
	blockIndex: number;
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

interface AssistantMessageCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_completed';
	messageId: string;
	stopReason: AssistantMessage['stopReason'];
	usage: AssistantMessage['usage'];
	error?: string;
}

interface ToolOutcomeRecord extends ConversationRecordEnvelope {
	type: 'tool_outcome';
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/**
	 * Model-facing result content (text/attachment blocks) sent back to the LLM.
	 */
	content: CanonicalToolResultContent[];
	/**
	 * Validated structured application output, when the tool declared one. Kept
	 * distinct from `content` so the UI can render the typed value instead of the
	 * serialized model-facing text. Absent for tools without structured output.
	 */
	output?: unknown;
	/**
	 * Tool-handler execution time in milliseconds, measured from execution start
	 * to end. Durably records the same duration otherwise only carried on the
	 * ephemeral `tool` event. Absent on records written before this field
	 * existed.
	 */
	durationMs?: number;
}

interface ToolResultsCommittedRecord extends ConversationRecordEnvelope {
	type: 'tool_results_committed';
	assistantMessageId: string;
	parentId: string;
	outcomeIds: string[];
}

export interface CompactionRecord extends ConversationRecordEnvelope {
	type: 'compaction';
	entryId: string;
	parentId: string | null;
	summary: string;
	firstKeptEntryId: string;
	sourceLeafId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: PromptUsage;
}

interface CanonicalChildSessionRefBase {
	conversationId: string;
	harness: string;
	session: string;
}

export type CanonicalChildSessionRef =
	| (CanonicalChildSessionRefBase & {
			type: 'task';
			taskId: string;
			invocationId?: never;
			/**
			 * The parent `task` tool call that spawned this child, and the assistant
			 * entry holding it. Present when the task was invoked by the model as a
			 * tool call; absent for a programmatic `session.task()` (which has no
			 * parent tool call). Durable join key used by recovery to resolve the
			 * parent's tool call from the child — never inferred.
			 */
			parentToolCallId?: string;
			parentAssistantEntryId?: string;
	  })
	| (CanonicalChildSessionRefBase & {
			type: 'action';
			invocationId: string;
			taskId?: never;
			parentToolCallId?: never;
			parentAssistantEntryId?: never;
	  });

interface ChildSessionRetainedRecord extends ConversationRecordEnvelope {
	type: 'child_session_retained';
	child: CanonicalChildSessionRef;
}

export interface SubmissionSettledRecord extends ConversationRecordEnvelope {
	type: 'submission_settled';
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
}

/**
 * One durable write to the agent instance's hook state (`usePersistentState`). The
 * record log is the source of truth: the current value of a state name is the
 * `value` of its last `state_write` in stream order, reduced across every
 * conversation in the instance's stream. Writes made by tools land in the same
 * append batch as their batch's `tool_results_committed` record, so a state
 * write shares the durability of the tool batch that made it.
 */
export interface StateWriteRecord extends ConversationRecordEnvelope {
	type: 'state_write';
	name: string;
	value: unknown;
	previousValue?: unknown;
}

/**
 * LEGACY: one completed run of the removed `useEffect` hook. Durable streams
 * written before the lifecycle hooks (`useAgentStart`/`useAgentFinish`)
 * replaced effects carry these records forever; the type stays parseable but
 * nothing consumes it.
 */
interface EffectRunRecord extends ConversationRecordEnvelope {
	type: 'effect_run';
	index: number;
	fingerprint: string;
}

/**
 * One completed `useAgentStart` run. Identity is the declaration index (call
 * order — hooks carry no durable name); the submission in the envelope is the
 * adoption key: a callback runs once per submission, and a re-attempt of the
 * same submission adopts the record instead of re-running. Appended in the
 * same batch as the run's buffered state writes — one durability point per
 * callback.
 */
interface AgentStartRunRecord extends ConversationRecordEnvelope {
	type: 'agent_start_run';
	index: number;
}

/**
 * One continued `useAgentFinish` cycle: the would-stop evaluation appended at
 * least one signal, so the response continues with another turn. Written only
 * for continued cycles (a cycle with no appends settles the response and
 * needs no record), batch-atomic with the cycle's signal records. The count
 * of these records per submission is the durable continuation counter behind
 * the runaway ceiling, and survives re-attempts.
 */
interface AgentFinishCycleRecord extends ConversationRecordEnvelope {
	type: 'agent_finish_cycle';
	cycle: number;
}

/**
 * One write to a named, client-facing data part (`useDataWriter`). Scoped to
 * the submission in the envelope: the part renders on the submission's
 * response message, anchored after the assistant step that had completed when
 * the write was made. The name is the part's identity within the response —
 * a later write to the same name updates the part in place.
 */
interface MessageDataWriteRecord extends ConversationRecordEnvelope {
	type: 'message_data_write';
	name: string;
	data: unknown;
}

/**
 * Custom response metadata produced at a lifecycle point after the response
 * started (`useResponseFinish` hooks). Scoped to the submission in the
 * envelope; deep-merged with the response's earlier metadata in stream order.
 */
interface MessageMetadataRecord extends ConversationRecordEnvelope {
	type: 'message_metadata';
	metadata: Record<string, unknown>;
}

/**
 * One completed step of a `durable: true` tool call (`step.do`). The memo a
 * recovery re-execution replays instead of running the step again: keyed by
 * the deterministic record id derived from `(toolCallId, stepName)`, so the
 * same logical step across execution attempts resolves to one record.
 * Operational — never part of model context; the model sees only the tool
 * call's final result.
 */
interface ToolStepSettledRecord extends ConversationRecordEnvelope {
	type: 'tool_step_settled';
	toolCallId: string;
	toolName: string;
	stepName: string;
	value: unknown;
}

/** The deterministic memo id one durable step settles under. */
export function toolStepRecordId(toolCallId: string, stepName: string): string {
	return `record_tool_step_${encodeCanonicalId(toolCallId)}_${encodeCanonicalId(stepName)}`;
}

// Twin: private copies in conversation-reducer.ts and session.ts — keep in sync.
function encodeCanonicalId(id: string): string {
	const bytes = new TextEncoder().encode(id);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The declared resource sets (tools, skills, subagents) as last narrated to
 * the model. Written batch-atomically with the `resources` signal records
 * that announced a delta, so a rehydrated render re-diffs against exactly
 * what the model was told (crash between = neither, and the diff re-emits).
 * `baseline: true` additionally resets the frozen presentation baseline —
 * the snapshot the system prompt's skill catalog and the task tool's roster
 * compose from — written at first contact and at each compaction
 * rebaseline.
 */
interface ResourceSnapshotRecord extends ConversationRecordEnvelope {
	type: 'resource_snapshot';
	baseline: boolean;
	snapshot: ResourceSnapshot;
}

export type ConversationRecord =
	| ConversationCreatedRecord
	| UserMessageRecord
	| SignalRecord
	| AssistantMessageStartedRecord
	| AssistantTextStartedRecord
	| AssistantTextDeltaRecord
	| AssistantTextCompletedRecord
	| AssistantReasoningStartedRecord
	| AssistantReasoningDeltaRecord
	| AssistantReasoningCompletedRecord
	| AssistantToolCallRecord
	| AssistantMessageCompletedRecord
	| ToolOutcomeRecord
	| ToolResultsCommittedRecord
	| CompactionRecord
	| ChildSessionRetainedRecord
	| SubmissionSettledRecord
	| StateWriteRecord
	| EffectRunRecord
	| AgentStartRunRecord
	| AgentFinishCycleRecord
	| MessageDataWriteRecord
	| MessageMetadataRecord
	| ToolStepSettledRecord
	| ResourceSnapshotRecord;

export function generateConversationRecordId(): string {
	return generateRecordId();
}

export function generateConversationEntryId(): string {
	return generateEntryId();
}
