/*
 * GAP TEST (scaffold, todo) — BLOCKED BY: Phase 4 "Restate-aware fromPromise (ctx)"
 * + Phase 3/6 runner.waitFor + runner second test-env-options arg.
 *
 * Target behaviour: a promise actor reads the deterministic Restate clock via
 * ctx.date.now(); a native Date.now() captured in an assign is stable across
 * replays; the machine reaches "done".
 *
 * Un-skip when: fromPromise passes ctx, the runner exposes waitFor(condition),
 * and createRestateTestActor accepts a second { alwaysReplay, disableRetries } arg.
 */

import { describe, it, expect } from "vitest";
import { createRestateTestActor } from "./runner";
import { fromPromise } from "../src";
import { assign, setup } from "xstate";

let submittedAt = -1;
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
          actions: assign({
            submittedAt: () => {
              const date = Date.now();
              if (submittedAt < 0) submittedAt = date;
              return date;
            },
          }),
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

describe("Date machine", () => {
  it(
    "Should capture native and Restate dates",
    { timeout: 20_000 },
    async () => {
      using machine = await createRestateTestActor<{
        context: { submittedAt: number; restateDate: number };
      }>({ machine: dateMachine });

      const snap = await machine.waitFor("done", { type: "submit" });

      expect(snap.context.submittedAt).toBe(submittedAt);
      expect(snap.context.restateDate).toBeGreaterThanOrEqual(submittedAt);
    },
  );
});
