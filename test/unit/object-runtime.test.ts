import { describe, expect, it } from "vitest";
import { createMachine, setup } from "xstate";
import {
  createMachineObjectRuntime,
  resolveMachine,
} from "../../src/restate/object/runtime";

describe("machine object runtime", () => {
  const child = createMachine({ id: "child" });
  const root = setup({ actors: { child } }).createMachine({ id: "root" });
  const runtime = createMachineObjectRuntime("machines", root, undefined);

  it("uses the root machine when an instance has no persisted machine id", () => {
    expect(resolveMachine(runtime, null)).toBe(root);
  });

  it("resolves a registered child machine by its persisted id", () => {
    expect(resolveMachine(runtime, "child")).toBe(child);
  });

  it("rejects an unregistered persisted machine id", () => {
    expect(() => resolveMachine(runtime, "missing")).toThrow(
      'No machine with id "missing" is registered for this object.',
    );
  });
});
