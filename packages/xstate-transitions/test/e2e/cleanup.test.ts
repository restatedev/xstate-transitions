/*
 * Final-state cleanup is opt-in. Once its TTL expires, the machine instance is
 * disposed and can no longer accept events or return a snapshot.
 */

import { expect, it, vi } from "vitest";
import { createMachine } from "xstate";
import { wait } from "./eventually.js";
import { describeE2E } from "./harness";

const lifeCycleTrackerMachine = createMachine({
  id: "task",
  initial: "idle",
  states: {
    idle: { on: { START: "inProgress" } },
    inProgress: { on: { COMPLETE: "done" } },
    done: { type: "final" },
  },
});

describeE2E("Cleanup", (createActor) => {
  it(
    "does not clean up when finalStateTTL is not set",
    { timeout: 20_000 },
    async () => {
      using machine = await createActor({
        machine: lifeCycleTrackerMachine,
      });
      await machine.send({ type: "START" });
      await machine.send({ type: "COMPLETE" });
      expect(await machine.snapshot()).toMatchObject({
        status: "done",
        value: "done",
      });
      await wait(100);
      expect(await machine.snapshot()).toMatchObject({
        status: "done",
        value: "done",
      });
    },
  );

  it("cleans up when finalStateTTL is set", { timeout: 20_000 }, async () => {
    using machine = await createActor({
      machine: lifeCycleTrackerMachine,
      options: { finalStateTTL: 100 },
    });
    await machine.send({ type: "START" });
    await machine.send({ type: "COMPLETE" });
    await vi.waitFor(
      () =>
        expect(() => machine.snapshot()).rejects.toThrow(
          "The state machine was disposed after reaching its final state.",
        ),
      { timeout: 5_000 },
    );
    await expect(() => machine.send({ type: "START" })).rejects.toThrow(
      "The state machine was disposed after reaching its final state.",
    );
  });

  it(
    "cleans up a machine that reaches its final state on entry",
    { timeout: 20_000 },
    async () => {
      using machine = await createActor({
        machine: createMachine({
          id: "task",
          initial: "done",
          states: { done: { type: "final" } },
        }),
        options: { finalStateTTL: 100 },
      });
      await vi.waitFor(
        () =>
          expect(() => machine.snapshot()).rejects.toThrow(
            "The state machine was disposed after reaching its final state.",
          ),
        { timeout: 5_000 },
      );
    },
  );

  it(
    "does not let an old final-state TTL dispose a recreated instance",
    { timeout: 20_000 },
    async () => {
      using machine = await createActor({
        machine: lifeCycleTrackerMachine,
        options: { finalStateTTL: 500 },
      });

      await machine.send({ type: "START" });
      await machine.send({ type: "COMPLETE" });
      await machine.create();
      expect(await machine.snapshot()).toMatchObject({
        status: "active",
        value: "idle",
      });

      await wait(750);
      expect(await machine.snapshot()).toMatchObject({
        status: "active",
        value: "idle",
      });
    },
  );
});
