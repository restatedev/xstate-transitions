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
 * End-to-end proof that `createMachineObject` derives its ingress serdes from a
 * machine's own v6 `schemas`: real Standard Schemas on `schemas.input` /
 * `schemas.events` validate and coerce the public boundary.
 */

import { expect, it } from "vitest";
import { setup, types } from "xstate";
import type { StandardSchema } from "../../src";
import type { StandardSchemaResult } from "../../src/restate/types";
import { describeE2E } from "./harness";

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// A coercing Standard Schema carrying its inferred output type, so the machine
// is fully typed from `schemas` alone (like Zod/Valibot would be).
function coercing<T>(
  validate: (value: unknown) => StandardSchemaResult<T>,
): StandardSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
      types: { input: undefined as unknown, output: undefined as unknown as T },
    },
  };
}

const initialSchema = coercing<{ initial: number }>((value) => {
  const initial =
    typeof value === "object" && value !== null
      ? numeric((value as { initial: unknown }).initial)
      : undefined;
  return initial === undefined
    ? { issues: [{ message: "Expected a numeric initial" }] }
    : { value: { initial } };
});

const amountSchema = coercing<{ amount: number }>((value) => {
  const amount =
    typeof value === "object" && value !== null
      ? numeric((value as { amount: unknown }).amount)
      : undefined;
  return amount === undefined
    ? { issues: [{ message: "Expected a numeric amount" }] }
    : { value: { amount } };
});

const counter = setup({
  schemas: {
    input: initialSchema,
    context: types<{ count: number }>(),
    events: { ADD: amountSchema },
  },
}).createMachine({
  id: "derived-counter",
  context: ({ input }) => ({ count: input.initial }),
  initial: "active",
  states: {
    active: {
      on: {
        ADD: ({ context, event }) => ({
          context: { count: context.count + event.amount },
        }),
      },
    },
  },
});

describeE2E("Serdes derived from machine.schemas", (createActor) => {
  it(
    "coerces input and events and rejects invalid ones, from schemas alone",
    { timeout: 30_000 },
    async () => {
      using actor = await createActor<
        { status: string; context: { count: number } },
        typeof counter
      >({
        machine: counter,
        // Auto-created with this input; the derived input serde coerces "2" -> 2.
        input: { initial: "2" },
      });

      expect(await actor.snapshot()).toMatchObject({ context: { count: 2 } });

      // Derived event serde coerces the payload: "3" -> 3.
      await actor.send({ type: "ADD", amount: "3" });
      expect(await actor.snapshot()).toMatchObject({ context: { count: 5 } });

      // Unknown event type is rejected by the discriminated-event adapter.
      await expect(actor.send({ type: "BOGUS" })).rejects.toThrow(
        /Unknown event type/,
      );

      // Invalid payload for a known type is rejected.
      await expect(
        actor.send({ type: "ADD", amount: "not-a-number" }),
      ).rejects.toThrow("Standard schema validation failed");

      // State is unchanged by the rejected sends.
      expect(await actor.snapshot()).toMatchObject({ context: { count: 5 } });
    },
  );
});
