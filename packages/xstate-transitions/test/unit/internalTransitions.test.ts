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
 * Internal-transition entry-set semantics, ported from upstream xstate
 * `internalTransitions.test.ts` into our pure-transition + effect model.
 *
 * Getting the entry set wrong is a durability hazard here, not just a logic bug:
 * a state's `entry` may carry an `enq.spawn`/`enq.sendTo` effect and a compound
 * state may hold an `invoke`. If an ordinary internal transition spuriously
 * re-entered an ancestor (or failed to re-enter a targeted descendant), those
 * effects would fire the wrong number of times — breaking exactly-once. Upstream
 * observes re-entry with `enq(() => tracked.push(...))` side-effect closures,
 * which our integration deliberately drops; we re-express observability through
 * entry context patches (which we thread and persist) and, for the parent case,
 * through the presence/absence of child-lifecycle effects.
 */

import { describe, expect, it } from "vitest";
import { createAsyncLogic, setup, types } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { Effect } from "../../src/xstate/types";

const byKind = (effects: Effect[], kind: Effect["kind"]) =>
  effects.filter((effect) => effect.kind === kind);

describe("internal transitions — entry set", () => {
  it("reenters proper descendants of an internal transition's source, not the source", () => {
    type Ctx = {
      sourceStateEntries: number;
      directDescendantEntries: number;
      deepDescendantEntries: number;
    };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "m",
        context: {
          sourceStateEntries: 0,
          directDescendantEntries: 0,
          deepDescendantEntries: 0,
        },
        initial: "a1",
        states: {
          a1: {
            initial: "a11",
            entry: ({ context }) => ({
              context: {
                ...context,
                sourceStateEntries: context.sourceStateEntries + 1,
              },
            }),
            // An internal transition (no `reenter`) whose target is a deep
            // descendant: a1 must NOT be re-entered, but a11 and a111 must be.
            on: { REENTER: { target: ".a11.a111" } },
            states: {
              a11: {
                initial: "a111",
                entry: ({ context }) => ({
                  context: {
                    ...context,
                    directDescendantEntries:
                      context.directDescendantEntries + 1,
                  },
                }),
                states: {
                  a111: {
                    entry: ({ context }) => ({
                      context: {
                        ...context,
                        deepDescendantEntries:
                          context.deepDescendantEntries + 1,
                      },
                    }),
                  },
                },
              },
            },
          },
        },
      },
    );

    const created = initialStep(machine, { isChild: false });
    expect(created.nextState.context).toEqual({
      sourceStateEntries: 1,
      directDescendantEntries: 1,
      deepDescendantEntries: 1,
    });

    const reentered = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "REENTER" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(reentered.nextState.context).toEqual({
      sourceStateEntries: 1,
      directDescendantEntries: 2,
      deepDescendantEntries: 2,
    });
  });

  it("an internal sibling switch does not re-enter the parent (entry patch not re-run)", () => {
    type Ctx = { foo: number; a: number; b: number };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "m",
        context: { foo: 0, a: 0, b: 0 },
        initial: "foo",
        states: {
          foo: {
            entry: ({ context }) => ({
              context: { ...context, foo: context.foo + 1 },
            }),
            initial: "a",
            // Internal transition declared on the parent, moving between siblings.
            on: { CLICK: { target: ".b" } },
            states: {
              a: {
                entry: ({ context }) => ({
                  context: { ...context, a: context.a + 1 },
                }),
              },
              b: {
                entry: ({ context }) => ({
                  context: { ...context, b: context.b + 1 },
                }),
              },
            },
          },
        },
      },
    );

    const created = initialStep(machine, { isChild: false });
    expect(created.nextState.context).toEqual({ foo: 1, a: 1, b: 0 });

    const clicked = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "CLICK" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(clicked.nextState.value).toEqual({ foo: "b" });
    // Parent `foo` was neither exited nor re-entered: its entry patch did not
    // re-run (foo stays 1); only the sibling `b` entered.
    expect(clicked.nextState.context).toEqual({ foo: 1, a: 1, b: 1 });
  });

  it("an internal sibling switch does not restart an invoke held on the parent", () => {
    // The strongest durability form of the case above: an `invoke` on the parent
    // must survive an internal transition between its children. If we mis-selected
    // this as a self-transition, we would emit a spurious stopChild+startChild
    // (or re-run an entry `enq.spawn`) on every sibling switch, violating
    // exactly-once for the actor.
    const work = createAsyncLogic({ run: async () => "done" });
    const machine = setup({ actorSources: { work } }).createMachine({
      id: "m",
      initial: "foo",
      states: {
        foo: {
          invoke: { src: "work", id: "work" },
          initial: "a",
          on: { CLICK: { target: ".b" } },
          states: { a: {}, b: {} },
        },
      },
    });

    const created = initialStep(machine, { isChild: false });
    expect(byKind(created.effects, "runPromise")).toHaveLength(1);

    const clicked = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "CLICK" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: ["work"],
    });
    expect(clicked.nextState.value).toEqual({ foo: "b" });
    expect(byKind(clicked.effects, "stopPromise")).toHaveLength(0);
    expect(byKind(clicked.effects, "runPromise")).toHaveLength(0);
    expect(byKind(clicked.effects, "stopChild")).toHaveLength(0);
    expect(byKind(clicked.effects, "startChild")).toHaveLength(0);
  });

  it("enters a relative `after` target's descendant without re-entering the parent", () => {
    // A delayed transition with a relative target must compute the same entry set
    // as any other transition: the compound parent is NOT re-entered, only the
    // targeted descendant is. If the parent were wrongly re-entered, its entry
    // effects would fire twice on delivery of the (durably scheduled) after event
    // — a double-side-effect hazard specific to our delayed-self-send delivery.
    type Ctx = { parentEntries: number; threeEntries: number };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "aftp",
        context: { parentEntries: 0, threeEntries: 0 },
        initial: "p",
        states: {
          p: {
            initial: "one",
            entry: ({ context }) => ({
              context: { ...context, parentEntries: context.parentEntries + 1 },
            }),
            after: { 10: { target: ".three" } },
            states: {
              one: {},
              two: {},
              three: {
                entry: ({ context }) => ({
                  context: {
                    ...context,
                    threeEntries: context.threeEntries + 1,
                  },
                }),
              },
            },
          },
        },
      },
    );

    const created = initialStep(machine, { isChild: false });
    expect(created.nextState.value).toEqual({ p: "one" });
    expect(created.nextState.context).toEqual({
      parentEntries: 1,
      threeEntries: 0,
    });

    // Deliver the scheduled after event exactly as deliverScheduled would.
    const fired = resumeStep(machine, {
      stored: created.nextState,
      event: { type: "xstate.after.10.aftp.p" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(fired.nextState.value).toEqual({ p: "three" });
    // Parent entered exactly once; only the relative target's descendant entered.
    expect(fired.nextState.context).toEqual({
      parentEntries: 1,
      threeEntries: 1,
    });
  });
});
