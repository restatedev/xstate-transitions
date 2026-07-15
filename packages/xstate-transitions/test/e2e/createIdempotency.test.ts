/*
 * Calling create() again clears the instance's runtime bookkeeping, runs the
 * initial transition, and replaces its snapshot. This test makes the reset
 * semantics explicit.
 */

import { expect, it } from "vitest";
import { assign, createMachine } from "xstate";
import { describeE2E } from "./harness";

const counter = createMachine({
  types: {} as { context: { count: number } },
  id: "recreate-counter",
  context: { count: 0 },
  initial: "idle",
  states: {
    idle: {
      on: {
        inc: { actions: assign({ count: ({ context }) => context.count + 1 }) },
      },
    },
  },
});

describeE2E("create() idempotency / re-create", (createActor) => {
  it(
    "re-creating resets the machine to its initial snapshot",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        context: { count: number };
        value?: string;
      }>({ machine: counter });

      await actor.send({ type: "inc" });
      await actor.send({ type: "inc" });
      expect((await actor.snapshot()).context.count).toBe(2);

      await actor.create();

      const snap = await actor.snapshot();
      expect(snap.context.count).toBe(0);
      expect(snap.value).toBe("idle");
    },
  );
});
