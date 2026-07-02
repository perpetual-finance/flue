---
title: Action API
description: Reference for defining reusable finite Actions with @flue/runtime.
lastReviewedAt: 2026-07-02
---

The Action API is exported from `@flue/runtime`.

Actions are Flue's deterministic-code mechanism: reusable, finite, schema-validated jobs that run inside a durable agent conversation. Expose an Action to the model through an agent's `actions` field, where the framework manages it as a model-callable tool. (Workflows — the former code-first entrypoint that bound an agent to an action — were removed; an agent whose instructions call an Action covers that role, driven via `flue run`, `dispatch()`, or the SDK.)

## `defineAction()`

```ts
function defineAction<TInput, TOutput>(
  options: ActionOptions<TInput, TOutput>,
): ActionDefinition<TInput, TOutput>;
```

Defines reusable finite behavior. Pass the returned frozen value in an agent's `actions` array.

```ts
'use agent';
import { defineAction, defineAgent } from '@flue/runtime';
import * as v from 'valibot';

const dailyReport = defineAction({
  name: 'daily-report',
  description: 'Compile the daily triage report.',
  input: v.object({ date: v.string() }),
  async run({ harness, input, log }) {
    const session = await harness.session();
    const { data } = await session.prompt(`Compile the triage report for ${input.date}.`, {
      result: v.object({ summary: v.string() }),
    });
    log.info('report compiled', { date: input.date });
    return data;
  },
});

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'When asked for the daily report, call the `daily-report` action.',
  actions: [dailyReport],
}));
```

### Options

| Field         | Required | Description                                                                                  |
| ------------- | -------- | -------------------------------------------------------------------------------------------- |
| `name`        | Yes      | Non-empty model-facing tool name. Must not conflict with another active tool or Action name. |
| `description` | Yes      | Non-empty model-facing description.                                                          |
| `input`       | No       | Top-level object Valibot schema.                                                             |
| `output`      | No       | Valibot schema for the returned value.                                                       |
| `run`         | Yes      | Finite handler receiving `ActionContext`.                                                    |

Definition rejects missing metadata, non-Valibot schemas, and input schemas whose top level is not an object.

## `ActionContext`

```ts
type ActionContext<S> = {
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
} & (S extends ActionInputSchema ? { readonly input: InferOutput<S> } : {});
```

| Member    | Description                                                                                   |
| --------- | --------------------------------------------------------------------------------------------- |
| `harness` | Invocation-scoped harness supplied by the runner.                                             |
| `input`   | Parsed and transformed schema output. Omitted from the type when no input schema is declared. |
| `log`     | Structured logger for the current execution.                                                  |

Action context intentionally excludes transport requests and platform bindings. Pass required data through input and configure capabilities on the agent.

When a model calls an Action, Flue runs it in an isolated child scope. The child shares the parent agent configuration, sandbox, and filesystem, but has independent default and named sessions and cannot reenter the active parent session. Its canonical records remain append-only in the agent-instance stream for that instance's lifetime; there is no recursive per-session deletion.

## Input and output contracts

Input is validated before `run()` executes. Output is validated after `run()` when an output schema exists. Valibot transformations are reflected in the values received and returned.

Without an output schema, an Action may return any JSON-serializable value or `undefined`. With an output schema, the parsed result must be JSON-serializable and cannot be `undefined` unless the schema produces a serializable value.

## Utility types

```ts
type ActionInput<TAction extends ActionDefinition> = /* schema input type */;
type ActionOutput<TAction extends ActionDefinition> = /* schema output type */;
type ActionInputSchema = GenericSchema<Record<string, unknown>, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```

`ActionInput<TAction>` is the authored schema input type. `ActionOutput<TAction>` is the parsed output type, or `unknown` when no output schema is declared.

## Errors

| Error                            | `type`                        | Contract                                                                                                    |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ActionInputValidationError`     | `action_input_validation`     | Input failed schema parsing. `meta` contains `action` and `issues`.                                         |
| `ActionOutputValidationError`    | `action_output_validation`    | Returned output failed schema parsing. `meta` contains `action` and `issues`.                               |
| `ActionOutputSerializationError` | `action_output_serialization` | Final output was not JSON-serializable. `meta.action` identifies it.                                        |
| `ActionInputUnexpectedError`     | `action_input_unexpected`     | Input was supplied to an Action that declares no input schema. Renamed from `WorkflowInputUnexpectedError`. |

Validation issues use the exported `ValidationIssue` shape with `message` and an optional property-key `path`.
