# Sentry error reporting for Flue

A working example of wiring Flue agents up to [Sentry](https://sentry.io)
for error reporting.

This example is intended to be read top-to-bottom as documentation. The
entire integration lives in [`src/app.ts`](src/app.ts) — every agent
in `src/agents/` is a plain Flue agent that doesn't import Sentry,
doesn't import the bridge, and doesn't know that error reporting is
happening.

## What you get

After running this example with a Sentry DSN configured:

- Every failed agent operation and every durable submission that settles
  as `failed` becomes a Sentry issue tagged with the Flue instance id,
  harness name, and session name.
- Every `log.error(...)` call from an action becomes a Sentry
  capture — an exception if the log carries an `error` attribute, a
  message otherwise.
- Sentry tags use a stable `flue.*` prefix, so pivoting on
  `flue.instance.id` in Sentry's search box finds every capture from a
  single agent instance, and `flue.submission.id` pins down one
  submission.

## What this example does NOT do

Deliberate scope cuts, listed up front so you can decide whether this
example fits your needs:

- **No spans, no traces.** Flue's event stream carries `durationMs`,
  `usage`, `operationKind`, and other span-shaped fields, but this
  integration does not emit Sentry spans. Adding spans is a layered
  follow-up rather than a redesign — the same `observe(...)` hook can
  call `Sentry.startInactiveSpan` for wide lifecycle events when
  you're ready.
- **No log forwarding for `info` / `warn`.** Only `log.error` reaches
  Sentry. If you want `log.info` as Sentry breadcrumbs, add a one-line
  `Sentry.addBreadcrumb(...)` call to the bridge in `app.ts`.
- **No tool-error capture.** Tool failures are usually recoverable
  (the model handles them and keeps going), so capturing them would
  drown out real incidents. The bridge in `app.ts` documents how to
  opt in.
- **No AI metrics.** Token counts, costs, and model identities live on
  Flue's `turn` and `operation` events, but this example does not
  forward them to Sentry as measurements or attributes.

## Files

```
examples/sentry/
├── vite.config.ts            ← the flue() Vite plugin; vite dev/build own the app
├── package.json
├── tsconfig.json
├── AGENTS.md                 ← system prompt for any agent that calls init()
├── README.md                 ← you are here
└── src/
    ├── app.ts                ← Sentry.init + observe(...) bridge + the route map
    └── agents/
        ├── hello.ts          ← success case — no Sentry traffic
        ├── boom.ts           ← terminal failure — captured via submission_settled
        └── explicit.ts       ← non-fatal log.error — captured while the agent continues
```

Open `src/app.ts` first. Every line is commented to explain why it's
there. The rest of this README explains how to run, what to look for,
and how the pieces fit together.

## How the integration works

Flue emits a structured event for every meaningful boundary in an agent's
work — `operation_start`, `operation`, `turn_request`, `turn`, `tool`,
`log`, `submission_settled`, and others. Events carry their correlation
tree (`instanceId`, `submissionId`, `harness`, `session`, `operationId`,
`turnId`, `taskId`) so any consumer can reconstruct what happened. See
[Observability](https://flueframework.com/docs/guide/observability/)
for the vendor-neutral event contract and its sensitive-content guidance.

The `@flue/runtime` package exposes a single function for tapping that
stream globally:

```ts
import { observe } from '@flue/runtime';

observe((event, ctx) => {
  // event is a fully decorated FlueEvent
  // ctx is the FlueEventContext of the activity that emitted it
});
```

`observe` is called once at module scope. The subscriber receives every
event from every agent handled by the current isolate.

The bridge in `app.ts` is a single `observe(...)` call that filters for
three event shapes:

| Flue event                                           | Sentry call                              | Severity |
| ---------------------------------------------------- | ---------------------------------------- | -------- |
| `operation` with `isError: true`                     | `captureException` (reconstructed Error) | `error`  |
| `submission_settled` with `outcome: 'failed'`        | `captureException` (reconstructed Error) | `error`  |
| `log` with `level: 'error'` and `attributes.error`   | `captureException` (reconstructed Error) | `error`  |
| `log` with `level: 'error'` and no `error` attribute | `captureMessage`                         | `error`  |

Every capture is enclosed in `Sentry.withScope(...)` so the Flue tags
do not leak into unrelated events captured by Sentry's auto-instrumentation
elsewhere in the process.

## Isolate scoping (Node vs. Cloudflare)

`observe` is described as "global," but the precise meaning differs by
target:

- **Node target.** One V8 isolate per server process. `observe` is
  truly global — register once in `app.ts`, captures fire for every
  agent the server handles.

- **Cloudflare target.** Each agent runs in its own [Durable
  Object](https://developers.cloudflare.com/durable-objects/), which
  is a separate V8 isolate from the outer Worker and from every other
  DO. `app.ts` is evaluated once per isolate. That means
  `Sentry.init` and `observe(...)` execute independently inside each
  DO. Every isolate has its own Sentry client and captures its own
  events. This is the only thing that _can_ work on Cloudflare — there
  is no shared module state across isolates — and it is the right
  shape: no cross-isolate RPC for every event, each agent
  independently reports its own errors.

You do not have to think about this when writing agents. Put
`Sentry.init` and `observe(...)` at the top of `app.ts` and the rest is
automatic.

## Running it

### 1. Install dependencies

From the repo root:

```bash
pnpm install
```

This example declares `@flue/runtime` as a workspace dependency and
`@sentry/node` as a regular npm dependency. The workspace install picks
up both.

### 2. Set up Sentry

Get a Sentry DSN from your project's Settings → Client Keys page. Then
either export it or put it in a `.env` file your shell sources:

```bash
export SENTRY_DSN='https://<key>@<org>.ingest.sentry.io/<project>'
export SENTRY_ENVIRONMENT='development'
```

If you skip this step, the integration still works — `Sentry.init` is
called with `enabled: false` and every capture is a no-op. The example
runs identically, you just won't see any traffic in Sentry's UI.

### 3. Run the dev server

```bash
pnpm exec vite dev
```

Vite prints the local URL it is serving (`http://localhost:5173` by
default — substitute yours below).

### 4. Trigger each scenario

Agent prompts are fire-and-forget: `POST` returns a `202` admission and
the conversation stream (a `GET` of the same URL) carries the outcome.
The trailing path segment is the caller-chosen conversation id.

```bash
# Success case — no Sentry traffic
curl -X POST http://localhost:5173/agents/hello/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Run the hello action."}'

# Terminal failure — one Sentry issue (the agent initializer throws)
curl -X POST http://localhost:5173/agents/boom/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Anything — this agent always fails."}'

# Non-fatal handler-reported errors — two Sentry issues, agent completes
curl -X POST http://localhost:5173/agents/explicit/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Run the explicit action."}'

# Watch a conversation's stream
curl http://localhost:5173/agents/explicit/demo-1
```

The `flue.instance.id` tag on each Sentry issue is the conversation id
from the URL (`demo-1` above); `flue.submission.id` matches the
`submissionId` in the `202` admission response.

## Adapting this to your project

To use this pattern in your own Flue project:

1. Add `@sentry/node` (or `@sentry/cloudflare` for the CF target) to
   your dependencies.
2. Copy the `observe(...)` bridge from `app.ts` into your own
   `app.ts`, alongside your own `Sentry.init` call.
3. Decide which event types you care about. The defaults in this
   example (failed operations, failed submissions, `log.error`) are a
   reasonable starting point; the bridge code documents what each
   branch does and how to enable the others.

That's the whole setup for agent error reporting. There is nothing to
do on a per-agent basis.

## Going further

When you outgrow error-only reporting, the same `observe(...)` hook can
carry more:

- **Breadcrumbs.** Forward `log.info` / `log.warn` to
  `Sentry.addBreadcrumb(...)` so each captured exception has the
  in-conversation log trail attached.
- **Spans.** The wide `operation`, `tool`, and `turn` events all carry
  `durationMs`. Synthesize Sentry spans from
  `(timestamp - durationMs, timestamp)` to build a flame graph for
  every conversation. The `gen_ai.*` OpenTelemetry semantic conventions
  are a good attribute schema to target — see Sentry's GenAI docs.
- **Metrics.** `turn.usage` carries input/output/cache tokens and cost.
  Forward as Sentry measurements or to a separate metrics sink.

None of those require changes to your agents. They all live inside the
same `observe(...)` callback you already have.
