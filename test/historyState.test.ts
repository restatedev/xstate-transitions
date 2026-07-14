/*
 * Phase 1 — history-safe persistence (integration).
 *
 * Drives a machine with a shallow history state through the real Restate object
 * (create/send/snapshot). Because core.ts now persists historyValue as node ids
 * and rehydrates them, RESUME restores the remembered sub-state across the
 * stateless round-trip.
 */

import { describe, it, expect } from "vitest";
import { createRestateTestActor } from "./runner";
import { createMachine } from "xstate";
import { eventually } from "./eventually.js";

const machine = createMachine({
  id: "hist",
  initial: "main",
  states: {
    main: {
      initial: "one",
      on: { PAUSE: "paused" },
      states: {
        one: { on: { NEXT: "two" } },
        two: {},
        hist: { type: "history", history: "shallow" },
      },
    },
    paused: { on: { RESUME: "#hist.main.hist" } },
  },
});

describe("History state persistence", () => {
  it(
    "restores the remembered sub-state after RESUME",
    { timeout: 60_000 },
    async () => {
      using actor = await createRestateTestActor<{ value?: unknown }>({
        machine,
      });

      await actor.send({ type: "NEXT" }); // main.two
      await actor.send({ type: "PAUSE" }); // -> paused (history = two)
      expect(await actor.snapshot()).toMatchObject({ value: "paused" });

      await actor.send({ type: "RESUME" }); // -> main.hist -> main.two
      await eventually(() => actor.snapshot()).toMatchObject({
        value: { main: "two" },
      });
    },
  );
});
