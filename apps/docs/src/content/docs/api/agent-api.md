---
title: Agent API
description: Reference for defining agents, composing behavior with Flue Hooks, and running agent operations with @flue/runtime.
lastReviewedAt: 2026-07-07
---

The agent API is exported from `@flue/runtime`.

```ts
import {
  AgentInstanceExistsError,
  AgentInstanceNotFoundError,
  FlueError,
  ResultUnavailableError,
  ToolInputValidationError,
  ToolLegacyDefinitionError,
  ToolOutputSerializationError,
  ToolOutputValidationError,
  bash,
  connectMcpServer,
  defineAgent,
  defineSkill,
  defineTool,
  dispatch,
  getAgentInstance,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useDispatchMessage,
  useInstruction,
  useMessageData,
  useMessageMetadata,
  useSandbox,
  useSkill,
  useState,
  useSubagent,
  useTool,
  type AgentAppendMessage,
  type AgentDispatchRequest,
  type AgentFinishContext,
  type AgentFunction,
  type AgentInstanceInfo,
  type AgentModuleValue,
  type AgentResponseToolCall,
  type AgentSignalAppend,
  type AgentStartContext,
  type BashFactory,
  type CallHandle,
  type CompactionConfig,
  type DefineSkillOptions,
  type DeliveredAttachment,
  type DeliveredMessage,
  type DispatchReceipt,
  type DurabilityConfig,
  type FileStat,
  type FlueFs,
  type FlueHarness,
  type FlueLogger,
  type FlueSession,
  type FlueSessions,
  type FunctionAgentConfig,
  type FunctionAgentDefinition,
  type McpServerConnection,
  type McpServerOptions,
  type MessageMetadataEvent,
  type MessageMetadataPoint,
  type PromptImage,
  type PromptModel,
  type PromptOptions,
  type PromptResponse,
  type PromptResultResponse,
  type PromptUsage,
  type SandboxFactory,
  type ShellOptions,
  type ShellResult,
  type Skill,
  type SkillOptions,
  type SkillReference,
  type StateSetter,
  type SubagentDefinition,
  type TaskOptions,
  type ThinkingLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolInput,
  type ToolInputSchema,
  type ToolOutput,
  type ToolOutputSchema,
  type ToolValidationIssue,
} from '@flue/runtime';
```

## `defineAgent(...)`

```ts
function defineAgent(agent: AgentFunction<AgentProps>, config: FunctionAgentConfig): FunctionAgentDefinition;
```

