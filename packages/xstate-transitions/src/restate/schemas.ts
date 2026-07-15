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
 * So a machine that already declares `schemas.input` / `schemas.events` needs no
 * separate `contract`: we can validate (and coerce) the public `create`/`send`
 * boundary from the schemas the author wrote once.
 *
 * Two caveats shape this module:
 *   - `types<T>()` is type-only. Its validator is the identity function, so it is
 *     "no runtime validator" and we ignore it (`isTypeSchema`).
 *   - XState stores an event payload schema per event *type*, without the `type`
 *     discriminant. `eventSchema` adapts that map into one Standard Schema over
 *     the whole `{ type, ...payload }` event.
 *
 * `contract` in `MachineObjectOptions` still wins when present; these are only
 * the defaults (see object.ts).
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
 */
function eventSchema<E>(
  events: Readonly<Record<string, StandardSchemaV1>>,
): StandardSchema<E> {
  const allowed = Object.keys(events);
  return {
    "~standard": {
      version: 1,
      vendor: "restate.xstate.events",
      validate: (value: unknown): StandardSchemaResult<E> => {
        const type = eventType(value);
        if (type === undefined) {
          return issue(
            "A machine event must be an object with a non-empty string 'type'.",
          );
        }

        const payloadSchema = events[type];
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
      },
    },
  };
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
