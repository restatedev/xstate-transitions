/*
 * Copyright (c) 2025-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

/*
 * Rehydration contracts, adapted from upstream xstate `rehydration.v6.test.ts`.
 *
 * Rehydration is the heart of this integration: the object rehydrates the
 * persisted snapshot before EVERY request. Two guarantees must hold or the model
 * breaks: (1) rehydrating and resuming must not replay effects from an earlier
 * step (or every read would re-fire sends/promises/delayed sends), and (2) a
 * stored value that no longer fits the machine (definition drift across deploys,
 * or a corrupted KV entry) must fail loudly rather than silently resetting to
 * initial — a silent reset would be data corruption.
 */

import { describe, expect, it } from "vitest";
import { createMachine, initialTransition, transition } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import { fromStored, toStored } from "../../src/xstate/snapshot";
import type { Effect, StoredState } from "../../src/xstate/types";

const byKind = (effects: Effect[], kind: Effect["kind"]) =>
  effects.filter((effect) => effect.kind === kind);

const roundTrip = (stored: StoredState): StoredState =>
  JSON.parse(JSON.stringify(stored)) as StoredState;

describe("rehydration", () => {
  it("does not replay a prior entry effect on a later rehydrated resume", () => {
    // The initial `entry` schedules a delayed self-send. That effect must be
    // emitted exactly once, at creation — not again when a later request
    // rehydrates the (unchanged) state and applies an unrelated event.
    const machine = createMachine({
      id: "m",
      initial: "a",
      states: {
        a: {
          entry: ({ self }, enq) => {
            enq.sendTo(self, { type: "PING" }, { delay: 1000, id: "p" });
          },
          on: { NOOP: () => undefined },
        },
      },
    });

    const created = initialStep(machine, { isChild: false });
    expect(byKind(created.effects, "scheduleSend")).toHaveLength(1);

    const resumed = resumeStep(machine, {
      stored: roundTrip(created.nextState),
      event: { type: "NOOP" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    // The entry-derived schedule is NOT re-emitted on the rehydrated step.
    expect(resumed.effects).toEqual([]);
  });

  it("rejects an incompatible stored value (shallow)", () => {
    const machine = createMachine({
      id: "m",
      initial: "green",
      states: { green: {}, red: {} },
    });
    const stored: StoredState = {
      value: "chartreuse",
      context: {},
      status: "active",
      historyValue: {},
    };
    expect(() => fromStored(machine, stored)).toThrow(/does not exist/i);
  });

  it("rejects an incompatible stored value (deep)", () => {
    const machine = createMachine({
      id: "m",
      initial: "outer",
      states: {
        outer: { initial: "inner", states: { inner: {} } },
      },
    });
    const stored: StoredState = {
      value: { outer: "nonexistent" },
      context: {},
      status: "active",
      historyValue: {},
    };
    expect(() => fromStored(machine, stored)).toThrow(/does not exist/i);
  });

  it("fails loudly when a stored history value references an unresolvable node id", () => {
    // A snapshot written by an older machine version (a history sub-state
    // renamed/removed between deploys) can carry a node id that no longer
    // resolves. We deliberately fail loudly here — consistent with the "v6 fails
    // loudly" contract documented in snapshotRoundTrip.test.ts — rather than
    // silently degrading to the default sub-state, so version drift surfaces
    // instead of corrupting state. (If graceful degradation is ever desired,
    // deserializeHistory is the single place to change, and this test pins the
    // current contract.)
    const machine = createMachine({
      id: "hist",
      initial: "main",
      states: {
        main: {
          initial: "one",
          on: { PAUSE: { target: "paused" } },
          states: {
            one: { on: { NEXT: { target: "two" } } },
            two: {},
            hist: { type: "history", history: "shallow" },
          },
        },
        paused: { on: { RESUME: { target: "#hist.main.hist" } } },
      },
    });

    let snapshot = initialTransition(machine)[0];
    snapshot = transition(machine, snapshot, { type: "NEXT" } as never)[0];
    snapshot = transition(machine, snapshot, { type: "PAUSE" } as never)[0];

    const stored = toStored(snapshot);
    expect(Object.keys(stored.historyValue).length).toBeGreaterThan(0);

    const corrupted: StoredState = {
      ...stored,
      historyValue: Object.fromEntries(
        Object.entries(stored.historyValue).map(([key]) => [
          key,
          ["nonexistent-node-id"],
        ]),
      ),
    };
    expect(() => fromStored(machine, corrupted)).toThrow();
  });
});
