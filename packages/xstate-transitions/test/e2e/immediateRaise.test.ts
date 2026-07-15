/*
 * A non-delayed `raise` is drained INSIDE transition()'s macrostep (resolveRaise
 * enqueues it on the internal queue), so the snapshot is already advanced when
 * the object persists it. No Restate delivery is needed: one public event must
 * settle past both transitions.
 */

import { it } from "vitest";
import { createMachine, raise } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

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
