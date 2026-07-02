---
{ "kind": "tooling", "version": 2, "website": "https://sentry.io" }
---

# Add Sentry to Flue

You are an AI coding agent adding Sentry error reporting to a Flue project. Use
the SDK for the configured target, initialize it at the correct runtime
boundary, and bridge selected Flue events into Sentry with correlation tags.

The integration reports failed top-level agent operations, failed durable
submission settlements, and explicit `log.error(...)` calls. It does not export
prompts, model responses, tool arguments, traces, or AI metrics by default.

## Inspect the project

Read local instructions, detect the package manager, and select the first
existing source root: `<root>/.flue/`, then `<root>/src/`, then `<root>/`. Inspect
`flue.config.ts`, `vite.config.ts`, deployment commands, `app.ts`, every module
under `agents/`, environment types, and secret conventions.

Determine the configured target before installing a Sentry package:

- **Node:** install `@sentry/node@^10.53.1`.
- **Cloudflare:** install `@sentry/cloudflare@^10.53.1`. Do not use `@sentry/node` through
  `nodejs_compat`.

If the target cannot be determined, ask the user. Do not install both SDKs to
make one static source file target-agnostic.

## Configure Sentry

Use these environment variables unless the project already has an established
Sentry convention:

| Variable             | Purpose                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `SENTRY_DSN`         | Project DSN; keep it configurable through the deployment environment. |
| `SENTRY_ENVIRONMENT` | Optional environment name such as `production` or `staging`.          |
| `SENTRY_RELEASE`     | Optional release identifier such as a commit SHA.                     |

Never invent a DSN or hard-code it in application source. A Sentry DSN permits
event submission but does not grant read access to project data. Update an
existing `.env.example`, environment type, or deployment documentation when the
project maintains one, and preserve its deployment-configuration conventions.

## Create the Flue event bridge

Create `<source-dir>/sentry.ts` using the target-specific import and
initialization below. The remaining bridge is shared by both targets.

### Node initialization

```ts title="src/sentry.ts"
// flue-blueprint: tooling/sentry@2
import { type FlueEvent, observe } from '@flue/runtime';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  attachStacktrace: true,
  tracesSampleRate: 0,
});
```

This module-scoped initialization supports the explicit captures in this
blueprint. Sentry's complete Node auto-instrumentation requires its preload hook
to run before application imports. If the user also wants automatic HTTP,
database, or tracing instrumentation, configure the production Node command
with the current Sentry-recommended preload, for example
`NODE_OPTIONS="--import=@sentry/node/preload"`, and verify it against the built
Flue server. Do not claim complete auto-instrumentation from the late
`sentry.ts` initialization alone.

### Cloudflare initialization

```ts title="src/sentry.ts"
// flue-blueprint: tooling/sentry@2
import { type FlueEvent, observe } from '@flue/runtime';
import * as Sentry from '@sentry/cloudflare';
```

Initialize `@sentry/cloudflare` following Sentry's current documented Workers
setup; research it from primary sources rather than assuming the Node
module-scope `Sentry.init(...)` call applies unchanged. Flue's required
`nodejs_compat` mode makes environment values available through `process.env`.
Verify captures are actually delivered from a Durable Object isolate before
claiming the integration works.

### Shared bridge

Append this code after the target-specific imports and initialization:

```ts
observe((event) => {
  const tags = correlationTags(event);

  if (event.type === 'operation' && event.isError) {
    captureException(event.error, tags, {
      durationMs: event.durationMs,
      operationKind: event.operationKind,
    });
    return;
  }

  if (event.type === 'submission_settled' && event.outcome === 'failed') {
    captureException(event.error, tags);
    return;
  }

  if (event.type === 'log' && event.level === 'error') {
    Sentry.withScope((scope) => {
      scope.setTags(tags);
      scope.setLevel('error');
      if (Object.hasOwn(event.attributes ?? {}, 'error')) {
        Sentry.captureException(toError(event.attributes?.error));
      } else {
        Sentry.captureMessage(event.message, 'error');
      }
    });
  }
});

function captureException(
  error: unknown,
  tags: Record<string, string>,
  context?: Record<string, unknown>,
): void {
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    scope.setLevel('error');
    if (context) scope.setContext('flue.incident', context);
    Sentry.captureException(toError(error));
  });
}

function correlationTags(event: FlueEvent): Record<string, string> {
  const tags: Record<string, string> = {};
  if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
  if (event.dispatchId) tags['flue.dispatch.id'] = event.dispatchId;
  if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
  if (event.harness) tags['flue.harness'] = event.harness;
  if (event.session) tags['flue.session'] = event.session;
  if (event.parentSession) tags['flue.parent_session'] = event.parentSession;
  if (event.operationId) tags['flue.operation.id'] = event.operationId;
  if (event.taskId) tags['flue.task.id'] = event.taskId;
  return tags;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const source = value as { name?: unknown; message?: unknown; stack?: unknown };
    const error = new Error(typeof source.message === 'string' ? source.message : stringify(value));
    if (typeof source.name === 'string') error.name = source.name;
    if (typeof source.stack === 'string') error.stack = source.stack;
    return error;
  }
  return new Error(typeof value === 'string' ? value : stringify(value));
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
```

Import the bridge once from the source-root `app.ts`:

```ts
import './sentry.ts';
```

Preserve the application's existing imports, middleware, routes, and default
export. If there is no `app.ts`, create one that imports `./sentry.ts`, creates a
Hono application, mounts each HTTP-reachable agent with
`app.route('/agents/<name>', agent.route())`, and default-exports the app.
Install a direct `hono` dependency when authoring that file.

