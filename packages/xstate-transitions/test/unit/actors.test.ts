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
  createAsyncLogic,
  createMachine,
  initialTransition,
  isBuiltInExecutableEffect,
  setup,
} from "xstate";
import {
  createDoneActorEvent,
  createErrorActorEvent,
  normalizeError,
  referenceInlineActor,
  resolveReferencedActor,
} from "../../src/xstate/actors";

describe("resolveReferencedActor", () => {
  it("resolves a named actor via sources", () => {
    const work = createAsyncLogic({ run: async () => 1 });
    const machine = setup({ actors: { work } }).createMachine({
      id: "m",
      invoke: { src: "work" },
    });
    expect(resolveReferencedActor(machine, "work")).toBe(work);
  });

  it("names inline invoke logic so it resolves back to the same logic", () => {
    const child = createMachine({ id: "child" });
    const parent = createMachine({ id: "parent", invoke: { src: child } });
    const [, actions] = initialTransition(parent);
    const spawn = actions.find(
      (a) => isBuiltInExecutableEffect(a) && a.type === "@xstate.spawn",
    ) as { src: unknown };
    // XState reports inline logic as the object itself.
    expect(spawn.src).toBe(child);
    const name = referenceInlineActor(parent, spawn.src);
    expect(name).toBe("xstate.invoke.0.parent");
    expect(resolveReferencedActor(parent, name!)).toBe(child);
  });

  it("names inline invoke logic in nested states and invoke arrays", () => {
    const first = createAsyncLogic({ run: async () => 1 });
    const second = createAsyncLogic({ run: async () => 2 });
    const machine = createMachine({
      id: "m",
      initial: "outer",
      states: {
        outer: {
          initial: "inner",
          states: { inner: { invoke: [{ src: first }, { src: second }] } },
        },
      },
    });
    expect(referenceInlineActor(machine, second)).toBe(
      "xstate.invoke.1.m.outer.inner",
    );
    expect(
      resolveReferencedActor(machine, "xstate.invoke.1.m.outer.inner"),
    ).toBe(second);
    expect(
      referenceInlineActor(machine, createAsyncLogic({ run: async () => 3 })),
    ).toBe(undefined);
  });
});

describe("normalizeError", () => {
  it("maps an Error to {name,message}", () => {
    expect(normalizeError(new TypeError("boom"))).toEqual({
      name: "TypeError",
      message: "boom",
    });
  });
  it("stringifies non-errors", () => {
    expect(normalizeError("nope")).toEqual({ name: "Error", message: "nope" });
    expect(normalizeError(42)).toEqual({ name: "Error", message: "42" });
  });
});

describe("done/error actor events", () => {
  it("builds a done event", () => {
    expect(createDoneActorEvent("w", { ok: 1 })).toEqual({
      type: "xstate.done.actor",
      output: { ok: 1 },
      actorId: "w",
      sessionId: "w",
    });
  });
  it("builds a normalized error event", () => {
    expect(createErrorActorEvent("w", new Error("x"))).toEqual({
      type: "xstate.error.actor",
      error: { name: "Error", message: "x" },
      actorId: "w",
      sessionId: "w",
    });
  });
});
