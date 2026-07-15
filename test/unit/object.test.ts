import { createMachine } from "xstate";
import { describe, expect, it } from "vitest";
import { createMachineObject } from "../../src/restate/object";

describe("createMachineObject configuration", () => {
  const machine = createMachine({ id: "machine" });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid finalStateTTL %s",
    (finalStateTTL) => {
      expect(() =>
        createMachineObject("machine", machine, { finalStateTTL }),
      ).toThrow("finalStateTTL must be a finite, non-negative number");
    },
  );

  it("allows immediate cleanup with a zero TTL", () => {
    expect(() =>
      createMachineObject("machine", machine, { finalStateTTL: 0 }),
    ).not.toThrow();
  });
});
