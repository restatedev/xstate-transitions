import { describe, expect, it } from "vitest";
import {
  type AnyMachineSnapshot,
  assign,
  createMachine,
  forwardTo,
  fromPromise,
  initialTransition,
  sendParent,
  sendTo,
  setup,
  transition,
} from "xstate";
import { runActor } from "../../src/restate/run-actor";
import { createNormalizedErrorActorEvent } from "../../src/xstate/actors";
import { buildRegistry } from "../../src/xstate/registry";
import {
  runInitial,
  runTransition,
  stubChildRef,
} from "../../src/xstate/scope";
import { fromStored, toStored } from "../../src/xstate/snapshot";

const jsonRoundTrip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

describe("temporary adversarial probes", () => {
  it("preserves deep history across nested parallel regions", () => {
    const machine = createMachine({
      id: "deep-parallel-history",
      initial: "session",
      states: {
        session: {
          initial: "work",
          on: { PAUSE: "paused" },
          states: {
            work: {
              type: "parallel",
              states: {
                left: {
                  initial: "outer",
                  states: {
                    outer: {
                      initial: "one",
                      states: { one: { on: { LEFT: "two" } }, two: {} },
                    },
                  },
                },
                right: {
                  initial: "one",
                  states: { one: { on: { RIGHT: "two" } }, two: {} },
                },
              },
            },
            hist: { type: "history", history: "deep" },
          },
        },
        paused: { on: { RESUME: "#deep-parallel-history.session.hist" } },
      },
    });

    let [snapshot] = initialTransition(machine);
    for (const type of ["LEFT", "RIGHT", "PAUSE", "RESUME"]) {
      const stored = jsonRoundTrip(toStored(snapshot as AnyMachineSnapshot));
      [snapshot] = transition(machine, fromStored(machine, stored), {
        type,
      } as never);
    }

    expect(snapshot.value).toEqual({
      session: {
        work: { left: { outer: "two" }, right: "two" },
      },
    });
  });

  it("shows the router action shape for delayed sendTo(self)", () => {
    const machine = createMachine({
      id: "self-send",
      entry: sendTo(
        ({ self }) => self,
        { type: "PING" },
        { delay: 10, id: "self-delay" },
      ),
    });
    const [, actions] = initialTransition(machine);
    const action = actions.find(
      (candidate) => candidate.type === "xstate.sendTo",
    ) as any;
    expect(action.params).toMatchObject({
      event: { type: "PING" },
      delay: 10,
      id: "self-delay",
    });
    expect(action.params.targetId).toBeUndefined();
    expect(action.params.to.id).toMatch(/^x:/);
  });

  it("shows spawn-in-assign creates a child but emits no action carrying its input", () => {
    const child = createMachine({
      id: "spawn-input-child",
      context: ({ input }: any) => ({ received: input }),
    });
    const parent = setup({ actors: { child } }).createMachine({
      id: "spawn-input-parent",
      context: { ref: undefined as unknown },
      entry: assign({
        ref: ({ spawn }) =>
          spawn("child", { id: "child", input: { answer: 42 } }),
      }),
    });
    const [snapshot, actions] = initialTransition(parent);
    const spawn = actions.find(
      (candidate) => candidate.type === "xstate.spawnChild",
    ) as any;
    expect(snapshot.children.child).toBeDefined();
    expect(spawn).toBeUndefined();
  });

  it("captures ordinary invoke input in its emitted spawnChild action", () => {
    const child = createMachine({ id: "invoke-input-child" });
    const parent = setup({ actors: { child } }).createMachine({
      id: "invoke-input-parent",
      invoke: { id: "child", src: "child", input: { answer: 42 } },
    });
    const [, actions] = initialTransition(parent);
    const spawn = actions.find(
      (candidate) => candidate.type === "xstate.spawnChild",
    ) as any;
    expect(spawn.params.input).toEqual({ answer: 42 });
  });

  it("keeps an actor-ref sendTo routable after context JSON serialization", () => {
    const child = createMachine({ id: "ref-child" });
    const parent = setup({ actors: { child } }).createMachine({
      id: "ref-parent",
      context: { ref: undefined as any },
      entry: assign({ ref: ({ spawn }) => spawn("child", { id: "child" }) }),
      on: {
        SEND: {
          actions: sendTo(({ context }) => context.ref, { type: "PING" }),
        },
      },
    });
    const [snapshot] = initialTransition(parent);
    const rehydrated = fromStored(
      parent,
      jsonRoundTrip(toStored(snapshot as AnyMachineSnapshot)),
    ) as any;
    rehydrated.children.child = stubChildRef("child");
    const [, actions] = transition(parent, rehydrated, {
      type: "SEND",
    } as never);
    const send = actions.find(
      (candidate) => candidate.type === "xstate.sendTo",
    ) as any;
    expect(send.params.targetId).toBeUndefined();
    expect(send.params.to).toEqual({ xstate$$type: 1, id: "child" });
  });

  it("keeps sendParent and forwardTo resolvable with fabricated refs", () => {
    const child = createMachine({
      id: "scope-child",
      initial: "idle",
      entry: sendParent({ type: "READY" }),
      states: {
        idle: { on: { GO: { actions: sendParent({ type: "DONE" }) } } },
      },
    });
    const [, entryActions] = runInitial(child, undefined, true);
    expect((entryActions[0] as any).params.targetId).toBe("#_parent");
    const [childSnapshot] = runInitial(child, undefined, true);
    const [, childActions] = runTransition(
      child,
      childSnapshot,
      { type: "GO" },
      true,
    );
    expect((childActions[0] as any).params.targetId).toBe("#_parent");

    const parent = setup({ actors: { child } }).createMachine({
      id: "scope-parent",
      invoke: { id: "child", src: "child" },
      on: { FORWARD: { actions: forwardTo("child") } },
    });
    const [parentSnapshot] = initialTransition(parent);
    const rehydrated = fromStored(
      parent,
      jsonRoundTrip(toStored(parentSnapshot as AnyMachineSnapshot)),
    ) as any;
    rehydrated.children.child = stubChildRef("child");
    const [, forwardActions] = transition(parent, rehydrated, {
      type: "FORWARD",
    } as never);
    expect((forwardActions[0] as any).params.targetId).toBe("child");
  });

  it("routes a normalized vanilla-promise error through a message guard", async () => {
    const machine = setup({
      actors: {
        boom: fromPromise(async () => {
          throw new Error("MATCH_ME");
        }),
      },
    }).createMachine({
      id: "normalized-error",
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "boom",
            onError: [
              {
                guard: ({ event }) =>
                  (event.error as any).message === "MATCH_ME",
                target: "matched",
              },
              { target: "missed" },
            ],
          },
        },
        matched: { type: "final" },
        missed: { type: "final" },
      },
    });
    const [snapshot, actions] = initialTransition(machine);
    const spawn = actions.find(
      (candidate) => candidate.type === "xstate.spawnChild",
    ) as any;
    const outcome = await runActor(machine, spawn.params, {} as any);
    expect(outcome).toMatchObject({
      error: { name: "Error", message: "MATCH_ME" },
    });
    if (outcome.status !== "error") throw new Error("Expected actor failure");
    const errorEvent = createNormalizedErrorActorEvent(
      spawn.params.id,
      outcome.error,
    );
    const [next] = transition(machine, snapshot, errorEvent as never);
    expect(next).toMatchObject({ status: "done", value: "matched" });
  });

  it("rejects duplicate machine ids instead of silently running the wrong machine", () => {
    const child = createMachine({
      id: "duplicate",
      initial: "child",
      states: { child: {} },
    });
    const parent = setup({ actors: { child } }).createMachine({
      id: "duplicate",
      initial: "parent",
      states: { parent: { invoke: { id: "kid", src: "child" } } },
    });
    expect(() => buildRegistry(parent)).toThrow(
      'Machine id "duplicate" is used by more than one machine',
    );
  });

  it("shows that exiting an invoke emits the currently ignored stopChild action", () => {
    const child = createMachine({ id: "teardown-child" });
    const parent = setup({ actors: { child } }).createMachine({
      id: "teardown-parent",
      initial: "running",
      states: {
        running: {
          invoke: { id: "kid", src: "child" },
          on: { CANCEL: "idle" },
        },
        idle: { on: { AGAIN: "running" } },
      },
    });
    const [snapshot] = initialTransition(parent);
    const [, actions] = transition(parent, snapshot, {
      type: "CANCEL",
    } as never);
    expect(
      actions.some(
        (action) =>
          (action as unknown as { type: string }).type === "xstate.stopChild",
      ),
    ).toBe(true);
  });
});