Defines an addressable agent. An agent is an [agent function](#agentfunction) given a model: it composes the agent's behavior with Flue Hooks — attaching tools, instructions, skills, subagents, and durable state — and returns the agent's instruction string; `config` is the static identity (model, tuning) that never renders.

Default-export the returned value from a module whose first statement is the `'use agent'` directive to make the agent part of the application:

```ts title="src/agents/support.ts"
'use agent';
import { defineAgent, useState, useTool } from '@flue/runtime';

function Support() {
  const [phase, setPhase] = useState('phase', 'gathering');

  useTool({
    name: 'begin_draft',
    description: 'Call once the case facts are verified.',
    run: () => setPhase('drafting'),
  });

  return `Operator-facing support agent. Current phase: ${phase}.`;
}

export default defineAgent(Support, { model: 'anthropic/claude-sonnet-4-6' });
```

The directive gives the agent its durable identity (the file basename) and registers it with the built application — there is no name-based addressing beyond that identity. To expose the agent over HTTP, mount `agent.route()` in `app.ts`; see the [Routing API](/docs/api/routing-api/). A dispatch-only agent needs no mount. `flue run <path>` and raw `defineAgent()` values in unit tests do not require the directive.

The agent function re-renders every turn as durable state changes — it must return synchronously and the tools, state, skills, and subagents it attaches (`useTool()`, `useSkill()`, `useSubagent()`, and other hooks) must stay identical across renders. Async work belongs in tools, lifecycle hooks (`useAgentStart()`, `useAgentFinish()`), or resource factories, never in the agent function body itself.

The runtime passes the top-level agent function an `AgentProps` object — the agent's route data, the way a web framework passes route params to the page component. Zero-argument agent functions stay assignable unchanged. Only the root receives it: custom hooks get whatever arguments their caller passes, and a subagent's agent function gets nothing (a delegate runs in isolation from the parent).

```ts
interface AgentProps {
  /** This agent instance's id — the `:id` segment of the agent's route, or the `--id` passed to `flue run`. */
  id: string;
}
```

```ts
function Assistant({ id }: AgentProps) {
  const thread = useInitialData<SlackThreadRef>();
  useTool(replyInThread(thread!));
  return `Reply in the Slack thread bound to conversation ${id}.`;
}
```

`id` is the opaque address; structured facts such as the thread ref are read
from creation data with [`useInitialData()`](#useinitialdata) rather than
parsed from `id`. Channel packages still expose a `parseInstanceId(id)` escape
hatch for the rare caller that must recover them from the id itself.

#### `FunctionAgentConfig`

| Field           | Type                        | Description                                                                                                                   |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | `string`                    | Model specifier (`'<provider-id>/<model-id>'`). Required.                                                                       |
| `thinkingLevel` | `ThinkingLevel`             | Default reasoning effort. Individual operations may override this value.                                                        |
| `compaction`    | `false \| CompactionConfig` | Automatic conversation-compaction configuration. `false` disables threshold compaction; overflow recovery and explicit `session.compact()` calls still compact when needed. |
| `durability`    | `DurabilityConfig`          | Durability configuration for durable agent submissions. Controls recovery attempt limits and submission timeouts.               |
| `cwd`           | `string`                    | Working directory inside the initialized environment.                                                                           |
| `input`         | Valibot schema              | Schema for the instance's creation data, validated once at instance creation (a mismatch — including absence, unless the schema accepts `undefined` — rejects the creating call). Read the recorded value with [`useInitialData()`](#useinitialdata). |

Everything dynamic — instructions, tools, skills, subagents, sandbox — is composed inside the agent function with Flue Hooks; `FunctionAgentConfig` holds only what's fixed for the agent's whole lifetime.

#### `FunctionAgentDefinition`

The opaque value `defineAgent(Agent, config)` returns:

```ts
interface FunctionAgentDefinition {
  __flueFunctionAgent: true;
  agent: AgentFunction;
  config: FunctionAgentConfig;
  route(): Hono;
}
```

`route()` builds the agent's mountable HTTP sub-app (`POST /:id` prompt, `GET|HEAD /:id` conversation stream, `POST /:id/abort`, and the opt-in attachment route). It is a pure factory with no registration side effects — registration comes from the `'use agent'` scan — and it throws when the definition carries no identity. See the [Routing API](/docs/api/routing-api/) for the full route table and middleware semantics.

#### `DurabilityConfig`

| Field         | Type     | Default   | Description                                                                                                                                                                                                                                                                                              |
| ------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts` | `number` | `10`      | Maximum total attempts before the submission is terminalized as failed. The initial run counts as the first attempt; each interruption that requires a new attempt consumes another.                                                                                                                     |
| `timeoutMs`   | `number` | `3600000` | Maximum wall-clock milliseconds for a single submission. Submissions exceeding this limit are aborted and settled as failed. Set higher for long-running agents (e.g. `21_600_000` for a 6-hour agent). The timeout is checked cooperatively at turn boundaries, not preemptively during provider calls. |

#### `CompactionConfig`

| Field              | Type     | Default                        | Description                                                                                                                     |
| ------------------ | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `reserveTokens`    | `number` | model-aware; capped at `20000` | Token headroom reserved before automatic compaction. Smaller model output limits and small context windows reduce this default. |
| `keepRecentTokens` | `number` | `8000`                          | Recent tokens preserved unsummarized after compaction.                                                                          |
| `model`            | `string` | session model                   | Model specifier override used for compaction summaries.                                                                         |

## Flue Hooks

Flue Hooks are the functions called inside an agent function's body — directly, or inside a custom hook it calls — to attach behavior for the current render: tools, instructions, skills, subagents, durable state, and more. All hooks throw when called outside an active render.

#### `AgentFunction`

```ts
type AgentFunction<TProps = void> = TProps extends void
  ? () => string | undefined | void
  : (props: TProps) => string | undefined | void;
```

A plain synchronous function that composes agent behavior: Flue Hooks in the body attach what it provides, and the returned string is its instruction — the prose that teaches the model who it is and how to use it. Return nothing for a tools-only agent function. Agent functions must return synchronously; async work lives in tools, lifecycle hooks, or resource factories.

### Custom hooks

There is no separate mounting API for composition — write a plain function that calls `useTool()`, `useInstruction()`, or any other hook, and call it from the agent body or from another custom hook:

```ts
function useRetention(active: () => boolean) {
  useTool({
    ...offerCredit,
    run: (ctx) => (active() ? offerCredit.run(ctx) : 'Refused: no churn risk on record.'),
  });
  useInstruction('Only while the customer is weighing cancellation: you may offer retention incentives.');
}

function Support() {
  useRetention(() => sentiment === 'churn-risk');
  return 'Support agent.';
}
```

Hook calls are never conditional and the set of hooks each function calls must be identical across renders. State informs the agent — through arguments, guards, and interpolated text — it does not reshape the agent. A custom hook may take arguments and return values to its caller like any other function, and may call other custom hooks.

### `useTool(...)`

```ts
function useTool(tool: {
  name: string;
  description: string;
  input?: ToolInputSchema;
  output?: ToolOutputSchema;
  harness?: boolean;
  run: ToolDefinition['run'];
}): void;
```

Mounts a model-callable tool for the current render. Accepts a `defineTool(...)` value or an inline definition object (same validation, applied here). Called directly in the agent body or inside a custom hook — either way the tool joins the render's single flat tool set:

```ts
function Retention() {
  useTool(offerCredit);
  return 'You may offer retention incentives.';
}
```

Duplicate active tool names across the whole render fail fast. See [`defineTool(...)`](#definetool) for the full tool contract, including `harness`.

### `useInstruction(...)`

```ts
function useInstruction(text: string): void;
```

Appends raw instruction text for the current render — the deliberately low-level escape hatch. Called in the agent body, text lands after the base instruction, in call order; called inside a custom hook, it lands in that hook's section. No structure, no identity, no change tracking: prefer a custom hook for anything coherent.

```ts
export default function marketing() {
  useInstruction('Write in Acme voice: warm, concise.');
  if (LAUNCH_WEEK) useInstruction('Mention the v2 launch when relevant.');
  return undefined;
}
```

### `useState(...)`

```ts
function useState<T>(name: string, defaultValue: T): [T, StateSetter<T>];
function useState<T = unknown>(name: string): [T | undefined, StateSetter<T>];
```

Durable agent state: an API over the record log of the agent instance. Reads the value as of this render (reduced from the instance's `state_write` records) and returns a setter that persists a new value.

```ts
export default function SupportAgent() {
  const [phase, setPhase] = useState<'gathering' | 'drafting'>('phase', 'gathering');

  useTool({
    name: 'begin_draft',
    description: 'Call once the case facts are verified.',
    run: () => setPhase('drafting'),
  });

  return `Current phase: ${phase}.`;
}
```

Values are JSON: writes are normalized through a JSON round-trip and throw on non-serializable input. There is no unset — a name, once written, always has a value (`defaultValue` fills in before the first write and is never persisted itself). Writing the current value again is a no-op. The setter throws during render — write from tool `run` functions and other runtime callbacks. State is scoped to the agent instance and keyed by `name`; declaring the same name twice in one render throws. Not available in a subagent render (delegates run detached tasks with no state channel).

### `useSkill(...)`

```ts
function useSkill(skill: Skill): void;
```

Mounts a skill in the agent's catalog. Skills are progressive disclosure: every mounted skill costs one always-present catalog line (name + description) in the system prompt, and the model pulls the full instructions on demand with the framework's `activate_skill` tool.

```ts
import triageSkill from '../skills/triage/SKILL.md' with { type: 'skill' };

function ReproducePhase() {
  useSkill(triageSkill);
  return 'Activate the `triage` skill before starting this phase.';
}
```

Accepts a `SkillReference` (a `SKILL.md` import `with { type: 'skill' }`, or [`defineSkill(...)`](#defineskill)) or a bare `{ name, description }` catalog entry for content the model reads from the workspace itself. Duplicate names across the render fail fast. See [Skills](/docs/guide/skills/).

### `useSubagent(...)`

```ts
function useSubagent(subagent: SubagentDefinition): void;
```

Declares a delegate the model can hand focused work to via the framework's `task` tool. `agent` defines the delegate's whole world — it is rendered at delegation time, in its own frame, fresh per task — and the delegate is isolated from the parent: nothing flows in except the shared environment and, unless overridden here, the parent's model and reasoning effort.

```ts
function Reproducer() {
  useSkill(reproduceSkill);
  return 'You reproduce one issue. Write your findings to report.md.';
}

function ReproducePhase() {
  useSubagent({
    name: 'reproducer',
    description: 'Sets up the reproduction for one issue and writes report.md.',
    agent: Reproducer,
  });
  return 'Delegate the reproduction to the `reproducer` subagent.';
}
```

#### `SubagentDefinition`

| Field           | Type            | Description                                                                                             |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `name`          | `string`        | Catalog name the model uses to select this delegate on the `task` tool.                                   |
| `description`   | `string`        | Catalog line — how the model decides when to delegate to this agent.                                      |
| `agent`         | `AgentFunction` | Agent function defining the delegate's whole world.                                                       |
| `model`         | `string`        | Model specifier override. Inherits the parent's model when omitted.                                       |
| `thinkingLevel` | `ThinkingLevel` | Reasoning-effort override. Inherits when omitted.                                                          |

Inside the delegate's render, custom hooks, `useTool()`, `useInstruction()`, `useSkill()`, and nested `useSubagent()` all compose as usual; `useState()` and `useSandbox()` throw (durable state is instance-scoped and delegates share the parent environment). Duplicate delegate names in one render fail fast. Select a declared subagent from a `session.task()` call with `options.agent`; see [`session.task(...)`](#sessiontask).

### `useSandbox(...)`

```ts
function useSandbox(sandbox: SandboxFactory): void;
```

Attaches the environment this agent instance runs in: the sandbox adapter's `createSessionEnv()` builds the filesystem/exec surface at initialization (once per initialized harness), and its `tools()` — when present — replaces the framework's default model-facing tool set. Re-renders never rebuild the environment.

```ts
function IssueTriage() {
  useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }));
  // ...
}
```

Callable from the agent body or a custom hook — but at most once per render (an agent has one environment), and never conditionally. Without it, the runtime's default virtual sandbox applies. Not available in a subagent render (delegates share the parent agent's environment; scope work with the task call's `cwd` instead). See [Sandboxes](/docs/guide/sandboxes/).

### `useDelivery()`

```ts
function useDelivery(): DeliveredMessage;
```

Reads the delivered message that triggered the current run — the same validated [`DeliveredMessage`](#deliveredmessage) a `dispatch()` call or a direct HTTP prompt admitted, verbatim.

```ts
// dispatch(triage, { id: `issue-${n}`, message: { kind: 'signal',
//   type: 'issue.triage', body: '...', attributes: { issue: String(n) } } })
export default function IssueTriage() {
  const delivery = useDelivery();
  const issue = delivery.kind === 'signal' ? Number(delivery.attributes?.issue) : undefined;

  useTool({
    name: 'load_issue',
    description: 'Fetch the GitHub issue named by the dispatch. Call this first.',
    run: async () => loadIssueDigest(issue),
  });
}
```

Constant across every render of one run. In a subagent render, the delivery is the parent's task prompt as a `kind: 'user'` message. Always present — every agent run is triggered by a delivered message.

### `useAgentStart(...)`

```ts
function useAgentStart(run: (ctx: AgentStartContext) => void | Promise<void>): void;
```

Runs a callback when the agent starts work on a delivered message — after the input is durable, before the model's first turn. The intake seam: load what the model should wake up knowing, seed files, write durable state, and announce it by dispatching a signal with [`useDispatchMessage()`](#usedispatchmessage) — the delivery joins this same response, so the model reads it ahead of its first answer.

```ts
export default function IssueTriage() {
  const dispatch = useDispatchMessage();
  const [issue, setIssue] = useState<Issue | null>('issue', null);

  useAgentStart(async ({ harness, log }) => {
    if (issue) return; // durable guard: the intake dispatch fires these hooks itself
    const loaded = await loadIssue(issueNumber);
    await harness.fs.writeFile(`triage/gh-${loaded.number}/issue.md`, digest(loaded));
    setIssue(loaded);
    await dispatch({ kind: 'signal', type: 'intake', body: `Issue #${loaded.number} loaded.` });
  });
}
```

`run` may be async and is awaited; a throw fails the submission before the model runs. It fires on every delivered message — there is no cadence configuration; for work that should happen once in the instance's lifetime, guard with durable state (`if (loaded) return`). That includes messages that [join a live response](#usedispatchmessage): when several deliveries collect into one response, the hooks run once per message, each after its input is durable and before the model reads it. Callbacks are NOT reactive: they evaluate once per delivered message, in declaration order, sequentially. Identity is call order — across deploys, add new hooks after existing ones. At-least-once: an interrupted run re-runs on the re-attempt; a completed run is adopted, never repeated. Not available in a subagent render.

```ts
interface AgentStartContext {
  append: (message: AgentAppendMessage) => void;
  harness: FlueHarness;
  log: FlueLogger;
  signal: AbortSignal;
}
```

`harness` is the invocation-scoped runtime surface (sandbox `shell`/`fs`, child sessions, model calls), materialized lazily on first access. `log` emits progress lines into the conversation stream — the model never sees them. `signal` is the submission's abort signal. `append` writes a signal into this response without registering a delivery (no `useAgentStart` run of its own, so no guard needed) — an annotation like "the digest is saved at `triage/gh-42/issue.md`"; it is legal only during the callback's execution window. Dispatching is the delivery-grade alternative.

### `useAgentFinish(...)`

```ts
function useAgentFinish(run: (ctx: AgentFinishContext) => void | Promise<void>): void;
```

Runs a callback when the agent would otherwise finish responding — the model has no more tool calls and the response is about to settle. The enforcement seam: inspect what the response actually did and, if the work is not done, `append` a signal to send the model back to work within the same response.

```ts
function Assistant() {
  useTool(postMessage(data));

  useAgentFinish(({ response, append }) => {
    const posted = response.toolCalls.some(
      (call) => call.tool === 'post_message' && !call.isError,
    );
    if (posted) return; // nothing appended → the response settles
    append({
      kind: 'signal',
      type: 'reminder',
      body: 'You ended without calling post_message — nothing reached the user. Call it now with your answer.',
    });
  });
}
```

Appending during the callback continues the response with another turn; once that continuation is dealt with, the hook runs again at the next would-stop point. The response settles only when the hooks complete with no appends AND no delivered input is waiting: queued deliveries [join the live response](#usedispatchmessage) before any finish evaluation — the agent is only "finally done" when it has dealt with everything delivered, so several messages collect into several `useAgentStart()` runs and one final `useAgentFinish()`. A dispatch made *from* this callback is a real delivery too: it joins the same response and the hook fires again at the new true end (unlike an append, it gets its own `useAgentStart` run and never counts against the append-cycle ceiling). Continued cycles are durable: a resumed response neither re-runs a completed cycle nor appends twice, and a hook that appends unconditionally fails loudly at a fixed framework ceiling instead of settling as a success. The submission's [durability timeout](#durabilityconfig) remains the total wall-clock backstop — neither continuations nor joins extend it. Runs on delivered submissions only, in declaration order; a throw fails the submission. Not available in a subagent render.

```ts
interface AgentFinishContext {
  response: { toolCalls: readonly AgentResponseToolCall[] };
  append: (message: AgentAppendMessage) => void;
  harness: FlueHarness;
  log: FlueLogger;
  signal: AbortSignal;
}

