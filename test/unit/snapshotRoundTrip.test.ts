/*
 * Phase 0/1 — behaviour-pinning tests (pure, no Restate container).
 *
 * xstate-transitions is stateless between requests: core.ts persists a
 * serializable form of the snapshot under the KV key "state" and rehydrates it
 * before every `transition(...)`. These tests lock that contract.
 *
 * They also show WHY core.ts must not persist the raw snapshot naively: the raw
 * `historyValue` holds live StateNode instances that do not survive JSON, which
 * would silently break history states. core.ts avoids this by serializing
 * historyValue as node ids (toStored/fromStored) — proven by the last test.
 */

import { describe, it, expect } from "vitest";
import {
  assign,
  createMachine,
  initialTransition,
  transition,
  type AnyMachineSnapshot,
} from "xstate";
import { toStored, fromStored } from "../../src/xstate/snapshot";

// Emulate what Restate does to the snapshot between handler invocations.
function roundTrip<T>(snapshot: T): T {
  return JSON.parse(JSON.stringify(snapshot)) as T;
}

describe("Snapshot round-trip (stateless rehydration contract)", () => {
  it("preserves value, context and status across JSON + resolveState", () => {
    const counter = createMachine({
      types: {} as { context: { count: number } },
      id: "counter",
      context: { count: 0 },
      initial: "idle",
      states: {
        idle: {
          on: {
            inc: {
              actions: assign({ count: ({ context }) => context.count + 1 }),
            },
            finish: "done",
          },
        },
        done: { type: "final" },
      },
    });

    // Drive it the way core.ts does: rehydrate from the persisted snapshot each step.
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
          on: { PAUSE: "paused" },
          states: {
            one: { on: { NEXT: "two" } },
            two: {},
            hist: { type: "history", history: "shallow" },
          },
        },
        paused: {
          on: { RESUME: "#hist.main.hist" },
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

  it("a NAIVE raw JSON round-trip loses history (motivates toStored/fromStored)", () => {
    // Root cause: the raw snapshot's `historyValue` holds live StateNode
    // instances; JSON.stringify turns them into plain objects, so `transition`
    // can no longer resolve the history target and falls back to the initial
    // sub-state. This is exactly why core.ts does NOT round-trip the raw
    // snapshot; the next test shows the history-safe helpers it uses instead.
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
    snapshot = step(snapshot, { type: "RESUME" });

    // Documents the CURRENT (buggy) behaviour: history is not restored.
    expect((snapshot as AnyMachineSnapshot).value).toEqual({ main: "one" });
  });

  it("history state survives core.ts's history-safe persistence helpers", () => {
    // core.ts does NOT persist the raw snapshot; it uses toStored/fromStored,
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

    let [snapshot] = initialTransition(machine);
    let stored = persist(snapshot as AnyMachineSnapshot);
    for (const type of ["NEXT", "PAUSE", "RESUME"]) {
      snapshot = step(stored, { type });
      stored = persist(snapshot);
    }
    expect(snapshot.value).toEqual({ main: "two" });
  });
});
