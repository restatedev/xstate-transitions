/*
 * Copyright (c) 2025-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

/*
 * Derive Restate ingress serdes from an XState v6 machine's `schemas`.
 *
 * XState v6 keeps `schemas` on the machine at runtime, and each entry is a
 * Standard Schema — the very interface Restate's `serde.schema(...)` consumes.
 * So the public `create`/`send` boundary is validated (and coerced) from the
 * `schemas.input` / `schemas.events` the author wrote once, with no separate
 * configuration.
 *
 * Two caveats shape this module:
 *   - `types<T>()` is type-only. Its validator is the identity function, so it is
 *     "no runtime validator" and we ignore it (`isTypeSchema`).
 *   - XState stores an event payload schema per event *type*, without the `type`
 *     discriminant. `eventSchema` adapts that map into one Standard Schema over
 *     the whole `{ type, ...payload }` event.
 *
 * These are the sole source of the public `create`/`send` serdes (see object.ts).
 */

import { isTypeSchema, type StandardSchemaV1 } from "xstate";
import type { AnyStateMachine, EventFrom, InputFrom } from "xstate";
import type { StandardSchema, StandardSchemaResult } from "./types";

/**
 * The `schemas` XState v6 keeps on a machine at runtime. The public
 * `AnyStateMachine` interface does not surface it, so we read it structurally.
 */
interface WithSchemas {
  readonly schemas?: {
    readonly input?: StandardSchemaV1;
    readonly events?: Readonly<Record<string, StandardSchemaV1>>;
  };
}

const schemasOf = (machine: AnyStateMachine): WithSchemas["schemas"] =>
  (machine as WithSchemas).schemas;

/**
 * The input validator declared on `machine.schemas.input`, or `undefined` when
 * it is absent or type-only (`types<T>()`).
 */
export function deriveInputSchema<M extends AnyStateMachine>(
  machine: M,
): StandardSchema<InputFrom<M>> | undefined {
  return realSchema<InputFrom<M>>(schemasOf(machine)?.input);
}

/**
 * A discriminated-event validator built from `machine.schemas.events`.
 *
 * Returns `undefined` when there are no event schemas or when every one is
 * type-only — in that case there is nothing to validate at runtime and the
 * public `send` boundary stays permissive, matching prior behavior.
 */
export function deriveEventSchema<M extends AnyStateMachine>(
  machine: M,
): StandardSchema<EventFrom<M>> | undefined {
  const events = schemasOf(machine)?.events;
  if (events === undefined) return undefined;

  const entries = Object.entries(events);
  if (
    entries.length === 0 ||
    entries.every(([, schema]) => isTypeSchema(schema))
  ) {
    return undefined;
  }

  return eventSchema<EventFrom<M>>(events);
}

/**
 * The permissive fallback used for `send` when a machine declares no real event
 * schema (no events, or only `types<T>()`). It accepts any `{ type, ...payload }`
 * object and publishes that minimal envelope to discovery, so `send` always
 * advertises at least the event shape. It does not coerce, and it does not judge
 * the `type` beyond requiring a non-empty string — the send handler still
 * rejects the reserved `xstate.*` namespace.
 */
export function genericEventSchema<E>(): StandardSchema<E> {
  const validate = (value: unknown): StandardSchemaResult<E> =>
    eventType(value) === undefined
      ? issue(
          "A machine event must be an object with a non-empty string 'type'.",
        )
      : { value: value as E };

  const output = (): Record<string, unknown> => ({
    type: "object",
    properties: { type: { type: "string" } },
    required: ["type"],
  });

  return {
    "~standard": {
      version: 1,
      vendor: "restate.xstate.events",
      validate,
      jsonSchema: { input: output, output },
    },
  } as unknown as StandardSchema<E>;
}

/** A Standard Schema that actually validates, or `undefined` for type-only ones. */
function realSchema<T>(
  candidate: StandardSchemaV1 | undefined,
): StandardSchema<T> | undefined {
  if (candidate === undefined || isTypeSchema(candidate)) return undefined;
  return candidate as unknown as StandardSchema<T>;
}

/**
 * Adapt XState's per-type payload schemas into one Standard Schema over a whole
 * event. It validates that `type` names a declared public event, validates the
 * payload (minus `type`) against that event's schema, and reattaches `type` to
 * the (possibly coerced) result. Unknown types and asynchronous validators are
 * rejected. It never throws: `restate.serde.schema` probes `validate(undefined)`
 * at construction, so every path returns a Standard Schema result.
 *
 * It also implements the Standard JSON Schema extension (`~standard.jsonSchema`)
 * by composing the per-type payload schemas into a discriminated `anyOf`, so the
 * whole event surfaces in Restate discovery — mirroring how a real schema
 * library exposes its own JSON Schema. Without this the adapter would erase the
 * payload schemas' discovery info.
 */
