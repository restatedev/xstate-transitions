import { describe, it, expect } from "vitest";
import { createMachine, initialTransition, setup } from "xstate";
import {
  resolveReferencedActor,
  isRestatePromiseActor,
  normalizeError,
  createDoneActorEvent,
  createErrorActorEvent,
} from "../../src/xstate/actors";
import { fromPromise as restateFromPromise } from "../../src/restate/promise";
import { fromPromise as xstateFromPromise } from "xstate";

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

describe("isRestatePromiseActor", () => {
  it("is true for a Restate-aware fromPromise", () => {
    expect(isRestatePromiseActor(restateFromPromise(async () => 1))).toBe(true);
  });
  it("is false for vanilla fromPromise and other values", () => {
    expect(isRestatePromiseActor(xstateFromPromise(async () => 1))).toBe(false);
    expect(isRestatePromiseActor(createMachine({ id: "m" }))).toBe(false);
    expect(isRestatePromiseActor(null)).toBe(false);
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
