/*
 * Phase 7 — scheduled-event cancellation (self events).
 *
 * A delayed `raise({...}, { delay, id })` is routed through the `_scheduled`
 * handler guarded by a uuid in the `scheduled` KV. `cancel(id)` removes the
 * entry, so when the delayed delivery fires its guard fails and the event is
 * dropped.
 */

import { describe, it, expect } from "vitest";
import { createRestateTestActor } from "./runner";
import { createMachine, raise, cancel } from "xstate";
import { eventually, wait } from "./eventually.js";

const machine = createMachine({
  id: "cancellable",
  initial: "idle",
  states: {
    idle: {
      on: {
        START_DELAYED: {
          target: "pending",
          actions: raise({ type: "FIRE" }, { delay: 1500, id: "d" }),
        },
      },
    },
    pending: {
      on: {
        CANCEL: { target: "idle", actions: cancel("d") },
        FIRE: "fired",
      },
    },
    fired: { type: "final" },
  },
});

describe("Delayed-event cancellation", () => {
  it(
    "does NOT fire a cancelled delayed raise",
    { timeout: 60_000 },
    async () => {
      using actor = await createRestateTestActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await actor.send({ type: "START_DELAYED" });
      expect(await actor.snapshot()).toMatchObject({ value: "pending" });

      await wait(400);
      await actor.send({ type: "CANCEL" });
      expect(await actor.snapshot()).toMatchObject({ value: "idle" });

      // Wait past the original delay; the cancelled event must never arrive.
      await wait(1600);
      expect(await actor.snapshot()).toMatchObject({ value: "idle" });
    },
  );

  it(
    "DOES fire a non-cancelled delayed raise",
    { timeout: 60_000 },
    async () => {
      using actor = await createRestateTestActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await actor.send({ type: "START_DELAYED" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "fired",
      });
    },
  );
});
