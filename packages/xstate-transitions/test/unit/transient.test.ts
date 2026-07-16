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
 * Eventless (`always`) transition semantics, ported from upstream xstate
 * `transient.test.ts` into our pure-transition + effect model.
 *
 * These are durability-critical: a macrostep must reach its fixpoint INSIDE one
 * `transition()` call and the *settled* snapshot is what we persist. Rehydration
 * must never resume mid-loop, and any effect enqueued by a self-referential
 * `always` must fire exactly once. Upstream observes effects with `enq(fn)`
 * side-effect closures, which our integration drops; we observe through context
 * patches, the settled value, and the emitted effect list instead.
 */

import { describe, expect, it } from "vitest";
import { createMachine, matchesState, setup, types } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { StoredState } from "../../src/xstate/types";

const roundTrip = (stored: StoredState): StoredState =>
  JSON.parse(JSON.stringify(stored)) as StoredState;

describe("transient (eventless) transitions", () => {
  it("loops a context-only `always` to its fixpoint, settling before persist", () => {
    type Ctx = { count: number };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "counting",
        context: { count: 0 },
        initial: "counting",
        states: {
          counting: {
            always: ({ context }) =>
              context.count < 5
                ? { context: { count: context.count + 1 } }
                : undefined,
          },
        },
      },
    );

    // The whole fixpoint runs inside the initial transition: the persisted
    // snapshot already reads 5, never an intermediate value.
    const created = initialStep(machine, { isChild: false });
    expect((created.nextState.context as Ctx).count).toBe(5);

    // Rehydrating and applying an unrelated event does not resume the loop.
    const resumed = resumeStep(machine, {
      stored: roundTrip(created.nextState),
      event: { type: "NOOP" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect((resumed.nextState.context as Ctx).count).toBe(5);
  });

  it("selects an eventless transition before processing a raised event", () => {
    const machine = createMachine({
      id: "m",
      initial: "a",
      states: {
        a: { on: { FOO: { target: "b" } } },
        b: {
          entry: (_, enq) => {
            enq.raise({ type: "BAR" });
          },
          always: { target: "c" },
          on: { BAR: { target: "d" } },
        },
        c: { on: { BAR: { target: "e" } } },
        d: {},
        e: {},
      },
    });
    const created = initialStep(machine, { isChild: false });
    const result = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "FOO" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    // b's `always` wins over the pending raised BAR (b->c), then c consumes the
    // still-queued BAR (c->e). All inside one macrostep, no effects escape.
    expect(result.nextState.value).toBe("e");
    expect(result.effects).toEqual([]);
  });

  it("does not select a wildcard handler for an eventless transition", () => {
    const machine = createMachine({
      id: "m",
      initial: "a",
      states: {
        a: { on: { FOO: { target: "b" } } },
        b: { always: { target: "pass" }, on: { "*": { target: "fail" } } },
        pass: {},
        fail: {},
      },
    });
    const created = initialStep(machine, { isChild: false });
    const result = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "FOO" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(result.nextState.value).toBe("pass");
  });

  it("resolves the initial state through an initial transient, and re-resolves only on re-entry", () => {
    type Ctx = { hour: number };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "greeting",
        initial: "pending",
        context: { hour: 10 },
        states: {
          pending: {
            always: ({ context }) =>
              context.hour < 12
                ? { target: "morning" }
                : context.hour < 18
                  ? { target: "afternoon" }
                  : { target: "evening" },
          },
          morning: {},
          afternoon: {},
          evening: {},
        },
        on: {
          CHANGE: () => ({ context: { hour: 20 } }),
          RECHECK: { target: "#greeting" },
        },
      },
    );

    // The initial transient is settled at creation: the persisted value is
    // already past `pending`.
    const created = initialStep(machine, { isChild: false });
    expect(created.nextState.value).toBe("morning");

    // CHANGE updates context but does NOT re-run the (already-left) transient.
    const changed = resumeStep(machine, {
      stored: roundTrip(created.nextState),
      event: { type: "CHANGE" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(changed.nextState.value).toBe("morning");
    expect((changed.nextState.context as Ctx).hour).toBe(20);

    // RECHECK re-enters the root, so the transient re-resolves against hour=20.
    const rechecked = resumeStep(machine, {
      stored: roundTrip(changed.nextState),
      event: { type: "RECHECK" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(rechecked.nextState.value).toBe("evening");
  });

  it("evaluates cross-region `always` guards against the interim configuration", () => {
    // A single event moves region A into A2; regions B and C each have an
    // `always` guarded (via the `value` arg) on A being in A2. Both must fire in
    // the same macrostep. This is the durability-critical bit: our engine must
    // forward the interim parallel configuration to inline transitions, and the
    // result must be identical whether computed in one pass or after rehydration.
    const machine = setup({}).createMachine({
      id: "m",
      type: "parallel",
      states: {
        A: {
          initial: "A1",
          states: { A1: { on: { A: { target: "A2" } } }, A2: {} },
        },
        B: {
          initial: "B1",
          states: {
            B1: {
              always: ({ value }) =>
                matchesState({ A: "A2" }, value) ? { target: "B2" } : undefined,
            },
            B2: {},
          },
        },
        C: {
          initial: "C1",
          states: {
            C1: {
              always: ({ value }) =>
                matchesState({ A: "A2" }, value) ? { target: "C2" } : undefined,
            },
            C2: {},
          },
        },
      },
    });
    const created = initialStep(machine, { isChild: false });
    const result = resumeStep(machine, {
      stored: roundTrip(created.nextState),
      event: { type: "A" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(result.nextState.value).toEqual({ A: "A2", B: "B2", C: "C2" });
  });

  it("settles a self-referential `always` with a fire-and-forget action in one pass", () => {
    // A self-loop `always` that leaves the state unchanged must settle after a
    // single pass rather than loop. Upstream attaches a fire-and-forget
    // `enq(() => ...)` closure and asserts it runs exactly once; our integration
    // deliberately drops arbitrary closures (only built-in send/raise/cancel/
    // spawn/stop become durable effects), so here the invariant is that the
    // macrostep converges to the unchanged value and emits NO effect — never an
    // infinite loop, and never a spurious captured effect. (A *stateful* effect
    // like `enq.spawn` in a self-loop genuinely never reaches a fixpoint, so it
    // cannot be modelled here — which is itself the reason to keep this shape.)
    const machine = createMachine({
      id: "m",
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "active" } } },
        active: {
          initial: "a",
          states: { a: {} },
          always: (_, enq) => {
            enq(() => {
              /* fire-and-forget: dropped by the integration */
            });
            return { target: ".a" };
          },
        },
      },
    });
    const created = initialStep(machine, { isChild: false });
    const result = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "GO" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(result.nextState.value).toEqual({ active: "a" });
    expect(result.effects).toEqual([]);
  });

  it("surfaces a genuinely infinite `always` loop as an error", () => {
    const machine = createMachine({
      id: "loop",
      initial: "a",
      states: {
        a: { always: { target: "b" } },
        b: { always: { target: "a" } },
      },
    });
    expect(() => initialStep(machine, { isChild: false })).toThrow(
      /Microstep count exceeded/,
    );
  });
});
