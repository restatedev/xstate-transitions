/*
 * GAP TEST (scaffold, todo) — BLOCKED BY: Phase 2 "finalStateTTL + disposal".
 *
 * Target behaviour:
 *  (1) no finalStateTTL  -> instance & snapshot persist after reaching a final state;
 *  (2) finalStateTTL set -> after the TTL the instance is disposed; snapshot()/send()
 *      reject with 410 "The state machine has been disposed after reaching it's final state";
 *  (3) a machine final-on-entry is also disposed after the TTL.
 *
 * Un-skip when: MachineObjectOptions gains `finalStateTTL?`, core.ts schedules a
 * delayed `cleanupState` self-send when the settled snapshot.status === "done",
 * and send/snapshot guard on a persisted `disposed` flag (410). Requires a runner
 * that forwards machine options (see the `options` field used below).
 */

import { createMachine } from "xstate";
import { describe, it, expect, vi } from "vitest";
import { createRestateTestActor } from "./runner";
import { wait } from "./eventually.js";

const lifeCycleTrackerMachine = createMachine({
  id: "task",
  initial: "idle",
  states: {
    idle: { on: { START: "inProgress" } },
    inProgress: { on: { COMPLETE: "done" } },
    done: { type: "final" },
  },
});

describe("Cleanup", () => {
  it(
    "Should not cleanup if finalStateTTL is not set",
    { timeout: 20_000 },
    async () => {
      using machine = await createRestateTestActor({
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

  it(
    "Should cleanup if finalStateTTL is set",
    { timeout: 20_000 },
    async () => {
      using machine = await createRestateTestActor({
        machine: lifeCycleTrackerMachine,
        options: { finalStateTTL: 100 },
      });
      await machine.send({ type: "START" });
      await machine.send({ type: "COMPLETE" });
      await vi.waitFor(
        () =>
          expect(() => machine.snapshot()).rejects.toThrow(
            "The state machine has been disposed after reaching it's final state",
          ),
        { timeout: 5_000 },
      );
      await expect(() => machine.send({ type: "START" })).rejects.toThrow(
        "The state machine has been disposed after reaching it's final state",
      );
    },
  );

  it(
    "Should cleanup if on entry reaches final state",
    { timeout: 20_000 },
    async () => {
      using machine = await createRestateTestActor({
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
            "The state machine has been disposed after reaching it's final state",
          ),
        { timeout: 5_000 },
      );
    },
  );
});
