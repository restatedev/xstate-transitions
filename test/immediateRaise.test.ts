/*
 * Phase 0 — behaviour-pinning test.
 *
 * A non-delayed `raise` is drained INSIDE transition()'s macrostep (resolveRaise
 * enqueues it on the internal queue), so by the time core.ts persists the
 * snapshot the machine has already advanced. This means dispatchAction's
 * "do nothing for a zero-delay raise" branch is correct, not a bug. This test
 * locks that: a single send that raises an internal event must settle past both
 * transitions.
 */

import { it } from "vitest";
import { describeE2E } from "./harness";
import { createMachine, raise } from "xstate";
import { eventually } from "./eventually.js";

const machine = createMachine({
  id: "immediate-raise",
  initial: "start",
  states: {
    start: {
      on: {
        BEGIN: { target: "middle", actions: raise({ type: "AUTO" }) },
      },
    },
    middle: { on: { AUTO: "end" } },
    end: { type: "final" },
  },
});

describeE2E("Immediate (zero-delay) raise", (createActor) => {
  it(
    "drains the raised event within a single transition()",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await actor.send({ type: "BEGIN" });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "end",
      });
    },
  );
});
