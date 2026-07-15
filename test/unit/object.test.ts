import { createMachine } from "xstate";
import { describe, expect, it } from "vitest";
import { createMachineObject } from "../../src/restate/object";
import { classifyKnownActors } from "../../src/restate/object/actor-state";

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

describe("classifyKnownActors", () => {
  it("separates child machines from promise actor executions", () => {
    const children = {
      child: { key: "child-key", machineId: "child-machine" },
    };
    const actorExecutions = {
      child: "child-execution",
      promise: "promise-execution",
    };

    expect(classifyKnownActors(children, actorExecutions)).toEqual({
      knownChildIds: ["child"],
      knownPromiseIds: ["promise"],
    });
  });

  it("classifies every actor execution as a promise without child records", () => {
    expect(classifyKnownActors({}, { first: "one", second: "two" })).toEqual({
      knownChildIds: [],
      knownPromiseIds: ["first", "second"],
    });
  });
});
