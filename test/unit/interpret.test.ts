/*
 * Pure unit tests for the integration heart: `initialStep` / `resumeStep`.
 *
 * These run with NO Restate — plain machines in, { nextState, effects } out.
 * This is the whole point of the refactor: the xstate<->restate binding is a
 * pure function whose decisions we can assert directly.
 */

import { describe, it, expect } from "vitest";
import {
  assign,
  createMachine,
  enqueueActions,
  fromPromise,
  raise,
  sendParent,
  forwardTo,
  sendTo,
  cancel,
  setup,
} from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { Effect } from "../../src/xstate/types";

const byKind = (effects: Effect[], kind: Effect["kind"]) =>
  effects.filter((e) => e.kind === kind);

describe("initialStep()", () => {
  it("bakes entry assign into context and emits no effect for it", () => {
    const machine = createMachine({
      types: {} as { context: { n: number } },
      id: "m",
      context: { n: 0 },
      entry: assign({ n: 1 }),
    });
    const s = initialStep(machine, { isChild: false });
    expect(s.nextState.context).toEqual({ n: 1 });
    expect(s.effects).toEqual([]);
    expect(s.returned.status).toBe("active");
  });

  it("emits runPromise for a promise-actor invoke", () => {
    const machine = setup({
      actors: { work: fromPromise(async () => 42) },
    }).createMachine({
      id: "m",
      initial: "run",
      states: { run: { invoke: { src: "work", id: "w" } } },
    });
    const s = initialStep(machine, { isChild: false });
    const promises = byKind(s.effects, "runPromise");
    expect(promises).toHaveLength(1);
    expect(
      (promises[0] as Extract<Effect, { kind: "runPromise" }>).params.id,
    ).toBe("w");
    expect(byKind(s.effects, "startChild")).toHaveLength(0);
  });

  it("emits startChild for a child-machine invoke (not runPromise)", () => {
    const child = createMachine({
      id: "child",
      initial: "a",
      states: { a: {} },
    });
    const parent = setup({ actors: { child } }).createMachine({
      id: "parent",
      initial: "run",
      states: { run: { invoke: { src: "child", id: "kid" } } },
    });
    const s = initialStep(parent, { isChild: false });
    const starts = byKind(s.effects, "startChild");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      kind: "startChild",
      childId: "kid",
      machineId: "child",
    });
    expect(byKind(s.effects, "runPromise")).toHaveLength(0);
  });

  it("carries invoke input into the startChild effect", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actors: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid", input: { answer: 42 } },
    });
    const s = initialStep(parent, { isChild: false });
    expect(byKind(s.effects, "startChild")[0]).toMatchObject({
      input: { answer: 42 },
    });
  });

  it("emits two runPromise effects for two parallel invokes", () => {
    const machine = setup({
      actors: {
        a: fromPromise(async () => 1),
        b: fromPromise(async () => 2),
      },
    }).createMachine({
      id: "m",
      type: "parallel",
      states: {
        ra: { initial: "r", states: { r: { invoke: { src: "a", id: "a" } } } },
        rb: { initial: "r", states: { r: { invoke: { src: "b", id: "b" } } } },
      },
    });
    const s = initialStep(machine, { isChild: false });
    expect(byKind(s.effects, "runPromise")).toHaveLength(2);
  });
});

