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
 * Pure tests for deriving Restate ingress serdes from a machine's v6 `schemas`.
 * `types<T>()` is type-only and must be ignored; real Standard Schemas drive
 * input validation and a discriminated-event adapter.
 */

import { describe, expect, it } from "vitest";
import { createMachine, setup, types } from "xstate";
import type { StandardSchema } from "../../src";
import type { StandardSchemaResult } from "../../src/restate/types";
import {
  deriveEventSchema,
  deriveInputSchema,
} from "../../src/restate/schemas";

// A tiny coercing Standard Schema: { amount } -> { amount: number }.
const amountSchema: StandardSchema<{ amount: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      if (typeof value !== "object" || value === null || !("amount" in value)) {
        return { issues: [{ message: "amount required" }] };
      }
      const amount = Number((value as { amount: unknown }).amount);
      return Number.isFinite(amount)
        ? { value: { amount } }
        : { issues: [{ message: "amount must be numeric" }] };
    },
  },
};

const emptySchema: StandardSchema<Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => ({ value: {} }),
  },
};

const asyncSchema: StandardSchema<unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => Promise.resolve({ value: {} }),
  },
};

const run = <T>(
  schema: StandardSchema<T>,
  value: unknown,
): StandardSchemaResult<T> =>
  schema["~standard"].validate(value) as StandardSchemaResult<T>;

describe("deriveInputSchema", () => {
  it("returns the input schema when it is a real validator", () => {
    const machine = setup({
      schemas: { input: amountSchema, context: types<{ amount: number }>() },
    }).createMachine({
      id: "m",
      context: ({ input }) => ({ amount: input.amount }),
    });

    const schema = deriveInputSchema(machine);
    expect(schema).toBeDefined();
    expect(run(schema!, { amount: "42" })).toEqual({ value: { amount: 42 } });
  });

  it("ignores a type-only input schema (types<T>())", () => {
    const machine = setup({
      schemas: { input: types<{ amount: number }>() },
    }).createMachine({ id: "m" });
    expect(deriveInputSchema(machine)).toBeUndefined();
  });

  it("returns undefined when the machine declares no schemas", () => {
    const machine = createMachine({ id: "m" });
    expect(deriveInputSchema(machine)).toBeUndefined();
  });
});

describe("deriveEventSchema", () => {
  const machine = () =>
    setup({
      schemas: {
        events: { DEPOSIT: amountSchema, CLOSE: emptySchema },
      },
    }).createMachine({ id: "m", initial: "a", states: { a: {} } });

  it("validates a known event and coerces its payload, reattaching type", () => {
    const schema = deriveEventSchema(machine())!;
    expect(schema).toBeDefined();
    expect(run(schema, { type: "DEPOSIT", amount: "42" })).toEqual({
      value: { type: "DEPOSIT", amount: 42 },
    });
    expect(run(schema, { type: "CLOSE" })).toEqual({
      value: { type: "CLOSE" },
    });
  });

  it("rejects an unknown event type", () => {
    const result = run(deriveEventSchema(machine())!, { type: "BOGUS" });
    expect(result.issues?.[0]?.message).toMatch(/Unknown event type "BOGUS"/);
  });

  it("rejects a payload that fails its event schema", () => {
    const result = run(deriveEventSchema(machine())!, {
      type: "DEPOSIT",
      amount: "not-a-number",
    });
    expect(result.issues?.[0]?.message).toMatch(/numeric/);
  });

  it("rejects a value that is not a well-formed event", () => {
    const schema = deriveEventSchema(machine())!;
    expect(run(schema, undefined).issues).toBeDefined();
    expect(run(schema, { nope: true }).issues).toBeDefined();
    expect(run(schema, { type: "" }).issues).toBeDefined();
  });

  it("rejects an asynchronous event validator instead of hanging", () => {
    const schema = deriveEventSchema(
      setup({ schemas: { events: { GO: asyncSchema } } }).createMachine({
        id: "m",
      }),
    )!;
    expect(run(schema, { type: "GO" }).issues?.[0]?.message).toMatch(
      /synchronous|Asynchronous/i,
    );
  });

  it("stays permissive when every event schema is type-only", () => {
    const machine = setup({
      schemas: {
        events: {
          A: types<{ x: number }>(),
          B: types<Record<string, never>>(),
        },
      },
    }).createMachine({ id: "m" });
    expect(deriveEventSchema(machine)).toBeUndefined();
  });

  it("returns undefined when there are no event schemas", () => {
    expect(deriveEventSchema(createMachine({ id: "m" }))).toBeUndefined();
  });
});
