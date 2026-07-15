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

  it("allows the same machine instance to be registered under multiple actor names", () => {
    const child = createMachine({ id: "child" });
    const root = setup({
      actors: { first: child, second: child },
    }).createMachine({ id: "root" });

    expect(buildRegistry(root).get("child")).toBe(child);
  });

  it("rejects distinct machines with the same id", () => {
    const first = createMachine({ id: "duplicate" });
    const second = createMachine({ id: "duplicate" });
    const root = setup({ actors: { first, second } }).createMachine({
      id: "root",
    });

    expect(() => buildRegistry(root)).toThrow(
      'Machine id "duplicate" is used by more than one machine',
    );
  });
});
