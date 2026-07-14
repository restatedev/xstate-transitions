/*
 * Phase 0 — behaviour-pinning test.
 *
 * A single macrostep that enters two invokes (here, two parallel regions)
 * dispatches two `xstate.spawnChild` actions that run concurrently through the
 * shared `_execute` handler. Both done events must feed back and their context
 * assignments must merge. This locks the shared-handler fan-out + merge.
 */

import { describe, it } from "vitest";
import { createRestateTestActor } from "./runner";
import { assign, fromPromise, setup } from "xstate";
import { eventually } from "./eventually.js";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const machine = setup({
  types: {} as { context: { a: string | null; b: string | null } },
  actors: {
    actorA: fromPromise(async () => {
      await delay(20);
      return "A";
    }),
    actorB: fromPromise(async () => {
      await delay(20);
      return "B";
    }),
  },
}).createMachine({
  id: "concurrent-invokes",
  type: "parallel",
  context: { a: null, b: null },
  states: {
    ra: {
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "actorA",
            onDone: {
              target: "done",
              actions: assign({ a: ({ event }) => event.output as string }),
            },
          },
        },
        done: { type: "final" },
      },
    },
    rb: {
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "actorB",
            onDone: {
              target: "done",
              actions: assign({ b: ({ event }) => event.output as string }),
            },
          },
        },
        done: { type: "final" },
      },
    },
  },
});

describe("Concurrent invokes from parallel regions", () => {
  it(
    "runs both invokes concurrently and merges both results",
    { timeout: 60_000 },
    async () => {
      using actor = await createRestateTestActor<{
        status?: string;
        context: { a: string | null; b: string | null };
      }>({ machine });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        context: { a: "A", b: "B" },
      });
    },
  );
});
