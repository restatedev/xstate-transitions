/*
 * Phase 0 — behaviour-pinning test.
 *
 * Pins the CURRENT semantics of calling create() again on an existing instance:
 * core.ts's create runs initialTransition and overwrites the "state" KV
 * unconditionally, so a second create resets the machine to its initial
 * snapshot. This is documented here so a later disposal/guard change is a
 * deliberate decision, not an accident.
 */

import { it, expect } from "vitest";
import { describeE2E } from "./harness";
import { assign, createMachine } from "xstate";

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
