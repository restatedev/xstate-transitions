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
 * Pure unit tests for the integration heart: `initialStep` / `resumeStep`.
 *
 * These run with NO Restate — plain machines in, { nextState, effects } out.
 * This is the whole point of the refactor: the xstate<->restate binding is a
 * pure function whose decisions we can assert directly.
 */

import { describe, expect, it } from "vitest";
import { createAsyncLogic, createMachine, setup, types } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { Effect } from "../../src/xstate/types";

const byKind = (effects: Effect[], kind: Effect["kind"]) =>
  effects.filter((effect) => effect.kind === kind);

describe("initialStep()", () => {
  it("bakes an entry context patch into context and emits no effect for it", () => {
    const machine = createMachine({
      id: "m",
      context: { n: 0 },
      entry: () => ({ context: { n: 1 } }),
    });
    const result = initialStep(machine, { isChild: false });
    expect(result.nextState.context).toEqual({ n: 1 });
    expect(result.effects).toEqual([]);
    expect(result.returned.status).toBe("active");
  });

  it("emits runPromise for a promise-actor invoke", () => {
    const machine = setup({
      actorSources: { work: createAsyncLogic({ run: async () => 42 }) },
    }).createMachine({
      id: "m",
      initial: "run",
      states: { run: { invoke: { src: "work", id: "w" } } },
    });
    const result = initialStep(machine, { isChild: false });
    const promises = byKind(result.effects, "runPromise");
    expect(promises).toHaveLength(1);
    expect(
      (promises[0] as Extract<Effect, { kind: "runPromise" }>).params.id,
    ).toBe("w");
    expect(byKind(result.effects, "startChild")).toHaveLength(0);
  });

  it("emits startChild for a child-machine invoke (not runPromise)", () => {
    const child = createMachine({
      id: "child",
      initial: "a",
      states: { a: {} },
    });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      initial: "run",
      states: { run: { invoke: { src: "child", id: "kid" } } },
    });
    const result = initialStep(parent, { isChild: false });
    const starts = byKind(result.effects, "startChild");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      kind: "startChild",
      childId: "kid",
      machineId: "child",
    });
    expect(byKind(result.effects, "runPromise")).toHaveLength(0);
  });

  it("carries invoke input into the startChild effect", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid", input: { answer: 42 } },
    });
    const result = initialStep(parent, { isChild: false });
    expect(byKind(result.effects, "startChild")[0]).toMatchObject({
      input: { answer: 42 },
    });
  });

  it("carries entry-spawn input into the startChild effect", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      context: { child: undefined as unknown },
      entry: (_, enq) => ({
        context: {
          child: enq.spawn(child, { id: "kid", input: { answer: 42 } }),
        },
      }),
    });

    expect(
      byKind(initialStep(parent, { isChild: false }).effects, "startChild"),
    ).toEqual([
      {
        kind: "startChild",
        childId: "kid",
        machineId: "child",
        input: { answer: 42 },
      },
    ]);
  });

  it("runs a promise actor spawned inside an entry action", () => {
    const work = createAsyncLogic<number, { answer: number }>({
      run: async ({ input }) => input.answer,
    });
    const parent = setup({ actorSources: { work } }).createMachine({
      id: "parent",
      context: { work: undefined as unknown },
      entry: (_, enq) => ({
        context: {
          work: enq.spawn(work, { id: "work", input: { answer: 42 } }),
        },
      }),
    });

    const effects = byKind(
      initialStep(parent, { isChild: false }).effects,
      "runPromise",
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      kind: "runPromise",
      params: { id: "work", input: { answer: 42 } },
    });
  });

  it("emits two runPromise effects for two parallel invokes", () => {
    const machine = setup({
      actorSources: {
        a: createAsyncLogic({ run: async () => 1 }),
        b: createAsyncLogic({ run: async () => 2 }),
      },
    }).createMachine({
      id: "m",
      type: "parallel",
      states: {
        ra: { initial: "r", states: { r: { invoke: { src: "a", id: "a" } } } },
        rb: { initial: "r", states: { r: { invoke: { src: "b", id: "b" } } } },
      },
    });
    const result = initialStep(machine, { isChild: false });
    expect(byKind(result.effects, "runPromise")).toHaveLength(2);
  });

  it("isolates systemId registrations in the parent-aware child scope", () => {
    const grandchild = createMachine({ id: "grandchild" });
    const child = setup({ actorSources: { grandchild } }).createMachine({
      id: "child",
      invoke: {
        src: "grandchild",
        id: "grandchild",
        systemId: "unique-grandchild",
      },
    });

    expect(() => initialStep(child, { isChild: true })).not.toThrow();
    expect(
      byKind(initialStep(child, { isChild: true }).effects, "startChild"),
    ).toMatchObject([{ childId: "grandchild", machineId: "grandchild" }]);
  });

  it("derives a deterministic child id for an invoke without an explicit id", () => {
    // Auto-generated invoke ids feed both our parent::childId virtual-object key
    // and the done-event addressing, so they must be stable across replay/restart
    // — a nondeterministic id would break re-association of an in-flight child
    // after the process rehydrates. The id is derived from the defining state
    // path, so two independent runs must produce the same startChild childId.
    const child = createMachine({
      id: "child",
      initial: "a",
      states: { a: {} },
    });
    const build = () =>
      setup({ actorSources: { child } }).createMachine({
        id: "parent",
        initial: "run",
        states: { run: { invoke: { src: "child" } } },
      });

    const first = byKind(
      initialStep(build(), { isChild: false }).effects,
      "startChild",
    );
    const second = byKind(
      initialStep(build(), { isChild: false }).effects,
      "startChild",
    );
    expect(first).toHaveLength(1);
    expect((first[0] as Extract<Effect, { kind: "startChild" }>).childId).toBe(
      (second[0] as Extract<Effect, { kind: "startChild" }>).childId,
    );
  });

  it("does not start an actor spawned and stopped in the same macrostep", () => {
    // A transition that spawns then stops the same ref leaves it out of the
    // settled snapshot's children; the integration must not run its effect.
    const work = createAsyncLogic({ run: async () => "must-not-run" });
    const machine = setup({ actorSources: { work } }).createMachine({
      id: "m",
      context: {},
      entry: (_, enq) => {
        const ref = enq.spawn(work, { id: "work" });
        enq.stop(ref);
      },
    });
    const result = initialStep(machine, { isChild: false });
    expect(byKind(result.effects, "runPromise")).toHaveLength(0);
    expect(byKind(result.effects, "startChild")).toHaveLength(0);
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
            GO: (_, enq) => {
              enq.raise({ type: "AUTO" });
              return { target: "b" };
            },
            LATER: (_, enq) => {
              enq.raise({ type: "TICK" }, { delay: 100, id: "d" });
            },
            KILL: (_, enq) => {
              enq.cancel("d");
            },
          },
        },
        b: { on: { AUTO: { target: "c" } } },
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
      knownPromiseIds: [],
    });
  };

  it("drains a zero-delay raise inside the macrostep (no effect)", () => {
    const result = resume({ type: "GO" });
    expect(result.nextState.value).toBe("c");
    expect(result.effects).toEqual([]);
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

  it("schedules an explicitly zero-delay raise instead of dropping it", () => {
    const zeroDelayMachine = createMachine({
      id: "zero-delay",
      on: {
        START: (_, enq) => {
          enq.raise({ type: "TICK" }, { delay: 0, id: "zero" });
        },
      },
    });
    const created = initialStep(zeroDelayMachine, { isChild: false });
    const result = resumeStep(zeroDelayMachine, {
      stored: created.nextState,
      event: { type: "START" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });

    expect(byKind(result.effects, "scheduleSend")).toEqual([
      {
        kind: "scheduleSend",
        sendId: "zero",
        target: { type: "self" },
        event: { type: "TICK" },
        delay: 0,
      },
    ]);
  });

  it("routes sendTo(self) without mistaking the actor ref for a child", () => {
    const selfSendingMachine = createMachine({
      id: "self-send",
      schemas: { events: { PING: types<Record<string, never>>() } },
      entry: ({ self }, enq) => {
        enq.sendTo(self, { type: "PING" }, { delay: 10, id: "self-delay" });
      },
    });

    expect(
      byKind(
        initialStep(selfSendingMachine, { isChild: false }).effects,
        "scheduleSend",
      ),
    ).toEqual([
      {
        kind: "scheduleSend",
        sendId: "self-delay",
        target: { type: "self" },
        event: { type: "PING" },
        delay: 10,
      },
    ]);
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
      states: { a: { on: { PING: { target: "b" } } }, b: {} },
    });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid" },
      on: {
        PING: ({ children, event }, enq) => {
          enq.sendTo(children.kid, event);
        },
      },
    });
    const created = initialStep(parent, { isChild: false });
    const result = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "PING" },
      isChild: false,
      knownChildIds: ["kid"],
      knownPromiseIds: [],
    });
    expect(byKind(result.effects, "send")).toEqual([
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
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid" },
      on: {
        LATER: ({ children }, enq) => {
          enq.sendTo(children.kid, { type: "GO" }, { delay: 50, id: "s" });
        },
      },
    });
    const created = initialStep(parent, { isChild: false });
    const result = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "LATER" },
      isChild: false,
      knownChildIds: ["kid"],
      knownPromiseIds: [],
    });
    expect(byKind(result.effects, "scheduleSend")).toEqual([
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
        idle: {
          on: {
            GO: ({ parent }, enq) => {
              enq.sendTo(parent, { type: "DONE" });
            },
          },
        },
      },
    });
    const created = initialStep(child, { isChild: true });
    const result = resumeStep(child, {
      stored: created.nextState,
      event: { type: "GO" },
      isChild: true,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(byKind(result.effects, "send")).toEqual([
      { kind: "send", target: { type: "parent" }, event: { type: "DONE" } },
    ]);
  });

  it("does not re-start a child already known", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      invoke: { src: "child", id: "kid" },
    });
    const created = initialStep(parent, { isChild: false });
    const resumed = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "NOOP" },
      isChild: false,
      knownChildIds: ["kid"],
      knownPromiseIds: [],
    });
    expect(byKind(resumed.effects, "startChild")).toHaveLength(0);
    expect(byKind(resumed.effects, "runPromise")).toHaveLength(0);
  });

  it("stops a persisted machine child when its invoke is exited", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      initial: "running",
      states: {
        running: {
          invoke: { src: "child", id: "kid" },
          on: { CANCEL: { target: "idle" } },
        },
        idle: {},
      },
    });
    const created = initialStep(parent, { isChild: false });
    const stopped = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "CANCEL" },
      isChild: false,
      knownChildIds: ["kid"],
      knownPromiseIds: [],
    });

    expect(byKind(stopped.effects, "stopChild")).toEqual([
      { kind: "stopChild", childId: "kid" },
    ]);
  });

  it("stops then restarts a re-entered invoke with the same child id", () => {
    const child = createMachine({ id: "child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      initial: "running",
      states: {
        running: {
          invoke: { src: "child", id: "kid", input: { generation: 2 } },
          on: { REENTER: { target: "running", reenter: true } },
        },
      },
    });
    const created = initialStep(parent, { isChild: false });
    const reentered = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "REENTER" },
      isChild: false,
      knownChildIds: ["kid"],
      knownPromiseIds: [],
    });

    expect(reentered.effects.slice(0, 2)).toEqual([
      { kind: "stopChild", childId: "kid" },
      {
        kind: "startChild",
        childId: "kid",
        machineId: "child",
        input: { generation: 2 },
      },
    ]);
  });

  it("stops then restarts a re-entered promise with the same actor id", () => {
    const parent = setup({
      actorSources: { work: createAsyncLogic({ run: async () => "done" }) },
    }).createMachine({
      id: "parent",
      initial: "running",
      states: {
        running: {
          invoke: { src: "work", id: "work" },
          on: { REENTER: { target: "running", reenter: true } },
        },
      },
    });
    const created = initialStep(parent, { isChild: false });
    const reentered = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "REENTER" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: ["work"],
    });

    expect(reentered.effects.slice(0, 2)).toEqual([
      { kind: "stopPromise", actorId: "work" },
      expect.objectContaining({
        kind: "runPromise",
        params: expect.objectContaining({ id: "work" }),
      }),
    ]);
  });

  it("emits no send effect for sendTo of an undefined/missing actor ref", () => {
    // A transition that targets a child that does not exist (an undefined ref)
    // must not produce a send effect at all — otherwise we would issue a spurious
    // Restate call to a nonexistent object. This is the planning-layer companion
    // to effects.ts dropping sends to a vanished target at execution time.
    const parent = setup({}).createMachine({
      id: "parent",
      on: {
        PING: ({ children }, enq) => {
          enq.sendTo((children as Record<string, never>).missing, {
            type: "X",
          } as never);
        },
      },
    });
    const created = initialStep(parent, { isChild: false });
    const result = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "PING" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(byKind(result.effects, "send")).toEqual([]);
    expect(byKind(result.effects, "scheduleSend")).toEqual([]);
  });

  it("stops a child explicitly stopped via a context-held ref after rehydration", () => {
    // The stored ref is a JSON-revived object, so it no longer matches the
    // injected stub and XState's identity-based removal leaves the child in
    // `snapshot.children`. The explicit @xstate.stop action must still tear it
    // down, otherwise the child leaks and its later completion is accepted.
    const child = createMachine({
      id: "child",
      initial: "a",
      states: { a: {} },
    });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "parent",
      context: { ref: undefined as unknown },
      initial: "running",
      states: {
        running: {
          entry: (_, enq) => ({
            context: { ref: enq.spawn(child, { id: "kid" }) },
          }),
          on: {
            STOP: ({ context }, enq) => {
              enq.stop(context.ref as never);
            },
          },
        },
      },
    });
    const created = initialStep(parent, { isChild: false });
    const stopped = resumeStep(parent, {
      stored: created.nextState,
      event: { type: "STOP" },
      isChild: false,
      knownChildIds: ["kid"],
      knownPromiseIds: [],
    });
    expect(byKind(stopped.effects, "stopChild")).toEqual([
      { kind: "stopChild", childId: "kid" },
    ]);
  });
});

