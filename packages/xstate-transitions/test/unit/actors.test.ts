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
  createMachine,
  initialTransition,
  setup,
  fromPromise as xstateFromPromise,
} from "xstate";
import {
  createDoneActorEvent,
  createErrorActorEvent,
  normalizeError,
  resolveReferencedActor,
} from "../../src/xstate/actors";

describe("resolveReferencedActor", () => {
  it("resolves a named actor via implementations", () => {
    const work = xstateFromPromise(async () => 1);
    const machine = setup({ actors: { work } }).createMachine({
      id: "m",
      invoke: { src: "work" },
    });
    expect(resolveReferencedActor(machine, "work")).toBe(work);
  });

  it("resolves a synthesized invoke src to the referenced machine", () => {
    const child = createMachine({ id: "child" });
    const parent = createMachine({ id: "parent", invoke: { src: child } });
    const [, actions] = initialTransition(parent);
    const spawn = actions.find(
      (a) => (a as { type: string }).type === "xstate.spawnChild",
    ) as { params: { src: string } };
    expect(spawn.params.src).toMatch(/^xstate\.invoke\./);
    expect(resolveReferencedActor(parent, spawn.params.src)).toBe(child);
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
      type: "xstate.done.actor.w",
      output: { ok: 1 },
      actorId: "w",
    });
  });
  it("builds a normalized error event", () => {
    expect(createErrorActorEvent("w", new Error("x"))).toEqual({
      type: "xstate.error.actor.w",
      error: { name: "Error", message: "x" },
      actorId: "w",
    });
  });
});
