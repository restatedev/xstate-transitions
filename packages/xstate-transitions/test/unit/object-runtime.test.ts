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
import { createMachine, setup } from "xstate";
import { MachineRuntime } from "../../src/restate/object";

describe("machine object runtime", () => {
  const child = createMachine({ id: "child" });
  const root = setup({ actors: { child } }).createMachine({ id: "root" });
  const runtime = new MachineRuntime("machines", root, undefined);

  it("uses the root machine when an instance has no persisted machine id", () => {
    expect(runtime.resolveMachine(null)).toBe(root);
  });

  it("resolves a registered child machine by its persisted id", () => {
    expect(runtime.resolveMachine("child")).toBe(child);
  });

  it("rejects an unregistered persisted machine id", () => {
    expect(() => runtime.resolveMachine("missing")).toThrow(
      'No machine with id "missing" is registered for this object.',
    );
  });
});
