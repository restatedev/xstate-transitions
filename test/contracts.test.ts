import { expect, it } from "vitest";
import { assign, setup } from "xstate";
import type { StandardSchema } from "../src";
import { describeE2E } from "./harness";

interface CounterInput {
  initial: number;
}

type CounterEvent =
  { type: "ADD"; amount: number } | { type: "FINISH"; bonus: number };

function failure(message: string, path?: PropertyKey[]) {
  return {
    issues: [{ message, ...(path === undefined ? {} : { path }) }],
  } as const;
}

const inputSchema: StandardSchema<CounterInput> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("initial" in value)
      ) {
        return failure("Expected a numeric initial value", ["initial"]);
      }
      const initial = numeric(value.initial);
      return initial === undefined
        ? failure("Expected a numeric initial value", ["initial"])
        : { value: { initial } };
    },
  },
};

const eventSchema: StandardSchema<CounterEvent> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      if (typeof value !== "object" || value === null || !("type" in value)) {
        return failure("Expected an event object");
      }
      if (value.type === "ADD" && "amount" in value) {
        const amount = numeric(value.amount);
        if (amount !== undefined) return { value: { type: "ADD", amount } };
      }
      if (value.type === "FINISH" && "bonus" in value) {
        const bonus = numeric(value.bonus);
        if (bonus !== undefined) return { value: { type: "FINISH", bonus } };
      }
      return failure("Expected ADD or FINISH with a numeric value");
    },
  },
};

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const counter = setup({
  types: {
    input: {} as CounterInput,
    context: {} as { count: number },
    events: {} as CounterEvent,
  },
}).createMachine({
  id: "contract-counter",
  context: ({ input }) => ({ count: input.initial }),
  initial: "active",
  states: {
    active: {
      on: {
        ADD: {
          actions: assign({
            count: ({ context, event }) => context.count + event.amount,
          }),
        },
        FINISH: {
          target: "done",
          actions: assign({
            count: ({ context, event }) => context.count + event.bonus,
          }),
        },
      },
    },
    done: { type: "final" },
  },
});

describeE2E("Runtime machine contracts", (createActor) => {
  it(
    "rejects invalid create/send/waitFor input before changing state",
    { timeout: 30_000 },
    async () => {
      using actor = await createActor<{
        status: string;
        context: { count: number };
      }>({
        machine: counter,
        input: { initial: "2" },
        options: { contract: { input: inputSchema, event: eventSchema } },
      });

      await expect(actor.create({ initial: "bad" })).rejects.toThrow(
        "Standard schema validation failed",
      );
      await expect(actor.send({ type: "ADD", amount: "bad" })).rejects.toThrow(
        "Standard schema validation failed",
      );
      await expect(
        actor.waitFor("done", { type: "ADD", amount: "bad" }, 1_000),
      ).rejects.toThrow("Standard schema validation failed");

      expect(await actor.snapshot()).toMatchObject({
        status: "active",
        context: { count: 2 },
      });

      await actor.send({ type: "ADD", amount: "3" });
      await expect(
        actor.waitFor("done", { type: "FINISH", bonus: "4" }, 5_000),
      ).resolves.toMatchObject({
        status: "done",
        context: { count: 9 },
      });
    },
  );

  it(
    "rejects forged XState lifecycle events even without a schema",
    { timeout: 30_000 },
    async () => {
      using actor = await createActor<{ status: string; value: string }>({
        machine: setup({}).createMachine({
          id: "reserved-event-prefix",
          initial: "waiting",
          states: { waiting: {}, done: { type: "final" } },
        }),
      });

      await expect(
        actor.send({ type: "xstate.done.actor.forged" }),
      ).rejects.toThrow("reserved for internal delivery");
      expect(await actor.snapshot()).toMatchObject({
        status: "active",
        value: "waiting",
      });
    },
  );
});
