---
title: Migrating from 1.0 Beta
description: Upgrade an application from Flue 1.0.0-beta.x to the current release — build, routing, agents, tools, workflows, SDK, and deployment.
lastReviewedAt: 2026-07-11
---

This guide migrates an application from **Flue `1.0.0-beta.x`** to the current release line (published as `0.4.0-nightly.*`, the future `2.0.0`). It is written for working beta applications: every section pairs the beta API with its replacement, and the [checklist](#migration-checklist) at the end orders the work.

The release is a redesign, not an increment. Five conceptual changes drive almost every mechanical one:

| Beta concept                                                  | Replaced by                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `flue build` / `flue dev` CLI commands                         | [Vite](/docs/guide/vite-plugin/) with the `flue()` plugin — `vite dev` and `vite build` are the only commands.  |
| Auto-mounted `flue()` router, discovery by directory           | [Explicit routing](/docs/guide/routing/) in `app.ts`; the [`'use agent'`](/docs/guide/use-agent/) scan registers agents. |
| `defineAgent(async initializer => config)` with a config bag   | The agent **is** the function: an exported capitalized agent function composing behavior with [Flue Hooks](/docs/api/agent-api/#flue-hooks); `defineAgent` is gone entirely. |
| Workflows (`defineWorkflow`, `invoke()`, runs, run events)     | Removed. Awaited [`init()` handles](/docs/guide/scripts/), [durable tools](/docs/guide/tools/#durable-tools), or your own orchestrator. |
| Deployment-wide SDK client (`client.agents.*`, `client.workflows.*`) | A [conversation-scoped client](/docs/sdk/client/): one client per conversation URL.                             |

## Before you start: persisted state resets

The current release stores Flue schema **version 6**; the beta stored version 5. Pre-1.0 persisted schemas are **reset-only** — the runtime rejects a v5 database before any application code runs, and there is no in-place migration.

- If beta conversation state is disposable, plan a drained deployment: retire the old agents (on Cloudflare, with `deleted_classes` migrations) and create fresh ones. Application data that shares an agent's storage (a `base`/`wrap` DO extension, values written beside Flue's tables) is deleted with it — export anything you need first.
- If beta state must survive, export it through the beta application *before* upgrading, and re-seed after.

Everything else in this guide can be staged; this one is a hard boundary.

## Build and dev commands

`flue build` and `flue dev` are removed. A Flue application is now a Vite project: add `@flue/vite` (and on Cloudflare, `@cloudflare/vite-plugin`) and author `vite.config.ts` — `flue()` must come **before** `cloudflare()`:

```ts title="vite.config.ts"
import { cloudflare } from '@cloudflare/vite-plugin'; // Cloudflare target only
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare()],
});
```

| Beta                                | Now                                                       |
| ----------------------------------- | --------------------------------------------------------- |
| `flue dev --target cloudflare`      | `vite dev`                                                |
| `flue build --target cloudflare`    | `vite build`                                              |
| `flue build` (Node)                 | `vite build` → `node dist/server.mjs`                     |
| target selection via `--target`     | auto-detected from the plugin array, or `target` in `flue.config.ts` |

On Cloudflare the plugin generates two inputs the Cloudflare plugin consumes — `.flue-vite/_entry.ts` (the Worker entry) and `.flue-vite.wrangler.jsonc` (your authored `wrangler.jsonc` merged with generated bindings). Add both to `.gitignore`. Build output, preview, and deploy belong to `@cloudflare/vite-plugin`; deploy against the config it emits into `dist/`.

`flue run` remains for one-shot local execution, with new flags: `flue run <path> --message "..." [--name <agent>] [--id <id>] [--initial-data '<json>'] [--max-attempts <n>] [--timeout <ms>]`. The beta's workflow-oriented `--input` is gone with workflows.

## Routing: the auto-router is gone

The beta's `flue()` router (`app.route('/', flue())` from `@flue/runtime/routing`, or the generated default app) no longer exists. `app.ts` is now **required**, and it mounts every route explicitly:

```ts title="src/app.ts (beta)"
import { flue } from '@flue/runtime/routing';
const app = new Hono();
app.use('/agents/*', requireUser);
app.route('/', flue()); // agents, workflows, channels — discovered and mounted
export default app;
```

```ts title="src/app.ts (now)"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Triage } from './agents/triage.ts';

const app = new Hono();
app.use('/agents/*', requireUser);
app.route('/agents/triage', createAgentRouter(Triage)); // explicit, per agent
export default app;
```

- `createAgentRouter(fn)` is a pure router factory serving `POST /:id`, `GET|HEAD /:id`, `POST /:id/abort`, and `GET /:id/attachments/:attachmentId` relative to the mount. URL shapes are yours.
- **Registration comes from the [`'use agent'` scan](/docs/guide/use-agent/), not the mount.** A dispatch-only agent stays unmounted and still works; mounting registers nothing.
- Workflow routes (`POST /workflows/<name>`, `/runs/<runId>`) are gone with workflows, as are the `runs` module export and `WorkflowRouteHandler`/`WorkflowRunsHandler` types.

## Defining an agent

The beta's async initializer returning a config bag becomes a **synchronous agent function** composing behavior with hooks, in a module marked by the `'use agent'` directive:

```ts title="src/agents/support.ts (beta)"
import { defineAgent } from '@flue/runtime';

export default defineAgent(async ({ id, env }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: `Help with ticket ${id}.`,
  tools: [lookupOrder],
  skills: [refundsSkill],
  subagents: [reviewerProfile],
  sandbox: bash(myFactory),
  cwd: '/workspace',
  durability: { maxAttempts: 5 },
}));
```

```ts title="src/agents/support.ts (now)"
'use agent';
import { type AgentProps, useModel, useSandbox, useSkill, useSubagent, useTool } from '@flue/runtime';

export function Support({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(myFactory, { cwd: '/workspace' });
  useTool(lookupOrder);
  useSkill(refundsSkill);
  useSubagent({ name: 'reviewer', description: '…', agent: Reviewer });
  return `Help with ticket ${id}.`;
}
```

The agent **is** the exported function — there is no wrapper and no config bag. Durability moved out of the module entirely: it is binding policy, declared where the agent is run (`createAgentRouter(Support, { durability: { maxAttempts: 5 } })` at the mount, a `{ agent, durability }` entry in `start()`, or `flue run --max-attempts`).

Field-by-field:

| Beta (`AgentRuntimeConfig`)      | Now                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `model`                          | [`useModel(model, options?)`](/docs/api/agent-api/#usemodel) — **required**, exactly once per render, root render only.               |
| `instructions`                   | The agent function's return string; [`useInstruction()`](/docs/api/agent-api/#useinstruction) appends more.                          |
| `tools`                          | [`useTool()`](/docs/api/agent-api/#usetool) per tool.                                                                                |
| `skills`                         | [`useSkill()`](/docs/api/agent-api/#useskill) per skill.                                                                             |
| `subagents` (profiles)           | [`useSubagent({ name, description, agent, model?, thinkingLevel? })`](/docs/api/agent-api/#usesubagent) — the delegate is an agent function, not a profile. |
| `thinkingLevel`, `compaction`    | `useModel(model, { thinkingLevel, compaction })`.                                                                                    |
| `sandbox`, `cwd`                 | [`useSandbox(factory, { cwd })`](/docs/api/agent-api/#usesandbox) — at most once per render; presence may be conditional.             |
| `durability`                     | A binding option — `createAgentRouter(fn, { durability })`, a `start()` entry, or `flue run` flags. The runner decides; it lives outside the function, so it stays readable when a render crashes. |
| `profile`                        | Removed — compose with custom hooks (plain functions calling hooks) instead.                                                          |
| `actions`                        | Removed with Actions. Express reusable operations as tools.                                                                           |
| `description` (config)           | Deleted — no replacement.                                                                                                             |
| initializer `ctx.id`             | `AgentProps` — the root agent function receives `{ id }`.                                                                             |
| initializer `ctx.env`            | Platform imports (`import { env } from 'cloudflare:workers'`) or `process.env`; the initializer context is gone.                      |
| `async` initializer              | The agent function **must be synchronous** — async work moves into tools, lifecycle hooks (`useAgentStart`/`useAgentFinish`), or resource factories such as the sandbox factory's `createSessionEnv()`. |

Rules that have no beta equivalent, because renders repeat:

- The agent function re-renders before every model turn. **Resources** (`useTool`, `useSkill`, `useSubagent`) may be conditional — changes are announced to the model as `resources` signals — and so may `useSandbox`: a presence flip swaps the environment at the next turn boundary, announced as an `environment` signal. **Identity hooks** (`usePersistentState`, `useDataWriter`, lifecycle and response hooks) must be declared identically on every render.
- `defineAgentProfile` is removed. A subagent is `{ name, description, agent }` where `agent` is a plain agent function rendered per delegation; `model`/`thinkingLevel` inherit from the parent unless overridden. Inside a delegate render, `usePersistentState`, `useSandbox`, `useModel`, `useDataWriter`, `useDispatchMessage`, and the lifecycle/response hooks throw.
- Identity is the exported function's name, or an `fn.agentName = '...'` **string-literal** static override; PascalCase and lower-kebab-case are both valid, and identities are unique per application. Renaming an agent function without an `agentName` pin is a storage-identity change; renaming the file changes nothing.

New capabilities you will likely reach for while migrating — durable per-instance state ([`usePersistentState`](/docs/api/agent-api/#usepersistentstate)), creation data ([`useInitialData`](/docs/api/agent-api/#useinitialdata) + the `initialData` schema static), the delivered-message cursor ([`useDelivery`](/docs/api/agent-api/#usedelivery)), self-dispatch ([`useDispatchMessage`](/docs/api/agent-api/#usedispatchmessage)), client-facing data parts ([`useDataWriter`](/docs/api/agent-api/#usedatawriter)), lifecycle seams ([`useAgentStart`](/docs/api/agent-api/#useagentstart)/[`useAgentFinish`](/docs/api/agent-api/#useagentfinish)), and response metadata ([`useResponseStart`/`useResponseFinish`](/docs/api/agent-api/#useresponsestart--useresponsefinish)).

## Tools

The tool contract keeps `defineTool({ name, description, input, output, run })`, with one rename and two new flags:

- **`run({ input })` → `run({ data })`.** The parsed-arguments field on `ToolContext` is now `data`; `signal` is unchanged and `log` (a `FlueLogger`) is always present. The pre-beta `parameters`/`execute` markers still throw.
- **`harness: true`** replaces session plumbing: the tool receives `harness` (`harness.prompt()` for model calls in the tool's own scratch conversation, `harness.sandbox` for the environment). `harness.session()` and `FlueSession`/`FlueSessions` are gone — `prompt()` lives directly on the harness, and `session.task()` delegation is now the model-driven `task` tool over `useSubagent` declarations.
- **`durable: true`** opts a tool into checkpointed execution: `run` receives `step`, side effects go through `step.do(name, fn)`, and recovery replays recorded step values instead of re-running them. This is the in-agent replacement for small workflow orchestration.

`harness.fs` is also gone: the harness exposes [`harness.sandbox`](/docs/api/agent-api/#harnesssandbox), a `SessionEnv` carrying `exec`, the file verbs, `cwd`, and `resolvePath`. Adapters may not support every verb and may expose native accessors (for example Cloudflare Shell's `shellWorkspace(harness.sandbox)`).

## Skills and markdown imports

Import-attribute syntax (`with { type: 'skill' }` and friends) is **removed**; the specifier decides:

- An import that resolves to a **`SKILL.md`** packages the whole skill directory and returns a `SkillReference` for `useSkill()`.
- Any **other `.md`** import is plain markdown text (a string), inlined at build time. To make one a skill, pass it through `defineSkill({ name, description, instructions })` — `defineSkill` writes frontmatter itself, so the file stays plain markdown. (A `?skill` import query was never released; do not use one.)
- Vite-native queries (`?raw`, `?url`) keep their usual meanings.

## Workflows are removed

`defineWorkflow`, `invoke()`, `listRuns()`, `getRun()`, workflow HTTP routes, `client.workflows.*`, `useFlueWorkflow()`, the `src/workflows/` discovery directory, the Workflow API, and workflow run events are all gone. There is no framework job abstraction to migrate *to* — pick the smallest replacement that preserves your semantics:

1. **A single model operation with a returned value** (the common beta workflow): an awaited handle. `init(agent, { id })` addresses an instance; `await handle.dispatch(message)` delivers through the normal queue, waits for settlement, and resolves with the reply (`text`, `data`, `metadata`, `submissionId`). A failed or aborted run rejects with `AgentRunError`.

   ```ts
   import { init } from '@flue/runtime';
   import { Summarizer } from './agents/summarizer.ts';

   const reply = await init(Summarizer, { id: `summary-${caseId}` }).dispatch(text);
   return reply.data.summary;
   ```

2. **Checkpointed side-effect sequences inside an agent**: a `durable: true` tool with `step.do(...)`.

3. **Multi-step orchestration with its own durability, retries, and inspection** (what workflow runs gave you): an application-owned orchestrator. On Cloudflare, a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) whose steps call `init(...).dispatch(...)` — one agent send per step, the recorded step result standing in for the reply on re-execution — is the documented pattern; see [Scripts › On Cloudflare](/docs/guide/scripts/#on-cloudflare). Run inspection (`getRun()`) has no framework replacement: reconcile from your orchestrator's own state and from `submission_settled` observability events.

In standalone Node scripts (cron jobs, CI, tests), boot the runtime first with `start()` from `@flue/runtime/node`, passing agent functions (or `{ agent, name?, durability? }` entries); then `init()`/`dispatch()` work as they do in a server. See [Scripts](/docs/guide/scripts/).

## Dispatch and conditional sends

`dispatch(agent, request)` keeps its shape with two changes:

- The creation seed field is **`initialData`** (validated by the agent's `initialData` schema static at creation, read with `useInitialData()`; ignored on sends that continue an existing instance). If your beta app abused the first message body to carry setup facts, move them here.
- **`uid` send conditions**: omit to continue-or-create; pass a previous receipt's `uid` to continue only that incarnation (`AgentInstanceNotFoundError`/404 otherwise); pass `null` to create only (`AgentInstanceExistsError`/409 otherwise, carrying the existing uid). Conditions are checked at admission and create nothing on failure. `getAgentInstance(agent, id)` looks up `{ id, uid }` without sending.

A bare string is user-message shorthand everywhere a message is accepted. `dispatch()` remains fire-and-forget at durable admission; the awaited form is the `init()` handle above.

## Observability

Run-scoped events are gone with workflows; agent activity is observed directly. Register `observe(...)` as before, and migrate event handling:

| Beta                           | Now                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `run_start` / `run_end`        | `agent_start` / `agent_end`.                                                                                                |
| `runId` correlation            | `instanceId` (the agent instance), `submissionId` (one delivered submission), `dispatchId` (one dispatch delivery).         |
| polling `getRun()` for outcome | `submission_settled` events (terminal outcome of recovered submissions) plus your own orchestrator's state.                 |
| failed run inspection          | `operation` events with `isError`, carrying the failing operation kind.                                                     |

See the [Events Reference](/docs/api/events-reference/) for the full envelope (`v: 3`) and payload contract.

## SDK

The beta's deployment-wide client is now **conversation-scoped**: construct one client per conversation URL — the agent's mount URL plus the conversation id. There is no `baseUrl`, no agent-name addressing, and no `client.agents`/`client.workflows` namespaces.

```ts
// Beta
const client = createFlueClient({ baseUrl: '/api' });
await client.agents.send('support-assistant', ticketId, { message });
await client.agents.abort('support-assistant', ticketId);

// Now
const conversation = createFlueClient({ url: `/api/agents/support-assistant/${ticketId}` });
await conversation.send({ message, initialData });
await conversation.abort();
```

The conversation client exposes `send` (202 admission; returns `uid` and `submissionId`), `wait(admission)`, `observe()`, `history()`, `abort()`, and `attachmentUrl()`. `abort()` aborts the **conversation's** in-flight and queued work — there is no per-submission abort — so shared conversations (an operator chat that also receives dispatched internal work) should account for that scope.

## React

`@flue/react` now exports only `useFlueAgent`. `FlueProvider` and `useFlueWorkflow` are removed.

```tsx
// Beta
<FlueProvider client={deploymentClient}>…</FlueProvider>
const agent = useFlueAgent({ name: 'support-assistant', id });

// Now — pass the conversation URL, or a memoized conversation client
const agent = useFlueAgent({ url: `/api/agents/support-assistant/${id}` });
const agent = useFlueAgent({ client }); // useMemo the client — a new instance replaces the session
```

Messages remain Flue-owned parts-based values; new part kinds (`data-*` from `useDataWriter`, message `metadata` from the response hooks) should be narrowed, not assumed. `refresh()` and the dormant-when-`url`-omitted behavior carry over.

## Cloudflare deployments

- **`FlueRegistry` is gone.** The beta's deployment-wide registry DO indexed workflow runs; nothing replaces it. Append a `deleted_classes` migration for it, and for every `Flue<Name>Workflow` class.
- Generated classes are per-agent only: `export function Triage()` → class `FlueTriageAgent`, binding `FLUE_TRIAGE_AGENT` (one class per agent function; a file can carry several). Migration history stays user-authored — adding an agent is always the triple: the exported agent function in a `'use agent'` module, the mount (unless dispatch-only), and a `new_sqlite_classes` entry. Renames use `renamed_classes` — but remember the [schema reset](#before-you-start-persisted-state-resets): a beta-era database is rejected even under a renamed class, so beta agents are usually retired (`deleted_classes`) in favor of fresh identities.
- Your authored `wrangler.jsonc` is never modified; the build merges it into `.flue-vite.wrangler.jsonc` and the deployable config lands in `dist/`. Deploy with `wrangler deploy --config dist/<worker>/wrangler.json`.
- The generated entry exports every agent class plus your `app.ts` fetch handler; application-owned exports (your own DOs, Workflows) come from `cloudflare.ts`.

## CLI

`flue init`, `flue add`, `flue update`, and `flue docs` remain. `flue dev` and `flue build` are removed (Vite owns both). `flue run <path>` executes one agent module directly — `--message`, `--name` (select one agent by name when the module defines several), `--id`, `--initial-data`, `--uid`/`--new`, `--max-attempts`/`--timeout` (durability for this run), `--json`.

## Migration checklist

1. **Pins.** Replace `@flue/*@1.0.0-beta.x` with the current versions; add `@flue/vite`, `vite`, and (Cloudflare) `@cloudflare/vite-plugin`. Drop beta-era patches and vendored builds — re-verify each patched behavior against the new runtime before porting anything.
2. **Build.** Author `vite.config.ts` (`flue()` before `cloudflare()`); move package scripts to `vite dev`/`vite build`; gitignore the generated files.
3. **Routing.** Author explicit mounts in `app.ts`; delete `flue()` router usage; decide which agents are dispatch-only.
4. **Agents.** Convert each initializer to an exported capitalized agent function in a `'use agent'` module: hooks for behavior, statics (`agentName`, `initialData`) for the contract, binding options for durability, `AgentProps` for the id, platform env instead of `ctx.env`. Convert profiles to `useSubagent` agent functions.
5. **Tools.** Rename `run({ input })` to `run({ data })`; adopt `harness: true` where tools prompted sessions; consider `durable: true` for side-effect sequences.
6. **Skills.** Delete import attributes; let `SKILL.md` imports package themselves; wrap other markdown with `defineSkill` where needed.
7. **Workflows.** Replace each with the smallest fit: awaited `init()` handle, durable tool, or an application-owned orchestrator.
8. **Observability.** Migrate `run_*` handling to `agent_start`/`agent_end`/`submission_settled` and the `instanceId`/`submissionId`/`dispatchId` correlation fields.
9. **Clients.** Move SDK and React usage to conversation-scoped clients and `useFlueAgent({ url | client })`.
10. **Deployment.** Append `deleted_classes` for `FlueRegistry` and workflow classes; add `new_sqlite_classes` for new agents; plan the drained deployment for the schema reset.
11. **Verify.** Typecheck, tests, a production `vite build`, and a check of the built artifact (exports, merged wrangler config) before deploying.
