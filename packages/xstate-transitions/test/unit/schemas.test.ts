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
  genericEventSchema,
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

  it("emits a discriminated JSON Schema so events surface in discovery", () => {
    // A payload schema that carries the Standard JSON Schema extension (Zod-like).
    const withJsonSchema = <T>(): StandardSchema<T> =>
      ({
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (v: unknown) => ({ value: v as T }),
          jsonSchema: {
            output: () => ({
              type: "object",
              properties: { amount: { type: "number" } },
              required: ["amount"],
            }),
          },
        },
      }) as unknown as StandardSchema<T>;

    const machine = setup({
      schemas: { events: { DEPOSIT: withJsonSchema(), CLOSE: emptySchema } },
    }).createMachine({ id: "m", initial: "a", states: { a: {} } });

    const std = deriveEventSchema(machine)!["~standard"] as {
      jsonSchema?: {
        output: (o: { target: string }) => {
          anyOf: Array<{
            properties?: Record<string, unknown>;
            required?: string[];
          }>;
        };
      };
    };
    expect(typeof std.jsonSchema?.output).toBe("function");

    const json = std.jsonSchema!.output({ target: "draft-2020-12" });
    expect(json.anyOf).toHaveLength(2);

    const branchFor = (type: string) =>
      json.anyOf.find(
        (b) =>
          (b.properties?.type as { const?: string } | undefined)?.const ===
          type,
      );

    // DEPOSIT carries its payload schema, with `type` injected as a discriminant.
    const deposit = branchFor("DEPOSIT");
    expect(deposit?.properties?.amount).toEqual({ type: "number" });
    expect(deposit?.required).toEqual(
      expect.arrayContaining(["type", "amount"]),
    );

    // CLOSE has no JSON Schema, so it falls back to a bare `type` discriminant.
    expect(branchFor("CLOSE")?.required).toEqual(["type"]);
  });

  it("rejects (does not throw on) a type naming an inherited prototype member", () => {
    const schema = deriveEventSchema(machine())!;
    for (const type of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
    ]) {
      const result = run(schema, { type });
      expect(result.issues, `type=${type}`).toBeDefined();
      expect(result.issues?.[0]?.message).toMatch(/Unknown event type/);
    }
  });

  it("degrades a payload with $defs/$ref to a valid discriminant branch", () => {
    // A recursive/reused payload emits document-root-relative $refs; inlining
    // would dangle them, so the branch must degrade rather than emit invalid JSON.
    const recursive = <T>(): StandardSchema<T> =>
      ({
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (v: unknown) => ({ value: v as T }),
          jsonSchema: {
            output: () => ({
              type: "object",
              $defs: { Node: { type: "object" } },
              properties: { child: { $ref: "#/$defs/Node" } },
              required: ["child"],
            }),
          },
        },
      }) as unknown as StandardSchema<T>;

    const m = setup({
      schemas: { events: { TREE: recursive() } },
    }).createMachine({ id: "m", initial: "a", states: { a: {} } });

    const std = deriveEventSchema(m)!["~standard"] as {
      jsonSchema?: {
        output: (o: { target: string }) => {
          anyOf: Array<Record<string, unknown>>;
        };
      };
    };
    const json = std.jsonSchema!.output({ target: "draft-2020-12" });
    expect(json.anyOf[0]).toEqual({
      type: "object",
      properties: { type: { const: "TREE" } },
      required: ["type"],
    });
    expect(JSON.stringify(json)).not.toMatch(/\$ref|\$defs/);
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

describe("genericEventSchema (send fallback)", () => {
  const schema = genericEventSchema();

  it("accepts any object with a non-empty string type, unchanged", () => {
    expect(run(schema, { type: "PING", extra: 1 })).toEqual({
      value: { type: "PING", extra: 1 },
    });
  });

  it("rejects values without a valid type", () => {
    expect(run(schema, undefined).issues).toBeDefined();
    expect(run(schema, {}).issues).toBeDefined();
    expect(run(schema, { type: "" }).issues).toBeDefined();
  });

  it("publishes the generic { type, ... } envelope for discovery", () => {
    const std = schema["~standard"] as {
      jsonSchema?: { output: () => Record<string, unknown> };
    };
    expect(std.jsonSchema?.output()).toEqual({
      type: "object",
      properties: { type: { type: "string" } },
      required: ["type"],
    });
  });
});