`observe(...)` is isolate-local and receives every event from every agent the
current isolate handles. Captures correlate through agent instance, session,
operation, submission, and dispatch fields; pivoting on `flue.instance.id` in
Sentry's search finds every capture from a single conversation, and
`flue.submission.id` pins down one submission.

Capture only the terminal signals above. A terminal agent failure can surface
as both a failed `operation` and a failed settlement for the same underlying
error; Sentry's grouping folds them into one issue. Do not capture lower-level
failed tool, task, turn, or compaction events; they can be recoverable and
would duplicate the selected terminal signals. Do not forward prompts, model
output, tool arguments, or arbitrary event payloads without an explicit
data-handling decision.

## Cloudflare isolate scoping

Skip this section for Node.

On Cloudflare each agent runs in its own Durable Object, which is its own V8
isolate, separate from the outer Worker and from every other agent. `app.ts` —
and therefore the `sentry.ts` it imports — is evaluated once per isolate: the
outer Worker once, plus each Durable Object once. Initialization and
`observe(...)` therefore run independently inside every isolate, and each
isolate captures its own errors with its own Sentry client. This is the right
shape, not a workaround: there is no shared module state across isolates, no
per-agent wiring is needed, and no cross-isolate plumbing is possible.

Configure `SENTRY_DSN` through a Worker secret or environment binding according
to the project's policy. For local Wrangler development, follow the existing
`.dev.vars` or `.env` convention. Keep the DSN outside application source so it
can be rotated or disabled without a code change. Environment and release values
may be Wrangler `vars`.

Flue already requires Cloudflare's `nodejs_compat` compatibility flag. Preserve
it. The bridge covers agent Durable Objects and the outer Worker through their
own module evaluations. If the user also wants HTTP request instrumentation for
the authored Hono `app.ts`, research and add Sentry's current Hono or Workers
middleware separately; do not claim the event bridge covers HTTP requests.

## Verify

1. Type-check the project and build it with `vite build` for its configured
   Flue target.
2. Start the real target runtime with a non-production Sentry project.
3. Send a message to an agent that fails terminally; confirm the captures group
   into one Sentry issue tagged with `flue.instance.id` and
   `flue.submission.id`.
4. Call `log.error(...)` from an action once with an `error` attribute and once
   without; confirm an exception and an error-level message are captured while
   the conversation completes normally.
5. Trigger a successful conversation and confirm it produces no Sentry traffic.
6. On Cloudflare, exercise at least one agent Durable Object under workerd and
   confirm the event is delivered from that isolate.
7. Remove the DSN and confirm the application still starts and capture calls are
   no-ops.
8. Inspect event payloads to confirm prompts, model responses, tool arguments,
   and secrets were not exported.
9. If Node preloading or Hono middleware was added, verify that behavior
   separately and check for duplicate reports.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in `sentry.ts`.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.

### Version 2 — 2026-06-16

Remove the runtime event-type filter. The bridge continues to branch on the event variants it handles.

```diff
--- a/src/sentry.ts
+++ b/src/sentry.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: tooling/sentry@1
+// flue-blueprint: tooling/sentry@2
@@ -39,51 +39,46 @@ const runTags = new Map<string, Record<string, string>>();
-observe(
-  (event) => {
-    if (event.type === 'run_start' || event.type === 'run_resume') {
-      runTags.set(event.runId, { 'flue.workflow': event.workflowName });
-      return;
-    }
+observe((event) => {
+  if (event.type === 'run_start' || event.type === 'run_resume') {
+    runTags.set(event.runId, { 'flue.workflow': event.workflowName });
+    return;
+  }

-    const tags = correlationTags(event);
+  const tags = correlationTags(event);

-    if (event.type === 'run_end') {
-      runTags.delete(event.runId);
-      if (!event.isError) return;
-      captureException(event.error, tags, { durationMs: event.durationMs });
-      return;
-    }
+  if (event.type === 'run_end') {
+    runTags.delete(event.runId);
+    if (!event.isError) return;
+    captureException(event.error, tags, { durationMs: event.durationMs });
+    return;
+  }

-    if (event.type === 'operation' && event.isError && !event.runId) {
-      captureException(event.error, tags, {
-        durationMs: event.durationMs,
-        operationKind: event.operationKind,
-      });
-      return;
-    }
+  if (event.type === 'operation' && event.isError && !event.runId) {
+    captureException(event.error, tags, {
+      durationMs: event.durationMs,
+      operationKind: event.operationKind,
+    });
+    return;
+  }

-    if (event.type === 'submission_settled' && event.outcome === 'failed') {
-      captureException(event.error, tags);
-      return;
-    }
+  if (event.type === 'submission_settled' && event.outcome === 'failed') {
+    captureException(event.error, tags);
+    return;
+  }

-    if (event.type === 'log' && event.level === 'error') {
-      Sentry.withScope((scope) => {
-        scope.setTags(tags);
-        scope.setLevel('error');
-        if (Object.hasOwn(event.attributes ?? {}, 'error')) {
-          Sentry.captureException(toError(event.attributes?.error));
-        } else {
-          Sentry.captureMessage(event.message, 'error');
-        }
-      });
-    }
-  },
-  {
-    types: ['run_start', 'run_resume', 'run_end', 'operation', 'submission_settled', 'log'],
-  },
-);
+  if (event.type === 'log' && event.level === 'error') {
+    Sentry.withScope((scope) => {
+      scope.setTags(tags);
+      scope.setLevel('error');
+      if (Object.hasOwn(event.attributes ?? {}, 'error')) {
+        Sentry.captureException(toError(event.attributes?.error));
+      } else {
+        Sentry.captureMessage(event.message, 'error');
+      }
+    });
+  }
+});
```
