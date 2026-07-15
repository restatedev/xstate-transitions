/*
 * Delayed calls cannot be physically recalled from Restate. The integration
 * therefore guards every delivery with a durable UUID. These tests make stale
 * deliveries arrive after replacement/reset and assert that they are ignored.
 */

import { expect, it } from "vitest";
import { assign, sendTo, setup } from "xstate";
import { eventually, wait } from "./eventually.js";
import { describeE2E } from "./harness";

const timerMachine = setup({
  types: {
    context: {} as { fired: string[] },
    events: {} as
      | { type: "SCHEDULE"; value: string; delay: number }
      | { type: "FIRED"; value: string },
  },
}).createMachine({
  id: "scheduled-generation",
  context: { fired: [] },
  on: {
    SCHEDULE: {
      actions: sendTo(
        ({ self }) => self,
        ({ event }) => ({ type: "FIRED", value: event.value }),
        { id: "slot", delay: ({ event }) => event.delay },
      ),
    },
    FIRED: {
      actions: assign({
        fired: ({ context, event }) => [...context.fired, event.value],
      }),
    },
  },
});

describeE2E("Scheduled-event generations", (createActor) => {
  it(
    "accepts only the newest delivery after replacing the same send id",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{ context: { fired: string[] } }>({
        machine: timerMachine,
      });

      await actor.send({ type: "SCHEDULE", value: "old", delay: 500 });
      await actor.send({ type: "SCHEDULE", value: "new", delay: 50 });

      await eventually(() => actor.snapshot()).toMatchObject({
        context: { fired: ["new"] },
      });
      await wait(600);
      expect((await actor.snapshot()).context.fired).toEqual(["new"]);
    },
  );

  it(
    "drops a delayed delivery belonging to the instance before create",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{ context: { fired: string[] } }>({
        machine: timerMachine,
      });

      await actor.send({ type: "SCHEDULE", value: "stale", delay: 250 });
      await actor.create();
      await wait(400);

      expect((await actor.snapshot()).context.fired).toEqual([]);
    },
  );
});
