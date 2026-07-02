---
title: Sentry
description: Report Flue agent failures and explicit error logs to Sentry on Node.js and Cloudflare.
lastReviewedAt: 2026-07-02
---

## Quickstart

Add error reporting to an existing Flue project with the [Sentry](https://sentry.io) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add tooling sentry
```

## Overview

The Sentry blueprint creates a source-root `sentry.ts` and imports it once from `app.ts`. On Node.js, the core of that generated bridge looks like this:

```ts title="src/sentry.ts (abridged)"
import { observe } from '@flue/runtime';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  attachStacktrace: true,
  tracesSampleRate: 0,
});

observe((event) => {
  if (event.type === 'operation' && event.isError) {
    Sentry.captureException(toError(event.error));
  }

  if (event.type === 'submission_settled' && event.outcome === 'failed') {
    Sentry.captureException(toError(event.error));
  }

  if (event.type === 'log' && event.level === 'error') {
    if (Object.hasOwn(event.attributes ?? {}, 'error')) {
      Sentry.captureException(toError(event.attributes?.error));
    } else {
      Sentry.captureMessage(event.message, 'error');
    }
  }
});

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
```

On Cloudflare, the generated `sentry.ts` contains the same observer bridge without calling `Sentry.init()`. Instead, the blueprint adds a module-local `cloudflare` extension to every agent. The extension wraps the final generated Durable Object class with `instrumentDurableObjectWithSentry(...)`, while leaving the outer Worker uninstrumented.

## Configure

| Variable             | Purpose                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`         | **Required for event delivery** — Identifies the Sentry project and permits event submission. |
| `SENTRY_ENVIRONMENT` | **Optional** — Identifies the deployment environment in Sentry.                               |
| `SENTRY_RELEASE`     | **Optional** — Associates events with a deployed release.                                     |

Only `SENTRY_DSN` is needed to deliver events. A Sentry DSN permits event submission but does not grant read access to project data. Keeping it in deployment configuration rather than application source makes rotation and abuse mitigation easier; use a secret or environment binding according to your project's policy.

The blueprint installs `@sentry/node` or `@sentry/cloudflare`, initializes the SDK at the appropriate runtime boundary, and adds an `observe(...)` bridge for failed agent operations, failed submission settlements, and explicit `log.error(...)` calls. It does not enable traces, AI metrics, or model-content export by default.

See [Observability](/docs/guide/observability/#choose-an-observability-provider) to compare Sentry with OpenTelemetry and Braintrust.

The integration uses different SDKs by target:

| Target     | Package              | Initialization                                                                      |
| ---------- | -------------------- | ----------------------------------------------------------------------------------- |
| Node.js    | `@sentry/node`       | Module-scoped `Sentry.init(...)` in application source                              |
| Cloudflare | `@sentry/cloudflare` | `instrumentDurableObjectWithSentry(...)` around each generated agent Durable Object |

Do not use `@sentry/node` on Cloudflare through `nodejs_compat`.

## Choose what to report

The generated bridge reports:

- `operation` events with `isError: true` (a failed prompt, skill, task, shell, or compact operation);
- `submission_settled` events with `outcome: 'failed'` (a durable submission recovery settled as failed);
- `log.error(...)` as an exception when the log has an `error` attribute;
- other error logs as error-level Sentry messages.

Captures include relevant `flue.*` correlation tags — agent instance, session, operation, submission, and optional dispatch correlation. See [Observability](/docs/guide/observability/) for Flue's identity and observer model.

The bridge intentionally avoids arbitrary log attributes, prompts, responses, tool arguments, and complete event payloads. Make an explicit data-handling decision before expanding that policy.

## Target behavior

On Node.js, module-scoped initialization is sufficient for the bridge's explicit captures. Complete Sentry HTTP, database, or tracing auto-instrumentation requires Sentry's preload setup before application imports and should be verified against the built Flue server.

On Cloudflare, Flue applies a module-local `wrap` extension to the final generated Durable Object class for every instrumented agent. This preserves Flue's routing and durability behavior while allowing Sentry to initialize from the current binding environment. The wrapper does not cover the outer Worker or an authored Hono application; add HTTP middleware separately when request instrumentation is required.

## Verify

Trigger one failed agent operation and one explicit error log against a non-production Sentry project. Confirm the expected `flue.*` correlation fields. On Cloudflare, exercise a wrapped agent under workerd, and verify that the application still starts without a configured DSN.
