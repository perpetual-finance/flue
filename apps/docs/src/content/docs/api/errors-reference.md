---
title: Errors Reference
description: Reference Flue transport errors, runtime failures, and development diagnostics.
lastReviewedAt: 2026-07-02
---

Flue exposes stable machine-readable error categories through its public transports. Runtime operations, CLI commands, and builds also report failures, but not every surface uses the transport error vocabulary.

## Public transport errors

#### `FluePublicError`

```ts
interface FluePublicError {
  type: string;
  message: string;
  details: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

Caller-safe error details exposed by Flue transports. Unknown failures become a generic `internal_error` payload without leaking their original message. Branch on `type`, not message prose.

| Field     | Meaning                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| `type`    | Stable machine-readable error category.                                                   |
| `message` | Short caller-facing summary.                                                              |
| `details` | Caller-facing explanation.                                                                |
| `dev`     | Additional local development guidance when available.                                     |
| `meta`    | Structured error-specific metadata when available. For example, validation issue details. |

`dev` is omitted unless the runtime has additional guidance and is running locally (`vite dev`); production builds omit local-only guidance.

### Categories

The following categories are stable for framework-owned transport failures. HTTP responses use the listed status code.

| Type                     | HTTP status | Meaning                                                                                                                                                  |
| ------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method_not_allowed`     | `405`       | The endpoint does not accept the request method. HTTP responses include `Allow`.                                                                         |
| `unsupported_media_type` | `415`       | A request body was not sent as JSON.                                                                                                                     |
| `invalid_json`           | `400`       | A request body could not be read or parsed as JSON.                                                                                                      |
| `route_not_found`        | `404`       | No mounted route matches the request. Also rendered for an agent's attachment endpoint when the module does not export `attachments` (opt-in downloads). |
| `stream_not_found`       | `404`       | The conversation stream does not exist yet; conversation streams are created on the first admitted message.                                              |
| `attachment_not_found`   | `404`       | The attachment id is unknown or belongs to a different conversation.                                                                                     |
| `invalid_request`        | `400`       | The request shape, parameters, or protocol message is invalid. Read `details` for the specific reason.                                                   |
| `runtime_unavailable`    | `503`       | The local dev runtime is reloading or draining. Responses include `Retry-After`.                                                                         |
| `internal_error`         | `500`       | An unknown or non-public server failure occurred.                                                                                                        |

## Transport envelopes

| Surface                                                  | Envelope                     |
| -------------------------------------------------------- | ---------------------------- |
| Framework HTTP error response                            | `{ error: FluePublicError }` |
| Durable Streams invalid-query or missing-stream response | `{ error: FluePublicError }` |

Durable Streams reads use the same framework envelope for invalid query parameters and missing streams. A stream may still terminate through transport behavior rather than a JSON error body, such as a client disconnect during SSE.

See [Events Reference](/docs/api/events-reference/) for runtime event types.

## Settlement and operation failures

A submission's terminal settlement (`submission-settled` conversation chunks, `submission_settled` events) and operation events expose open-ended `error?: unknown` values. Runtime exceptions are commonly serialized as `{ name, message }` when recorded. These failure records are structured observation data, not a closed list of machine-readable transport categories.

## Runtime exceptions

### `FlueError`

```ts
class FlueError extends Error {
  readonly type: string;
  readonly details: string;
  readonly dev: string;
  readonly meta?: Record<string, unknown>;
}
```

The catchable base class for framework-thrown runtime failures, exported from `@flue/runtime`. Application code distinguishes Flue failures from arbitrary errors with `instanceof FlueError`, then narrows with the concrete subclasses below or the stable `type` field. Message, `details`, and `dev` strings are human-readable prose, not API.

### Runtime errors

Harness and session operations, and runtime provider registration, reject with typed `FlueError` subclasses, all importable from `@flue/runtime`:

