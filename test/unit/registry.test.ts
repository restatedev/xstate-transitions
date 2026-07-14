import { describe, it, expect } from "vitest";
import { createMachine, fromPromise, setup } from "xstate";
import { buildRegistry, isMachine } from "../../src/xstate/registry";

describe("isMachine", () => {
  it("is true for a state machine", () => {
    expect(isMachine(createMachine({ id: "m" }))).toBe(true);
  });
  it("is false for promise actors, plain objects and null", () => {
    expect(isMachine(fromPromise(async () => 1))).toBe(false);
    expect(isMachine({})).toBe(false);
    expect(isMachine(null)).toBe(false);
    expect(isMachine("m")).toBe(false);
  });
});

describe("buildRegistry", () => {
  it("includes the root machine", () => {
    const root = createMachine({ id: "root" });
    const registry = buildRegistry(root);
    expect(registry.get("root")).toBe(root);
  });

  it("includes child machines registered via setup actors", () => {
    const child = createMachine({ id: "child" });
    const root = setup({ actors: { child } }).createMachine({
      id: "root",
      invoke: { src: "child" },
    });
    const registry = buildRegistry(root);
    expect(registry.get("child")).toBe(child);
  });

  it("includes child machines referenced directly as invoke.src", () => {
    const child = createMachine({ id: "child" });
    const root = createMachine({
      id: "root",
      invoke: { src: child },
    });
    const registry = buildRegistry(root);
    expect(registry.get("child")).toBe(child);
  });

  it("recurses into grandchildren", () => {
    const grandchild = createMachine({ id: "grandchild" });
    const child = setup({ actors: { grandchild } }).createMachine({
      id: "child",
      invoke: { src: "grandchild" },
    });
    const root = setup({ actors: { child } }).createMachine({
      id: "root",
      invoke: { src: "child" },
    });
    const registry = buildRegistry(root);
    expect(registry.get("grandchild")).toBe(grandchild);
    expect([...registry.keys()].sort()).toEqual([
      "child",
      "grandchild",
      "root",
    ]);
  });
});
