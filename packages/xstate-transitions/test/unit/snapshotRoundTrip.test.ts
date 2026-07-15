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
 * The Restate object persists a serializable form of the snapshot and
 * rehydrates it before every transition. These pure tests lock that contract.
 *
 * They also show why the raw snapshot cannot be persisted naively: its
 * `historyValue` holds live StateNode instances that do not survive JSON, which
 * would silently break history states. `toStored`/`fromStored` serialize that
 * value as node IDs, as proven by the last test.
 */

import { describe, expect, it } from "vitest";
import {
  type AnyMachineSnapshot,
  createMachine,
  initialTransition,
  transition,
} from "xstate";
import { fromStored, toStored } from "../../src/xstate/snapshot";

// Emulate what Restate does to the snapshot between handler invocations.
function roundTrip<T>(snapshot: T): T {
  return JSON.parse(JSON.stringify(snapshot)) as T;
}

describe("Snapshot round-trip (stateless rehydration contract)", () => {
  it("preserves value, context and status across JSON + resolveState", () => {
    const counter = createMachine({
      id: "counter",
      context: { count: 0 },
      initial: "idle",
      states: {
        idle: {
          on: {
            inc: ({ context }) => ({ context: { count: context.count + 1 } }),
            finish: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    });

    // Rehydrate from the persisted snapshot before each step, like the object.
    let [snapshot] = initialTransition(counter);
    expect((snapshot as AnyMachineSnapshot).value).toBe("idle");

    for (const event of [
      { type: "inc" },
      { type: "inc" },
      { type: "finish" },
    ]) {
      const rehydrated = counter.resolveState(roundTrip(snapshot) as never);
      [snapshot] = transition(counter, rehydrated, event as never);
    }

    const settled = snapshot as AnyMachineSnapshot;
    expect(settled.value).toBe("done");
    expect(settled.status).toBe("done");
    expect(settled.context).toMatchObject({ count: 2 });
  });

  const historyMachine = () =>
    createMachine({
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
        paused: {
          on: { RESUME: { target: "#hist.main.hist" } },
        },
      },
    });

  it("history resolves correctly WITHOUT the round-trip (live snapshot)", () => {
    const machine = historyMachine();
    let [s] = initialTransition(machine);
    [s] = transition(machine, s, { type: "NEXT" } as never); // main.two
    [s] = transition(machine, s, { type: "PAUSE" } as never); // records history
    [s] = transition(machine, s, { type: "RESUME" } as never); // -> main.two
    expect((s as AnyMachineSnapshot).value).toEqual({ main: "two" });
  });

  it("a NAIVE raw JSON round-trip is unusable for history (motivates toStored/fromStored)", () => {
    // Root cause: once a history state records a value, the raw snapshot's
    // `historyValue` holds live StateNode instances whose `parent` links form a
    // cycle, so a naive JSON.stringify of the raw snapshot throws. (In XState v5
    // it silently degraded to the initial sub-state; v6 fails loudly.) Either
    // way the raw snapshot cannot be persisted directly — which is exactly why
    // the integration serializes via toStored/fromStored (node ids) instead, as
    // the next test shows.
    const machine = historyMachine();
    const step = (snap: unknown, event: { type: string }) =>
      transition(
        machine,
        machine.resolveState(roundTrip(snap) as never),
        event as never,
      )[0];

    let [snapshot] = initialTransition(machine);
    snapshot = step(snapshot, { type: "NEXT" }); // main.two
    snapshot = step(snapshot, { type: "PAUSE" }); // records history at main.two

    // The next naive round-trip fails on the circular recorded historyValue.
    expect(() => step(snapshot, { type: "RESUME" })).toThrow(/circular/i);
  });

  it("history state survives the history-safe persistence helpers", () => {
    // The integration does not persist the raw snapshot; it uses toStored/fromStored,
    // which serialize historyValue as node ids and rehydrate them. This is the
    // fix for the limitation documented above.
    const machine = historyMachine();
    const persist = (snap: AnyMachineSnapshot) =>
      JSON.parse(JSON.stringify(toStored(snap))); // emulate Restate JSON KV
    const step = (stored: unknown, event: { type: string }) =>
      transition(
        machine,
        fromStored(machine, stored as ReturnType<typeof toStored>),
        event as never,
      )[0] as AnyMachineSnapshot;

    let snapshot: AnyMachineSnapshot = initialTransition(machine)[0];
    let stored = persist(snapshot);
    for (const type of ["NEXT", "PAUSE", "RESUME"]) {
      snapshot = step(stored, { type });
      stored = persist(snapshot);
    }
    expect(snapshot.value).toEqual({ main: "two" });
  });
});