| Class                            | `type`                          | Thrown when                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionNotFoundError`           | `session_not_found`             | `sessions.get()` targets a session that does not exist.                                                                                                                                                                 |
| `SessionAlreadyExistsError`      | `session_already_exists`        | `sessions.create()` targets a session that already exists.                                                                                                                                                              |
| `SessionBusyError`               | `session_busy`                  | An operation starts while another operation is running.                                                                                                                                                                 |
| `SkillNotRegisteredError`        | `skill_not_registered`          | A skill call or activation names a skill that is not registered.                                                                                                                                                        |
| `SkillDefinitionValidationError` | `skill_definition_validation`   | A `defineSkill()` value is malformed.                                                                                                                                                                                   |
| `DelegationDepthExceededError`   | `delegation_depth_exceeded`     | Nested Task and Action delegation exceeds the supported depth.                                                                                                                                                          |
| `SubagentNotDeclaredError`       | `subagent_not_declared`         | `task()` names a subagent the agent does not declare.                                                                                                                                                                   |
| `AttachmentNotAvailableError`    | `attachment_not_available`      | A delivered attachment's bytes cannot be resolved for model context.                                                                                                                                                    |
| `ToolNameConflictError`          | `tool_name_conflict`            | Custom or sandbox adapter tool names collide with each other or with framework-reserved names.                                                                                                                          |
| `ToolLegacyDefinitionError`      | `tool_legacy_definition`        | A tool definition uses the removed `parameters` or `execute` fields. `meta.fields` lists the legacy fields found.                                                                                                       |
| `ToolInputValidationError`       | `tool_input_validation`         | Model-supplied tool arguments fail the tool's Valibot `input` schema. The agent loop converts the throw into an error tool result so the model can retry; `meta.tool` and `meta.issues` identify the tool and failures. |
| `ToolOutputValidationError`      | `tool_output_validation`        | A tool's return value fails its Valibot `output` schema. `meta.tool` and `meta.issues` identify the tool and failures.                                                                                                  |
| `ToolOutputSerializationError`   | `tool_output_serialization`     | A tool's parsed return value cannot be snapshotted as JSON-compatible data, or an output schema produces `undefined`. `meta.tool` identifies the tool.                                                                  |
| `OperationFailedError`           | `operation_failed`              | An operation ran but did not complete successfully (for example, the model call errored).                                                                                                                               |
| `SubmissionInterruptedError`     | `submission_interrupted`        | An interrupted durable submission could not be safely replayed and was terminalized.                                                                                                                                    |
| `SubmissionRetryExhaustedError`  | `submission_retry_exhausted`    | A durable submission exceeded its configured recovery attempt limit.                                                                                                                                                    |
| `SubmissionTimeoutError`         | `submission_timeout`            | A durable submission exceeded its configured processing timeout.                                                                                                                                                        |
| `SubmissionAbortedError`         | `submission_aborted`            | A durable submission was aborted and settled to the aborted outcome.                                                                                                                                                    |
| `ProviderRegistrationError`      | `invalid_provider_registration` | `registerProvider()` targets a non-catalog provider id without `api` and `baseUrl`.                                                                                                                                     |

### Action errors

| Class                            | `type`                        | Thrown when                                                                 |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `ActionInputValidationError`     | `action_input_validation`     | Action input failed schema parsing. `meta` contains `action` and `issues`.  |
| `ActionOutputValidationError`    | `action_output_validation`    | Action output failed schema parsing. `meta` contains `action` and `issues`. |
| `ActionOutputSerializationError` | `action_output_serialization` | Action output was not JSON-serializable. `meta.action` identifies it.       |
| `ActionInputUnexpectedError`     | `action_input_unexpected`     | Input was supplied to an Action that declares no input schema.              |

`ActionInputUnexpectedError` was renamed from `WorkflowInputUnexpectedError` when workflows were removed. All `Workflow*` and `Run*` error classes (`WorkflowNotFoundError`, `RunNotFoundError`, and the rest) were deleted with them.

### `ResultUnavailableError`

```ts
class ResultUnavailableError extends Error {
  readonly reason: string;
  readonly assistantText: string;
}
```

Thrown when an agent cannot produce a required structured result, either because it gives up or does not finish after follow-up attempts. Import it from `@flue/runtime` when application logic needs to handle that outcome separately.

### Cancellation

Aborted prompt, skill, task, and shell operations reject with a standard `AbortError` (`DOMException`) carrying the abort reason as `cause` when the runtime permits it. Cancellation is deliberately not part of the `FlueError` vocabulary.

Authoring and definition-time validation failures, such as invalid agent profiles, tool definitions, or model ids, reject with human-readable `Error` messages. Those messages are not stable machine-readable categories. A `dispatch()` call with a missing `id` also rejects this way; a malformed `message` instead throws the stable `invalid_request` `InvalidRequestError`, the same validation a direct HTTP prompt's body goes through.

## Persistence errors

Adapter and store failures use their own `FlueError` subclasses, importable from `@flue/runtime/adapter`: `PersistedSchemaVersionError` (`persisted_schema_version_unsupported`), `ConversationStreamStoreError` (`conversation_stream_store_failure`), `AttachmentConflictError` (`attachment_conflict`), and `AttachmentIntegrityError` (`attachment_integrity`). They fire at startup or inside store operations, not as HTTP categories. See [Data Persistence API](/docs/api/data-persistence-api/).

## CLI, build, and development diagnostics

CLI and build diagnostics are human-oriented messages written to stderr. They do not currently expose stable machine-readable error codes.

| Surface                | Diagnostic families                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI arguments          | Unsupported flags, missing values, and removed-command pointers (`flue dev` → `vite dev`, dropped `flue run` flags).                                            |
| Configuration          | Missing or invalid `flue.config.*` files, invalid default exports, and unsupported fields.                                                                      |
| `flue run`             | Module resolution (path-not-name guidance), Cloudflare-only imports, persistence setup, and environment files.                                                  |
| Vite plugin (`flue()`) | Missing `app.ts` (with a starter suggestion), duplicate agent identities, unmarked agent modules, and Cloudflare sibling-plugin and wrangler-config validation. |

Use the actionable diagnostic prose when resolving these errors. Do not parse it as a stable API. See [`flue run`](/docs/cli/run/) for command behavior.

## Application-owned responses

An authored [`app.ts`](/docs/api/routing-api/) owns its request pipeline. Custom routes and middleware may return arbitrary statuses and bodies, including authorization responses. Flue does not impose an `unauthorized` transport category on application-owned responses.

## Stability boundary

| Surface                                                           | Contract                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `FluePublicError` fields and documented categories                | Stable public transport contract.                        |
| Exported `FlueError` subclasses and their `type` fields           | Stable public runtime contract.                          |
| Settlement records and operation events                           | Structured but open-ended failure data.                  |
| Runtime exception messages and CLI, configuration, build messages | Human-oriented diagnostics subject to refinement.        |
| Generated target internals                                        | Implementation details, not public transport categories. |