interface AgentResponseToolCall {
  tool: string;
  isError: boolean;
}

interface AgentAppendMessage {
  kind: 'signal';
  type: string;
  body: string;
  attributes?: Record<string, string>;
  tagName?: string;
}
```

`response.toolCalls` aggregates every tool call the response has made — across all turns, derived from durable records, so a resumed response still sees calls made before an interruption. `append` takes the same signal form `dispatch()` messages use (`kind: 'user'` is rejected — real new input belongs on the dispatcher) and is legal only during the callback's execution window: a captured reference throws after the callback settles. An append is the response steering itself — no `useAgentStart` run, no submission of its own; a dispatch is a real delivery. The rest is the `useAgentStart` context surface.

### `useInitialData()`

```ts
function useInitialData<T = unknown>(): T | undefined;
```

Read the instance's creation data — the `data` a caller sent with this instance's first contact, recorded exactly once at creation and constant for the instance's whole life. This is the third leg of the input model: `useInitialData()` is what the instance is *about*, `useDelivery()` is what *this message* says, and `useState` is what the agent has *learned*.

```ts
const input = v.object({ issue: v.pipe(v.number(), v.integer()) });

function Triage() {
  const data = useInitialData<v.InferOutput<typeof input>>();
  return `Triage GitHub issue #${data!.issue} end-to-end.`;
}

