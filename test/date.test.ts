/*
 * A promise actor reads the deterministic Restate clock via ctx.date.now(), and
 * a native Date.now() captured in a transition `assign` lands in context. Runs
 * under both replay modes; see dateTransition.test.ts for the explicit
 * replay-stability assertion on the transition timestamp.
 */

import { expect, it } from "vitest";
import { assign, setup } from "xstate";
import { fromPromise } from "../src";
import { describeE2E } from "./harness";

const dateMachine = setup({
  actors: {
    getCurrentDate: fromPromise(async ({ ctx }) => ctx.date.now()),
  },
}).createMachine({
  id: "date",
  context: { submittedAt: 0, restateDate: 0 },
  initial: "idle",
  states: {
    idle: {
      on: {
        submit: {
          target: "gettingRestateDate",
          actions: assign({ submittedAt: () => Date.now() }),
        },
      },
    },
    gettingRestateDate: {
      invoke: {
        src: "getCurrentDate",
        onDone: {
          target: "done",
          actions: assign({ restateDate: ({ event }) => event.output }),
        },
      },
    },
    done: { type: "final" },
  },
});

describeE2E("Date machine", (createActor) => {
  it(
    "Should capture native and Restate dates",
    { timeout: 20_000 },
    async () => {
      using machine = await createActor<{
        context: { submittedAt: number; restateDate: number };
      }>({ machine: dateMachine });

      const before = Date.now();
      const snap = await machine.waitFor("done", { type: "submit" });
      const after = Date.now();

      // The transition captured a native Date.now() within this call window.
      expect(snap.context.submittedAt).toBeGreaterThanOrEqual(before);
      expect(snap.context.submittedAt).toBeLessThanOrEqual(after);
      // The promise actor captured the Restate clock (ctx.date.now()).
      expect(snap.context.restateDate).toBeGreaterThanOrEqual(
        snap.context.submittedAt,
      );
    },
  );
});