function eventSchema<E>(
  events: Readonly<Record<string, StandardSchemaV1>>,
): StandardSchema<E> {
  const allowed = Object.keys(events);

  const validate = (value: unknown): StandardSchemaResult<E> => {
    const type = eventType(value);
    if (type === undefined) {
      return issue(
        "A machine event must be an object with a non-empty string 'type'.",
      );
    }

    // Only own keys count: `type` is attacker-controlled, so an inherited
    // `Object.prototype` name (`toString`, `constructor`, `__proto__`, …) must
    // resolve to "unknown event", never to a prototype member.
    const payloadSchema = Object.hasOwn(events, type)
      ? events[type]
      : undefined;
    if (payloadSchema === undefined) {
      return issue(
        `Unknown event type "${type}". Expected one of: ${allowed.join(", ")}.`,
      );
    }

    const { type: _type, ...payload } = value as Record<string, unknown>;
    const result = payloadSchema["~standard"].validate(payload);
    if (isThenable(result)) {
      return issue(
        `Asynchronous schema validation is not supported (event "${type}").`,
      );
    }
    if (result.issues !== undefined) {
      return { issues: result.issues };
    }

    // Reattach the discriminant onto the (possibly coerced) payload.
    return {
      value: { ...(result.value as Record<string, unknown>), type } as E,
    };
  };

  const toJsonSchema = (
    options: JsonSchemaOptions,
  ): Record<string, unknown> => ({
    anyOf: allowed.map((type) =>
      eventBranchJsonSchema(type, events[type], options),
    ),
  });

  return {
    "~standard": {
      version: 1,
      vendor: "restate.xstate.events",
      validate,
      jsonSchema: { input: toJsonSchema, output: toJsonSchema },
    },
  } as unknown as StandardSchema<E>;
}

/** Options passed to a Standard JSON Schema converter. */
interface JsonSchemaOptions {
  readonly target: string;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** The Standard JSON Schema extension a payload schema may carry. */
interface JsonSchemaConverter {
  readonly output?: (options: JsonSchemaOptions) => Record<string, unknown>;
}

/** A single event's JSON Schema: its payload with a `type` const discriminant. */
function eventBranchJsonSchema(
  type: string,
  schema: StandardSchemaV1 | undefined,
  options: JsonSchemaOptions,
): Record<string, unknown> {
  const discriminant = {
    type: "object",
    properties: { type: { const: type } },
    required: ["type"],
  };
  const payload =
    schema === undefined ? undefined : payloadJsonSchema(schema, options);

  // Only inline a self-contained object payload. A payload that carries `$defs`
  // (recursive or reused schemas) uses document-root-relative `$ref`s that would
  // dangle once nested here, and a non-object payload (union / intersection)
  // cannot merge with the `type` discriminant. In both cases advertise just the
  // discriminant so the discovery schema stays valid rather than misleading.
  if (
    payload === undefined ||
    payload.type !== "object" ||
    "$defs" in payload ||
    "$ref" in payload
  ) {
    return discriminant;
  }

  const {
    $schema: _schema,
    properties,
    required,
    ...rest
  } = payload as {
    $schema?: unknown;
    properties?: Record<string, unknown>;
    required?: readonly string[];
    [key: string]: unknown;
  };
  return {
    ...rest,
    type: "object",
    properties: { type: { const: type }, ...(properties ?? {}) },
    required: Array.from(new Set(["type", ...(required ?? [])])),
  };
}

/** A payload schema's JSON Schema via the Standard extension, or `undefined`. */
function payloadJsonSchema(
  schema: StandardSchemaV1,
  options: JsonSchemaOptions,
): Record<string, unknown> | undefined {
  const converter = (
    schema["~standard"] as { jsonSchema?: JsonSchemaConverter }
  ).jsonSchema;
  if (converter?.output === undefined) return undefined;
  try {
    return converter.output(options);
  } catch {
    return undefined;
  }
}

/** The non-empty string `type` of an event-shaped value, else `undefined`. */
function eventType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

function issue<E>(message: string): StandardSchemaResult<E> {
  return { issues: [{ message }] };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}