describe("resumeStep() — events and routing", () => {
  const machine = () =>
    createMachine({
      id: "m",
      initial: "a",
      states: {
        a: {
          on: {
            GO: { target: "b", actions: raise({ type: "AUTO" }) },
            LATER: {
              actions: raise({ type: "TICK" }, { delay: 100, id: "d" }),
            },
            KILL: { actions: cancel("d") },
          },
        },
        b: { on: { AUTO: "c" } },
        c: {},
      },
    });

  const resume = (event: { type: string }) => {
    const m = machine();
    const created = initialStep(m, { isChild: false });
    return resumeStep(m, {
      stored: created.nextState,
      event,
      isChild: false,
      knownChildIds: [],
    });
  };

  it("drains a zero-delay raise inside the macrostep (no effect)", () => {
    const s = resume({ type: "GO" });
    expect(s.nextState.value).toBe("c");
    expect(s.effects).toEqual([]);
  });

  it("emits scheduleSend(self) for a delayed raise", () => {
    const scheduled = byKind(resume({ type: "LATER" }).effects, "scheduleSend");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      kind: "scheduleSend",
      sendId: "d",
      target: { type: "self" },
      event: { type: "TICK" },
      delay: 100,
    });
  });

  it("emits cancel for cancel(id)", () => {
    expect(byKind(resume({ type: "KILL" }).effects, "cancel")).toEqual([
      { kind: "cancel", sendId: "d" },
    ]);
  });

  it("routes forwardTo(child) to a send effect targeting the child", () => {
    const child = createMachine({
      id: "child",
      initial: "a",
      states: { a: { on: { PING: "b" } }, b: {} },
    });
    const parent = setup({ actors: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid" },
      on: { PING: { actions: forwardTo("kid") } },
    });
    const created = initialStep(parent, { isChild: false });
    const s = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "PING" },
      isChild: false,
      knownChildIds: ["kid"],
    });
    expect(byKind(s.effects, "send")).toEqual([
      {
        kind: "send",
        target: { type: "child", childId: "kid" },
        event: { type: "PING" },
      },
    ]);
  });

  it("routes a delayed sendTo(child) to scheduleSend targeting the child", () => {
    const child = createMachine({
      id: "child",
      initial: "a",
      states: { a: {} },
    });
    const parent = setup({
      actors: { child },
      actions: {
        later: sendTo("kid", { type: "GO" }, { delay: 50, id: "s" }),
      },
    }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid" },
      on: { LATER: { actions: "later" } },
    });
    const created = initialStep(parent, { isChild: false });
    const s = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "LATER" },
      isChild: false,
      knownChildIds: ["kid"],
    });
    expect(byKind(s.effects, "scheduleSend")).toEqual([
      {
        kind: "scheduleSend",
        sendId: "s",
        target: { type: "child", childId: "kid" },
        event: { type: "GO" },
        delay: 50,
      },
    ]);
  });

  it("routes sendParent to a send effect targeting the parent (child instance)", () => {
    const child = createMachine({
      id: "child",
      initial: "idle",
      states: {
        idle: { on: { GO: { actions: sendParent({ type: "DONE" }) } } },
      },
    });
    const created = initialStep(child, { isChild: true });
    const s = resumeStep(child, {
      stored: created.nextState,
      event: { type: "GO" },
      isChild: true,
      knownChildIds: [],
    });
    expect(byKind(s.effects, "send")).toEqual([
      { kind: "send", target: { type: "parent" }, event: { type: "DONE" } },
    ]);
  });

  it("does not re-start a child already known", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actors: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid" },
    });
    const created = initialStep(parent, { isChild: false });
    const resumed = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "NOOP" },
      isChild: false,
      knownChildIds: ["kid"],
    });
    expect(byKind(resumed.effects, "startChild")).toHaveLength(0);
  });
});

describe("step — resolution semantics", () => {
  it("resolves enqueueActions (assign baked, raise drained) with no effects", () => {
    const machine = createMachine({
      types: {} as { context: { x: number } },
      id: "m",
      context: { x: 0 },
      initial: "a",
      states: {
        a: {
          on: {
            GO: {
              target: "b",
              actions: enqueueActions(({ enqueue }) => {
                enqueue.assign({ x: 5 });
                enqueue.raise({ type: "NEXT" });
              }),
            },
          },
        },
        b: { on: { NEXT: "c" } },
        c: {},
      },
    });
    const created = initialStep(machine, { isChild: false });
    const s = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "GO" },
      isChild: false,
      knownChildIds: [],
    });
    expect(s.nextState.value).toBe("c");
    expect(s.nextState.context).toEqual({ x: 5 });
    expect(s.effects).toEqual([]);
  });

  it("reports a done status and output at a final state", () => {
    const machine = createMachine({
      id: "m",
      initial: "a",
      states: { a: { on: { END: "done" } }, done: { type: "final" } },
      output: () => ({ ok: true }),
    });
    const created = initialStep(machine, { isChild: false });
    const s = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "END" },
      isChild: false,
      knownChildIds: [],
    });
    expect(s.returned.status).toBe("done");
    expect(s.returned.output).toEqual({ ok: true });
  });

  it("round-trips through the persisted state across many steps", () => {
    const machine = createMachine({
      types: {} as { context: { n: number } },
      id: "m",
      context: { n: 0 },
      on: { inc: { actions: assign({ n: ({ context }) => context.n + 1 }) } },
    });
    let s = initialStep(machine, { isChild: false });
    for (let i = 0; i < 3; i++) {
      s = resumeStep(machine, {
        stored: JSON.parse(JSON.stringify(s.nextState)),
        event: { type: "inc" },
        isChild: false,
        knownChildIds: [],
      });
    }
    expect(s.nextState.context).toEqual({ n: 3 });
  });
});
