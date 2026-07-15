import { describe, expect, it } from "vitest";
import { createMachine } from "xstate";
import {
  classifyKnownActors,
  createMachineObject,
} from "../../src/restate/object";

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

  it("documents public handlers and marks every internal handler", () => {
    const definition = createMachineObject("machine", machine);
    const handlers = getRuntimeHandlers(definition);

    expect(definition).toMatchObject({ description: expect.any(String) });

    for (const name of ["create", "send", "snapshot", "subscribe", "waitFor"]) {
      expect(getHandlerOptions(handlers[name])).toMatchObject({
        description: expect.any(String),
      });
    }

    for (const name of [
      "initChild",
      "deliverEvent",
      "actorDone",
      "actorError",
      "deliverScheduled",
      "executeActor",
      "cleanupState",
    ]) {
      expect(getHandlerOptions(handlers[name])).toMatchObject({
        description: expect.any(String),
        ingressPrivate: true,
        metadata: { "restate.xstate.internal": "true" },
      });
    }

    expect(getHandlerOptions(handlers.executeActor)).toMatchObject({
      enableLazyState: true,
    });
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

interface HandlerOptions {
  readonly description?: unknown;
  readonly enableLazyState?: unknown;
  readonly ingressPrivate?: unknown;
  readonly metadata?: unknown;
}

function getRuntimeHandlers(definition: unknown): Record<string, unknown> {
  if (
    typeof definition !== "object" ||
    definition === null ||
    !("object" in definition) ||
    typeof definition.object !== "object" ||
    definition.object === null
  ) {
    throw new TypeError("Expected a Restate virtual object definition");
  }

  return definition.object as Record<string, unknown>;
}

function getHandlerOptions(handler: unknown): HandlerOptions {
  if (typeof handler !== "function") {
    throw new TypeError("Expected a Restate handler function");
  }

  for (const symbol of Object.getOwnPropertySymbols(handler)) {
    const wrapper: unknown = Reflect.get(handler, symbol);
    if (typeof wrapper !== "object" || wrapper === null) continue;

    const options: unknown = Reflect.get(wrapper, "options");
    if (typeof options === "object" && options !== null) {
      return options as HandlerOptions;
    }
  }

  throw new TypeError("Expected a configured Restate handler");
}
