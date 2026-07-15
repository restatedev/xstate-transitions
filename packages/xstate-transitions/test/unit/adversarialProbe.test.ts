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

import { describe, expect, it } from "vitest";
import {
  type AnyMachineSnapshot,
  createAsyncLogic,
  createMachine,
  initialTransition,
  isBuiltInExecutableAction,
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

const builtIn = (actions: unknown[], type: string): any =>
  actions.find(
    (a) => isBuiltInExecutableAction(a as any) && (a as any).type === type,
  );

describe("adversarial probes (v6 pure-transition shapes)", () => {
  it("preserves deep history across nested parallel regions", () => {
    const machine = createMachine({
      id: "deep-parallel-history",
      initial: "session",
      states: {
        session: {
          initial: "work",
          on: { PAUSE: { target: "paused" } },
          states: {
            work: {
              type: "parallel",
              states: {
                left: {
                  initial: "outer",
                  states: {
                    outer: {
                      initial: "one",
                      states: {
                        one: { on: { LEFT: { target: "two" } } },
                        two: {},
                      },
                    },
                  },
                },
                right: {
                  initial: "one",
                  states: {
                    one: { on: { RIGHT: { target: "two" } } },
                    two: {},
                  },
                },
              },
            },
            hist: { type: "history", history: "deep" },
          },
        },
        paused: {
          on: { RESUME: { target: "#deep-parallel-history.session.hist" } },
        },
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

  it("shows the @xstate.sendTo shape for a delayed sendTo(self)", () => {
    const machine = createMachine({
      id: "self-send",
      entry: ({ self }, enq) => {
        enq.sendTo(self, { type: "PING" }, { delay: 10, id: "self-delay" });
      },
    });
    const [, actions] = initialTransition(machine);
    const action = builtIn(actions, "@xstate.sendTo");
    expect(action).toMatchObject({
      event: { type: "PING" },
      delay: 10,
      id: "self-delay",
    });
    // The target is the self actor ref (not a #_parent or child id).
    expect(action.target).toBeDefined();
  });

  it("emits an @xstate.spawn action carrying its input for an entry spawn", () => {
    const child = createMachine({
      id: "spawn-input-child",

      context: ({ input }: any) => ({ received: input }),
    });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "spawn-input-parent",
      context: { ref: undefined as unknown },
      entry: (_, enq) => ({
        context: {
          ref: enq.spawn(child, { id: "child", input: { answer: 42 } }),
        },
      }),
    });
    const [snapshot, actions] = initialTransition(parent);
    const spawn = builtIn(actions, "@xstate.spawn");
    // Unlike v5's spawn-in-assign (which emitted no action), v6 always emits an
    // @xstate.spawn carrying the id and resolved input.
    expect(snapshot.children.child).toBeDefined();
    expect(spawn).toBeDefined();
    expect(spawn.input).toEqual({ answer: 42 });
  });

  it("captures ordinary invoke input in its emitted @xstate.spawn action", () => {
    const child = createMachine({ id: "invoke-input-child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "invoke-input-parent",
      invoke: { id: "child", src: "child", input: { answer: 42 } },
    });
    const [, actions] = initialTransition(parent);
    const spawn = builtIn(actions, "@xstate.spawn");
    expect(spawn.input).toEqual({ answer: 42 });
  });

  it("keeps an actor-ref sendTo routable after context JSON serialization", () => {
    const child = createMachine({ id: "ref-child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "ref-parent",

      context: { ref: undefined as any },
      entry: (_, enq) => ({
        context: { ref: enq.spawn(child, { id: "child" }) },
      }),
      on: {
        SEND: ({ context }, enq) => {
          enq.sendTo(context.ref, { type: "PING" });
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
    const send = builtIn(actions, "@xstate.sendTo");
    // The serialized ref stays routable: its id resolves the child target.
    expect(send.target?.id).toBe("child");
  });

  it("keeps sendTo(parent) and forwardTo resolvable with fabricated refs", () => {
    const child = createMachine({
      id: "scope-child",
      initial: "idle",
      entry: ({ parent }, enq) => {
        enq.sendTo(parent, { type: "READY" });
      },
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
    const [, entryActions] = runInitial(child, undefined, true);
    expect(builtIn(entryActions, "@xstate.sendTo").target.id).toBe("#_parent");
    const [childSnapshot] = runInitial(child, undefined, true);
    const [, childActions] = runTransition(
      child,
      childSnapshot,
      { type: "GO" },
      true,
    );
    expect(builtIn(childActions, "@xstate.sendTo").target.id).toBe("#_parent");

    const parent = setup({ actorSources: { child } }).createMachine({
      id: "scope-parent",
      invoke: { id: "child", src: "child" },
      on: {
        FORWARD: ({ children, event }, enq) => {
          enq.sendTo(children.child, event);
        },
      },
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
    expect(builtIn(forwardActions, "@xstate.sendTo").target.id).toBe("child");
  });

  it("routes a normalized vanilla-actor error through a message guard", async () => {
    const machine = setup({
      actorSources: {
        boom: createAsyncLogic({
          run: async () => {
            throw new Error("MATCH_ME");
          },
        }),
      },
    }).createMachine({
      id: "normalized-error",
      initial: "run",
      states: {
        run: {
          invoke: {
            id: "boom",
            src: "boom",
            onError: ({ event }) =>
              (event.error as any)?.message === "MATCH_ME"
                ? { target: "matched" }
                : { target: "missed" },
          },
        },
        matched: { type: "final" },
        missed: { type: "final" },
      },
    });
    const [snapshot, actions] = initialTransition(machine);
    const spawn = builtIn(actions, "@xstate.spawn");
    // Vanilla actors run inside ctx.run, so provide a minimal fake that just
    // executes the action.
    const fakeCtx = { run: (_name: string, action: () => unknown) => action() };
    const outcome = await runActor(
      machine,
      { id: spawn.id, src: spawn.src, input: spawn.input },

      fakeCtx as any,
    );
    expect(outcome).toMatchObject({
      error: { name: "Error", message: "MATCH_ME" },
    });
    if (outcome.status !== "error") throw new Error("Expected actor failure");
    const errorEvent = createNormalizedErrorActorEvent(spawn.id, outcome.error);
    const [next] = transition(machine, snapshot, errorEvent as never);
    expect(next).toMatchObject({ status: "done", value: "matched" });
  });

  it("rejects duplicate machine ids instead of silently running the wrong machine", () => {
    const child = createMachine({
      id: "duplicate",
      initial: "child",
      states: { child: {} },
    });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "duplicate",
      initial: "parent",
      states: { parent: { invoke: { id: "kid", src: "child" } } },
    });
    expect(() => buildRegistry(parent)).toThrow(
      'Machine id "duplicate" is used by more than one machine',
    );
  });

  it("removes an exited invoke's child from children without a stop action", () => {
    const child = createMachine({ id: "teardown-child" });
    const parent = setup({ actorSources: { child } }).createMachine({
      id: "teardown-parent",
      initial: "running",
      states: {
        running: {
          invoke: { id: "kid", src: "child" },
          on: { CANCEL: { target: "idle" } },
        },
        idle: { on: { AGAIN: { target: "running" } } },
      },
    });
    const [snapshot] = initialTransition(parent);
    expect(snapshot.children.kid).toBeDefined();
    const [next, actions] = transition(parent, snapshot, {
      type: "CANCEL",
    } as never);
    // v6 does not emit a stop action on invoke exit; the child simply disappears
    // from the post-transition snapshot.children. The integration derives the
    // stopChild effect from that diff instead.
    expect(next.children.kid).toBeUndefined();
    expect(builtIn(actions, "@xstate.stop")).toBeUndefined();
  });
});