export default defineAgent(Triage, { model: 'anthropic/claude-opus-4-6', input });
```

Creation data rides the instance's first contact: `dispatch(triage, { id, data, message })`, a `data` field beside the direct-HTTP message body, `client.send({ message, data })`, or `flue run --data '<json>'`. Declare an `input:` schema on `defineAgent` to validate it at creation — a mismatch (including absence, unless the schema accepts `undefined`) rejects the creating call, so with a required schema the value is always present here, as the schema-parsed output. Without a schema, whatever the creator sent is recorded and returned untyped.

The value is immutable — `data` on messages to an existing instance is ignored, and evolving facts belong in `useState`. Returns `undefined` when creation carried no data, on bare tooling/test renders (back it with `initialData` in the render-state context), and in subagent renders (a delegate has no creation data of its own; close over a value to share it). The recorded value is part of the instance's durable record stream but is never served to clients; still, it is not a secrets channel — keys and tokens stay in the environment.

### `useDispatchMessage()`

```ts
function useDispatchMessage(): (message: DeliveredMessage) => Promise<DispatchReceipt>;
```

Gets a dispatcher bound to this agent instance — the agent-scoped form of [`dispatch()`](#dispatch), the way a router hook overloads a browser primitive with the router-scoped version. The returned function takes just the message: the instance already exists, so there is no creation `data` and no `uid` condition to pass.

```ts
export default function IssueTriage() {
  const dispatch = useDispatchMessage();

  useTool({
    name: 'run_intake',
    description: 'Load the issue and decide whether triage is warranted.',
    harness: true,
    run: async ({ harness }) => {
      const issue = await loadIssue(harness);
      await dispatch({
        kind: 'signal',
        type: 'intake',
        body: `Issue #${issue.number} loaded; triage warranted.`,
        attributes: { issue: String(issue.number) },
      });
      return 'Intake complete.';
    },
  });
}
```

Same semantics as the global `dispatch()` — same queue, same admission, same delivery — and the same rules apply to direct HTTP prompts to the instance: every transport shares one accepted order and one join behavior. A message to a **busy** instance joins the live response at the next turn boundary: the message is durably admitted, fires its own `useAgentStart` run, and the model reads it on its very next turn — without interrupting the turn in flight. A message to an **idle** instance wakes a new response, and messages that pile up before the first turn collect into it together (several `useAgentStart` runs, one response, one final `useAgentFinish`). Joining never loses a delivery: a message that misses the live response — it settled first, or the process crashed mid-join — simply runs as its own submission from the same durable queue. A joined delivery settles when the response that carried it settles, with the same outcome, under the host response's [durability budget](#durabilityconfig); a joined HTTP prompt still writes its own `submission_settled` record, so an SDK `wait()` resolves exactly as if it had run alone. Both message kinds work: `signal` annotates, `user` reads as a real user message. Each call is a durable delivery with its own receipt — like any external side effect in a re-attempted tool, a re-run dispatches again; design for at-least-once. Throws during render and on bare tooling/test renders with no runtime behind them. Not available in a subagent render (a delegate returns what it produced as its task result instead).

The one thing a dispatch is not: a `useAgentFinish` *continuation*. Inside that callback, `ctx.append` steers a signal into the response without registering new input — no `useAgentStart` run, no submission — and is counted against the framework's continuation ceiling. Everywhere else, dispatching is the way to put something in front of the model.

### `useMessageData(...)`

```ts
function useMessageData<TSchema extends v.GenericSchema>(options: {
  name: string;
  schema: TSchema;
}): (data: v.InferOutput<TSchema>) => void;
function useMessageData(options: { name: string }): (data: unknown) => void;
```

Declares a named, client-facing data part and returns a write-only function that streams it. Output is one-way and non-reactive: the model never sees data parts, writes never re-run the agent. Each write is appended durably and streamed to clients immediately, so a part can show live progress mid-tool-run.

```ts
function useCaseContext() {
  const writeCaseCardData = useMessageData({
    name: 'caseCard',
    schema: v.object({ caseId: v.string(), status: v.picklist(['loading', 'loaded']) }),
  });
  useTool({
    name: 'load_case',
    description: 'Load the case and stream a live card to the operator.',
    input: v.object({ caseId: v.string() }),
    run: async ({ data }) => {
      writeCaseCardData({ caseId: data.caseId, status: 'loading' });
      const found = await fetchCase(data.caseId);
      writeCaseCardData({ caseId: data.caseId, status: 'loaded' });
      return found.summary;
    },
  });
}
```

Values are JSON; `schema` (when given) validates before each write. Writes are legal only while the agent is responding to a tracked submission. Names are unique per render and part of the render's structural identity — never mount `useMessageData` conditionally. Not available in a subagent render.

### `useMessageMetadata(...)`

```ts
function useMessageMetadata<TPoint extends MessageMetadataPoint>(
  point: TPoint,
  produce: (event: Extract<MessageMetadataEvent, { point: TPoint }>) => Record<string, unknown> | undefined,
): void;
```

Attaches a synchronous metadata producer to the response message. `'start'` runs once per response, before the first model call; `'finish'` runs after the response's last model step completes, with the response's aggregate usage on the event. Whatever the producer returns is deep-merged onto the response message's `metadata`.

```ts
function useTimestamps() {
  useMessageMetadata('start', () => ({ timestamp: new Date().toISOString() }));
  useMessageMetadata('finish', () => ({ finishedAt: Date.now() }));
}

