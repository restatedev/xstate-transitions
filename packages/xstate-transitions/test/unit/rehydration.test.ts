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
            hist: { type: "history", history: "shallow", target: "one" },
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

  it("keeps a state's input across rehydration", () => {
    // A transition can hand `input` to the state it enters; later transitions
    // out of that state read it. It must survive the JSON round trip between
    // requests, or every later event would see `undefined`.
    const machine = createMachine({
      id: "inputs",
      context: { seen: undefined as unknown },
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "active", input: { n: 42 } } } },
        active: {
          on: {
            READ: ({ input }) => ({
              context: { seen: (input as { n?: number } | undefined)?.n },
            }),
          },
        },
      },
    });
    const step = (stored: StoredState, type: string) =>
      resumeStep(machine, {
        stored: roundTrip(stored),
        event: { type },
        isChild: false,
        knownChildIds: [],
        knownPromiseIds: [],
      });
    const created = initialStep(machine, { isChild: false });
    const active = step(created.nextState, "GO");
    expect(step(active.nextState, "READ").nextState.context).toEqual({
      seen: 42,
    });
  });

  it("never reissues a generated child id after that child stops", () => {
    // XState numbers anonymous children per source and never hands a freed id
    // out again, so a late message from a stopped child cannot be mistaken for
    // its successor. The counters must survive rehydration for that to hold.
    const child = createMachine({ id: "child" });
    const machine = createMachine({
      id: "spawner",
      context: { ref: undefined as unknown },
      on: {
        SPAWN: (_, enq) => ({ context: { ref: enq.spawn(child) } }),
        STOP: ({ context }, enq) => {
          enq.stop(context.ref as never);
          return { context: { ref: undefined } };
        },
      },
    });
    let knownChildIds: string[] = [];
    const step = (stored: StoredState, type: string) => {
      const result = resumeStep(machine, {
        stored: roundTrip(stored),
        event: { type },
        isChild: false,
        knownChildIds,
        knownPromiseIds: [],
      });
      for (const effect of result.effects) {
        if (effect.kind === "startChild") knownChildIds.push(effect.childId);
        if (effect.kind === "stopChild") {
          knownChildIds = knownChildIds.filter((id) => id !== effect.childId);
        }
      }
      return result;
    };
    const created = initialStep(machine, { isChild: false });
    const first = step(created.nextState, "SPAWN");
    const stopped = step(first.nextState, "STOP");
    const second = step(stopped.nextState, "SPAWN");
    const started = (result: { effects: Effect[] }) =>
      byKind(result.effects, "startChild").map(
        (effect) => (effect as Extract<Effect, { kind: "startChild" }>).childId,
      );
    expect(started(first)).toEqual(["child:0"]);
    expect(started(second)).toEqual(["child:1"]);
  });
});