describe("step — resolution semantics", () => {
  it("settles exit, transition, entry, raised, and always actions in order", () => {
    type Ctx = { trace: string[] };
    const append =
      (label: string) =>
      ({ context }: { context: Ctx }) => ({
        context: { trace: [...context.trace, label] },
      });
    const machine = createMachine({
      schemas: { context: types<Ctx>() },
      id: "macrostep-order",
      context: { trace: [] },
      initial: "a",
      states: {
        a: {
          exit: append("exit:a"),
          on: {
            GO: ({ context }, enq) => {
              enq.raise({ type: "FIRST" });
              enq.raise({ type: "SECOND" });
              return {
                target: "b",
                context: { trace: [...context.trace, "transition:GO"] },
              };
            },
          },
        },
        b: {
          entry: append("entry:b"),
          exit: append("exit:b"),
          on: {
            FIRST: ({ context }) => ({
              target: "c",
              context: { trace: [...context.trace, "event:FIRST"] },
            }),
          },
        },
        c: {
          entry: append("entry:c"),
          exit: append("exit:c"),
          always: ({ context }) => ({
            target: "d",
            context: { trace: [...context.trace, "always:c"] },
          }),
        },
        d: {
          entry: append("entry:d"),
          on: {
            SECOND: ({ context }) => ({
              context: { trace: [...context.trace, "event:SECOND"] },
            }),
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

    // In XState v6 an exit action's context patch is not threaded into the
    // running context the way entry/transition/always patches are, so the
    // `exit:*` appends do not appear in the trace. The macrostep still visits
    // the states in the same order; only the exit context writes drop out. The
    // integration is a passthrough of whatever context XState computes.
    expect(result.nextState.value).toBe("d");
    expect((result.nextState.context as { trace: string[] }).trace).toEqual([
      "transition:GO",
      "entry:b",
      "event:FIRST",
      "entry:c",
      "always:c",
      "entry:d",
      "event:SECOND",
    ]);
    expect(result.effects).toEqual([]);
  });

  it("resolves an enqueue action (context baked, raise drained) with no effects", () => {
    const machine = createMachine({
      id: "m",
      context: { x: 0 },
      initial: "a",
      states: {
        a: {
          on: {
            GO: (_, enq) => {
              enq.raise({ type: "NEXT" });
              return { target: "b", context: { x: 5 } };
            },
          },
        },
        b: { on: { NEXT: { target: "c" } } },
        c: {},
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
    expect(result.nextState.value).toBe("c");
    expect(result.nextState.context).toEqual({ x: 5 });
    expect(result.effects).toEqual([]);
  });

  it("reports a done status and output at a final state", () => {
    const machine = createMachine({
      id: "m",
      initial: "a",
      states: {
        a: { on: { END: { target: "done" } } },
        done: { type: "final" },
      },
      output: () => ({ ok: true }),
    });
    const created = initialStep(machine, { isChild: false });
    const result = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "END" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(result.returned.status).toBe("done");
    expect(result.returned.output).toEqual({ ok: true });
  });

  it("threads a final state's entry context patch into its output", () => {
    // Complements the exit-patch quirk documented above: entry patches ARE
    // threaded into context before the state's `output` expression runs, so the
    // output persisted in the snapshot reflects the entry-updated context. A
    // regression here would silently corrupt the durable output / onDone event.
    type Ctx = { count: number; captured?: unknown };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "m",
        context: { count: 0 },
        initial: "a",
        states: {
          a: {
            initial: "a1",
            states: {
              a1: { on: { NEXT: { target: "a2" } } },
              a2: {
                type: "final",
                entry: () => ({ context: { count: 1 } }),
                output: ({ context }) => context.count,
              },
            },
            onDone: ({ event }) => ({ context: { captured: event.output } }),
          },
        },
      },
    );
    const created = initialStep(machine, { isChild: false });
    const result = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "NEXT" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect((result.nextState.context as Ctx).captured).toBe(1);
  });

  it("round-trips through the persisted state across many steps", () => {
    const machine = createMachine({
      id: "m",
      context: { n: 0 },
      on: { inc: ({ context }) => ({ context: { n: context.n + 1 } }) },
    });
    let result = initialStep(machine, { isChild: false });
    for (let i = 0; i < 3; i++) {
      result = resumeStep(machine, {
        stored: JSON.parse(JSON.stringify(result.nextState)),
        event: { type: "inc" },
        isChild: false,
        knownChildIds: [],
        knownPromiseIds: [],
      });
    }
    expect(result.nextState.context).toEqual({ n: 3 });
  });
});