function useUsageStats() {
  useMessageMetadata('finish', (event) => ({ totalTokens: event.usage.totalTokens }));
}
```

Output is non-reactive and model-invisible: producers never re-run the agent and their output never reaches the prompt. Producers are fail-fast — a throw fails the submission. Not available in a subagent render.

## `defineTool(...)`

```ts
function defineTool<
  TInput extends ToolInputSchema | undefined = undefined,
  TOutput extends ToolOutputSchema | undefined = undefined,
  THarness extends boolean = false,
>(options: {
  name: string;
  description: string;
  input?: TInput;
  output?: TOutput;
  harness?: THarness;
  run: ToolDefinition<TInput, TOutput, THarness>['run'];
}): ToolDefinition<TInput, TOutput, THarness>;
```

Validates a custom model-callable tool and returns a frozen definition. Pass the returned value to [`useTool(...)`](#usetool) (or a `tools` array on a session operation). Tool names are checked for collisions with other active tools when a session assembles its tool list.

`input` and `output` are optional Valibot schemas. `input` must be a top-level object schema. Model-supplied input is validated and parsed before `run` receives it; validation failures become tool errors so the model can retry. When present, `output` validates and parses the returned value. Structured output is snapshotted as JSON-compatible data and JSON-stringified for the model. Without an `output` schema, returning `undefined` sends `null` to the model.

#### `ToolDefinition`

| Field         | Type               | Description                                                                                                  |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`           | Tool name. Must be unique across active built-in and custom tools.                                              |
| `description` | `string`           | Tells the model when and how to use this tool.                                                                  |
| `input`       | `ToolInputSchema`  | Optional top-level Valibot object schema.                                                                       |
| `output`      | `ToolOutputSchema` | Optional Valibot schema for typed, validated output.                                                            |
| `harness`     | `boolean`          | Connects the tool to the agent's runtime: `run` receives `harness`, the one interface to the sandbox (`harness.shell()`, `harness.fs`) and to models (`harness.session()`). Tools without it are pure functions of their input. |
| `run`         | `(context) => value \| Promise` | Receives a [`ToolContext`](#toolcontext). Returns JSON-compatible structured data.                                 |

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const lookupPolicy = defineTool({
  name: 'lookup_policy',
  description: 'Read one approved policy by topic.',
  input: v.object({ topic: v.string() }),
  output: v.object({ title: v.string(), body: v.string() }),
  async run({ data, signal }) {
    return readPolicy(data.topic, { signal });
  },
});
```

A `harness: true` tool gets the agent's runtime surface for the duration of the call:

```ts
const runIntake = defineTool({
  name: 'run_intake',
  description: 'Load the issue and decide whether triage is warranted.',
  harness: true,
  async run({ harness }) {
    const session = await harness.session();
    const { text } = await session.prompt('Summarize the loaded issue.');
    return text;
  },
});
```

Harness invocations are scoped to the tool call, count against the delegation-depth cap, and retain any child conversations they open. Harness tools only run inside an agent session — never standalone (`validateAndRunTool` throws for one).

#### `ToolContext`

```ts
type ToolContext<S, H> = {
  readonly signal?: AbortSignal;
  readonly log: FlueLogger;
} & (S extends ToolInputSchema ? { readonly data: v.InferOutput<S> } : {}) &
  (H extends true ? { readonly harness: FlueHarness } : {});
```

Every tool's `run` receives `log` (streamed into the conversation as progress events, never seen by the model) and the tool call's `signal`. `data` — the call's arguments parsed by the `input` schema — is present when the definition declares an `input` schema; `harness` is present when the definition declares `harness: true`.

### Breaking migration

The old `parameters` and `execute` markers now throw when a tool is defined. Rename `parameters` to `input`, rename `execute(args, signal)` to `run({ data, signal })`, and return structured JSON-compatible data directly instead of calling `JSON.stringify(...)`. Add `output` when the returned shape should be typed and validated.

## `defineSkill(...)`

```ts
function defineSkill(options: DefineSkillOptions): SkillReference;
```

Defines a packaged skill and returns a `SkillReference` ready to pass to [`useSkill(...)`](#useskill) or `session.skill(...)`. Use this when a skill's instructions are authored inline in code rather than in a `SKILL.md` file.

```ts
import { defineSkill } from '@flue/runtime';

const triageSkill = defineSkill({
  name: 'triage',
  description: 'Triage a GitHub issue — reproduce, assess severity, and optionally fix.',
  instructions: 'Given the issue number: reproduce it, assess severity, and write a summary.',
});
```

#### `DefineSkillOptions`

| Field           | Type                             | Description                                                                                     |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `name`          | `string`                          | Skill name. Lowercase letters, numbers, and single hyphens only; at most 64 characters.           |
| `description`   | `string`                         | Catalog line shown to the model. At most 1024 characters.                                         |
| `instructions`  | `string`                          | Full instruction body, disclosed to the model when the skill is activated.                        |
| `license`       | `string`                          | Optional license identifier recorded in the packaged `SKILL.md` frontmatter.                      |
| `compatibility` | `string`                          | Optional compatibility note recorded in frontmatter. At most 500 characters.                       |
| `metadata`      | `Record<string, string>`          | Optional string-to-string metadata recorded in frontmatter.                                        |
| `allowedTools`  | `string`                          | Optional allowed-tools restriction recorded in frontmatter.                                        |
| `files`         | `Record<string, string \| Uint8Array>` | Optional supporting files packaged alongside `SKILL.md`, keyed by safe relative path.        |

Throws `SkillDefinitionValidationError` when required fields are missing, too long, or a file path is unsafe (absolute, `SKILL.md` itself, or containing `.`/`..` segments).

## `connectMcpServer(...)`

```ts
function connectMcpServer(name: string, options: McpServerOptions): Promise<McpServerConnection>;
```

Connects to a remote MCP server and returns its listed tools as Flue tool definitions ready to pass directly to `useTool(...)` or in `tools` arrays.

Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are replaced with underscores, and duplicate adapted names are rejected. Do not wrap these tools with `defineTool()`. Close the returned connection when its tools are no longer needed.

#### `McpServerOptions`

| Field                    | Type                         | Default             | Description                                                                      |
| ------------------------ | ---------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `url`                    | `string \| URL`              | —                    | MCP server endpoint.                                                             |
| `transport`              | `'streamable-http' \| 'sse'` | `'streamable-http'` | Remote MCP transport. Use `'sse'` for legacy servers.                             |
| `headers`                | `HeadersInit`                | —                    | Headers merged into MCP transport requests.                                       |
| `requestInit`            | `RequestInit`                | —                    | Additional MCP transport request configuration.                                   |
| `fetch`                  | `typeof fetch`               | —                    | Custom fetch implementation used by the MCP transport.                            |
| `timeoutMs`              | `number`                     | `60000`             | Per-request timeout in milliseconds for MCP requests.                             |
| `resetTimeoutOnProgress` | `boolean`                    | `false`             | Reset the per-request timeout whenever the server sends a progress notification.  |

#### `McpServerConnection`

```ts
interface McpServerConnection {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}
```

| Field     | Description                                         |
| --------- | --------------------------------------------------- |
| `name`    | Server name supplied to `connectMcpServer()`.       |
| `tools`   | MCP tools ready to pass directly in `tools` arrays. |
| `close()` | Close the underlying MCP client connection.         |

## `dispatch(...)`

```ts
function dispatch(agent: AgentModuleValue, request: AgentDispatchRequest): Promise<DispatchReceipt>;

interface AgentDispatchRequest {
  id: string;
  message: DeliveredMessage;
  data?: unknown;
  uid?: string | null;
}

interface DispatchReceipt {
  dispatchId: string;
  acceptedAt: string;
  uid?: string;
}
```

Delivers a message for asynchronous processing by a continuing agent instance. The `agent` argument is a registered agent module value — the default export of a `'use agent'` module — so no HTTP mount is required.

| Field        | Description                                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | Target agent instance id.                                                                                                                                                                               |
| `message`    | The message delivered to the session. Flue snapshots it when accepted.                                                                                                                                  |
| `data`       | Instance-creation data — the seed, consulted only when this send creates the instance: validated against the agent's `input:` schema (when declared) and recorded once. Ignored when the send continues an existing instance. See [Creation data](/docs/guide/building-agents/#creation-data). |
| `uid`        | Send condition — see [Conditional sends](#conditional-sends).                                                                                                                                           |
| `dispatchId` | Generated delivery identifier returned in the receipt.                                                                                                                                                  |
| `acceptedAt` | ISO timestamp assigned when dispatch admission begins.                                                                                                                                                  |
| `uid` (receipt) | The contacted instance's uid — minted when this send created the instance, echoed when it continued one. Absent for instances created before uids shipped.                                          |

`await dispatch(...)` resolves when the current runtime accepts and queues the message. It does not wait for model processing, tool calls, or an agent reply. Dispatched activity belongs to the continuing agent instance and shares one accepted order with direct HTTP prompts to the same instance.

#### Conditional sends

Every send — `dispatch(...)`, a direct HTTP prompt, or the SDK's `client.send(...)` — is a **conditional request** against the target instance, with the instance uid playing the ETag:

| `uid`                     | Meaning                             | Instance exists                                                              | Instance missing                        |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------ |
| omitted                  | Deliver to this address.             | Continues.                                                                    | Creates.                                   |
| omitted, `data` present  | Seed if this creates.                | Continues; `data` ignored.                                                    | Creates; `data` validated and recorded.    |
| `'<value>'`              | Continue only that incarnation.      | Continues if the uid matches, else `AgentInstanceNotFoundError` (`404`).      | `AgentInstanceNotFoundError` (`404`).      |
| `null`                   | Create only when fresh.              | `AgentInstanceExistsError` (`409`); its `.uid` and `details` name the existing uid. | Creates.                                   |

`uid: '<value>'` combined with `data` throws `InvalidRequestError` — the condition forbids creation, so the seed could never apply. Every condition is checked synchronously at admission: a failed condition creates nothing durable and runs no model turn.

`AgentInstanceExistsError`'s `.uid` (and its error `details`) name the existing instance's uid on purpose: the uid is accident prevention for the caller, not a security mechanism — access control belongs in the [`route`](/docs/api/routing-api/#the-modules-named-exports) handler — so a caller can recover from a `409` and continue the existing instance without a separate lookup.

Both error classes are importable from `@flue/runtime`; see the [Errors Reference](/docs/api/errors-reference/#public-transport-errors) for their `type`/status pairing. The direct-HTTP wire carries the same condition as a reserved `uid` sibling on the message body, and the `202` admission body as a `uid` field alongside `streamUrl`/`offset`/`submissionId`; see [Routing API](/docs/api/routing-api/#wire-behavior).

#### `DeliveredMessage`

```ts
type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };
```

The single unified message shape delivered into an agent's session, whether it arrives through `dispatch(...)`, a direct HTTP prompt, or [`useDelivery()`](#usedelivery).

`kind: 'user'` is a real, user-attributed chat turn. It produces a canonical `user_message` record and projects into the model conversation like any other user message. Use it when one person is talking directly to the assistant — a direct 1:1 chat surface such as an SDK-driven chat UI — optionally carrying image attachments.

`kind: 'signal'` is a structured, non-conversational event — a webhook payload, a scheduled trigger, an internal system notification. It produces a canonical `signal` record and renders into the model conversation as an XML-tagged block rather than a chat turn. This is the right shape for more advanced scenarios, including most channels: a Slack thread or GitHub issue is a multi-user conversation the agent participates in as one member, and signals model each participant's activity — with sender identity in `attributes` — where a `user` message would confuse other participants with the assistant's own user.

| Field         | Applies to | Description                                                                                            |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `body`        | both       | The message content. Always a string today; JSON-stringify structured payloads yourself.               |
| `attachments` | `user`     | Images attached to the message. See `DeliveredAttachment`.                                             |
| `type`        | `signal`   | Caller-defined event/signal type, e.g. `'slack.message'`.                                              |
| `attributes`  | `signal`   | Flat, scalar-valued metadata for correlation — analogous to HTTP headers. Rendered alongside the body. |
| `tagName`     | `signal`   | Overrides the XML tag name used when rendering the signal into the model prompt. Defaults to `signal`. |

#### `DeliveredAttachment`

```ts
type DeliveredAttachment = {
  type: 'image';
  data: string;
  mimeType: string;
  filename?: string;
};
```

One image attachment on a `kind: 'user'` `DeliveredMessage`. Today the only supported attachment is an image; the selected model must support image input.

Delivery durability depends on the generated target. Node uses a process-lifetime in-memory queue by default; with a durable `db.ts` adapter, dispatches survive restarts and are reconciled on the replacement process. Cloudflare durably admits delivery to the target agent Durable Object, orders it with direct prompts, and reconciles interruptions conservatively. Both targets retry only when replay safety is provable; external effects still require application-level idempotency. See [Durable Agents](/docs/concepts/durable-execution/) for recovery details, and [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/) and [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for target-specific setup.

## `getAgentInstance(...)`

```ts
function getAgentInstance(agent: AgentModuleValue, id: string): Promise<AgentInstanceInfo | null>;
```

Looks up an agent instance by id: `null` when no instance exists, else its `AgentInstanceInfo`.

```ts
interface AgentInstanceInfo {
  /** The instance id — the address the caller asked about. */
  id: string;
  /**
   * The incarnation's uid, usable as a `uid` send condition. Absent for
   * instances created before uids shipped.
   */
  uid?: string;
}
```

Rarely needed: a receipt from a send you originated already carries the uid (`DispatchReceipt.uid`, the direct-HTTP `202` body's `uid`, or the SDK's `AgentSendResult.uid`), and a failed `uid: null` condition hands the existing uid back in `AgentInstanceExistsError`. Reach for `getAgentInstance()` when code that did not originate the instance's creation wants to condition a send against it without attempting one first.

```ts
const info = await getAgentInstance(triage, 'issue-17307'); // { id: 'issue-17307', uid: 'inst_01KW…' } | null
if (info) await dispatch(triage, { id: info.id, uid: info.uid, message });
```

## Agent

A `FunctionAgentDefinition` is the opaque value returned by `defineAgent(Agent, config)`. Default-export it from a `'use agent'` module to register it with the application; mount `agent.route()` in `app.ts` to make its conversations addressable over HTTP.

## Harness

A harness is an initialized agent environment supplied by the active runner. `harness: true` tools receive it as `context.harness`; application code does not name or initialize harnesses itself.

#### `FlueHarness`

Initialized agent environment for sessions and workspace operations.

```ts
interface FlueHarness {
  readonly name: string;
  session(name?: string): Promise<FlueSession>;
  readonly sessions: FlueSessions;
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
  readonly fs: FlueFs;
}
```

### `harness.session(...)`

```ts
session(name?: string): Promise<FlueSession>;
```

Gets or creates a session in this harness. Defaults to the `'default'` session. Names beginning with `task:` are reserved for framework-owned detached task sessions.

### `harness.sessions.get(...)`

```ts
get(name?: string): Promise<FlueSession>;
```

Loads an existing session. Defaults to `'default'`. Rejects with `SessionNotFoundError` if it does not exist.

### `harness.sessions.create(...)`

```ts
create(name?: string): Promise<FlueSession>;
```

Creates a new session. Defaults to `'default'`. Rejects with `SessionAlreadyExistsError` if it already exists.

### `harness.shell(...)`

```ts
shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
```

Runs a shell command in the harness sandbox without recording it in a conversation.

### `harness.fs`

- **Type:** `FlueFs`

Reads and writes files in the harness sandbox without recording them in a conversation.

## Session

A session is named conversation state inside a harness. A session runs one active `prompt`, `skill`, `task`, `shell`, or `compact` operation at a time. Use separate named sessions for parallel conversation branches.

#### `FlueSession`

Named conversation state inside a harness.

```ts
interface FlueSession {
  readonly name: string;
  prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
  skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;
  task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
  readonly fs: FlueFs;
  compact(): Promise<void>;
}
```

The `prompt()`, `skill()`, and `task()` signatures above omit structured-result overloads. Pass a Valibot schema as `options.result` to resolve with validated `response.data`.

### `session.prompt(...)`

```ts
prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
```

Runs a model operation with a text instruction.

#### `PromptOptions`

| Field           | Type               | Description                                                           |
| --------------- | ------------------ | ----------------------------------------------------------------------- |
| `result`        | Valibot schema     | Require validated structured data and resolve with `response.data`.   |
| `tools`         | `ToolDefinition[]` | Additional custom model-callable tools for this operation.            |
| `model`         | `string`           | Model specifier override for this operation.                          |
| `thinkingLevel` | `ThinkingLevel`    | Reasoning-effort override for this operation.                         |
| `signal`        | `AbortSignal`      | Cancel this operation.                                                 |
| `images`        | `PromptImage[]`    | Images attached to the user message. Requires a vision-capable model. |

#### `PromptImage`

```ts
type PromptImage = {
  type: 'image';
  data: string;
  mimeType: string;
};
```

The selected model must support image input.

#### `PromptResponse`

```ts
interface PromptResponse {
  text: string;
  usage: PromptUsage;
  model: PromptModel;
}
```

#### `PromptUsage`

Aggregated token and cost usage for model work performed by one operation. Tool use, result retries, and automatic compaction may cause one operation to include multiple model turns.

#### `PromptModel`

```ts
interface PromptModel {
  provider: string;
  id: string;
}
```

Model selected for the operation's primary turn.

#### `PromptResultResponse`

```ts
interface PromptResultResponse<T> {
  data: T;
  usage: PromptUsage;
  model: PromptModel;
}
```

A structured-result operation throws `ResultUnavailableError` when the agent cannot produce validated data.

### `session.skill(...)`

```ts
skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;
```

Runs a registered skill. Pass `options.result` to require validated structured data instead of freeform text.

#### `SkillReference`

```ts
interface SkillReference {
  readonly __flueSkillReference: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
```

Opaque skill reference accepted by `useSkill()` and `session.skill()`. Produced by importing a `SKILL.md` value or by [`defineSkill(...)`](#defineskill).

#### `Skill`

```ts
type Skill =
  | SkillReference
  | {
      name: string;
      description: string;
    };
```

Skill metadata mountable with `useSkill()`. Imported `SkillReference` values bundle application-owned skill content. Inline metadata adds only a named catalog entry; it does not package or inject an instruction body. See [Skills](/docs/guide/skills/).

#### `SkillOptions`

| Field           | Type                      | Description                                                                   |
| --------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `args`          | `Record<string, unknown>` | Arguments included with the skill instruction.                                |
| `result`        | Valibot schema            | Require validated structured data and resolve with `response.data`.           |
| `tools`         | `ToolDefinition[]`        | Additional custom model-callable tools for this operation.                    |
| `model`         | `string`                  | Model specifier override for this operation.                                  |
| `thinkingLevel` | `ThinkingLevel`           | Reasoning-effort override for this operation.                                  |
| `signal`        | `AbortSignal`             | Cancel this operation.                                                        |
| `images`        | `PromptImage[]`           | Images attached to the skill's user message. Requires a vision-capable model. |

### `session.task(...)`

```ts
task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;
```

Delegates work to a detached child session. Pass `options.agent` to select a subagent by the name declared with [`useSubagent(...)`](#usesubagent) and `options.result` to require validated data.

#### `TaskOptions`

| Field           | Type               | Description                                                                          |
| --------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `agent`         | `string`           | Name of the subagent (declared with `useSubagent()`) to delegate to for this call.      |
| `result`        | Valibot schema     | Require validated structured data and resolve with `response.data`.                  |
| `tools`         | `ToolDefinition[]` | Additional custom model-callable tools for this operation.                           |
| `model`         | `string`           | Model specifier override for this operation.                                         |
| `thinkingLevel` | `ThinkingLevel`    | Reasoning-effort override for this operation.                                         |
| `cwd`           | `string`           | Working directory for the detached task session. Defaults to the parent session cwd. |
| `signal`        | `AbortSignal`      | Cancel this task.                                                                     |
| `images`        | `PromptImage[]`    | Images attached to the task's initial user message. Requires a vision-capable model. |

Rejects with `SubagentNotDeclaredError` when `options.agent` names a subagent that was not declared with `useSubagent()` in the current render.

### `session.shell(...)`

```ts
shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
```

Runs a shell command and records its command exchange in conversation state.

#### `ShellOptions`

| Field       | Type                     | Description                                                                             |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `env`       | `Record<string, string>` | Environment variables supplied to the command.                                          |
| `cwd`       | `string`                 | Working directory supplied to the command.                                              |
| `timeoutMs` | `number`                 | Wall-clock deadline in milliseconds, forwarded to the sandbox adapter's native timeout. |
| `signal`    | `AbortSignal`            | Cancel this operation.                                                                  |

#### `ShellResult`

```ts
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

### `session.fs`

- **Type:** `FlueFs`

Reads and writes files in the session sandbox without recording them in the conversation transcript.

### `session.compact()`

```ts
compact(): Promise<void>;
```

Triggers conversation compaction immediately. Resolves without work when there is nothing to compact. Rejects when summarization fails or is aborted. Rejects with `SessionBusyError` if another operation is active on the session.

#### `CallHandle<T>`

```ts
interface CallHandle<T> extends Promise<T> {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
```

`prompt()`, `skill()`, `task()`, and `shell()` return awaitable call handles. Retain the handle when application code needs to cancel in-flight work. Aborting rejects the awaited operation with an `AbortError` (`DOMException`). Pass `options.signal` to merge an external abort signal with the handle's signal.

Other session failures reject with typed `FlueError` subclasses such as `SessionBusyError`, `SkillNotRegisteredError`, and `SubagentNotDeclaredError`, all importable from `@flue/runtime`. See the [Errors Reference](/docs/api/errors-reference/) for the full vocabulary.

#### `FlueFs`

```ts
interface FlueFs {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
```

Paths may be absolute or relative. Relative paths use the configured `cwd`, or the sandbox adapter's default when `cwd` is omitted; use absolute paths for portability across sandbox adapters. These operations are out-of-band and do not appear in conversation history.

`writeFile()` creates missing parent directories automatically, in every sandbox mode — no prior `mkdir()` is needed before writing to a nested path.

#### `FileStat`

```ts
interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}
```

`isSymbolicLink`, `size`, and `mtime` are omitted when the sandbox adapter's provider does not expose them.
