import { describe, expect, it } from "vitest";
import { createMachine, fromPromise as xstateFromPromise } from "xstate";
import type { RestateActor } from "../../src/restate/promise";
import {
  fromHandler,
  fromPromise,
  isRestateActor,
  RESTATE_ACTOR,
} from "../../src/restate/promise";

/** Narrow to the runtime tag, failing the test if it is not one of ours. */
function tagOf(logic: unknown): RestateActor {
  if (!isRestateActor(logic)) {
    throw new Error("expected a Restate-managed actor");
  }
  return logic;
}

describe("isRestateActor", () => {
  it("is true for fromPromise and fromHandler", () => {
    expect(isRestateActor(fromPromise(async () => 1))).toBe(true);
    expect(isRestateActor(fromHandler(async () => 1))).toBe(true);
  });

  it("is false for vanilla xstate fromPromise and other values", () => {
    expect(isRestateActor(xstateFromPromise(async () => 1))).toBe(false);
    expect(isRestateActor(createMachine({ id: "m" }))).toBe(false);
    // sentinel + kind but no callable config -> rejected.
    expect(isRestateActor({ sentinel: RESTATE_ACTOR, kind: "promise" })).toBe(
      false,
    );
    expect(isRestateActor(null)).toBe(false);
  });
});

describe("actor kinds", () => {
  it("fromPromise defaults to a fail-fast 'promise' actor", () => {
    expect(tagOf(fromPromise(async () => 1)).kind).toBe("promise");
    expect(tagOf(fromPromise(async () => 1, { retry: false })).kind).toBe(
      "promise",
    );
  });

  it("fromPromise with retry: true is a 'retryable' actor using the default policy", () => {
    const actor = tagOf(fromPromise(async () => 1, { retry: true }));
    expect(actor.kind).toBe("retryable");
    if (actor.kind === "retryable") {
      expect(actor.retry).toEqual({});
    }
  });

  it("fromPromise with a policy is a 'retryable' actor carrying it verbatim", () => {
    const policy = { maxRetryAttempts: 3, initialRetryInterval: 100 };
    const actor = tagOf(fromPromise(async () => 1, { retry: policy }));
    expect(actor.kind).toBe("retryable");
    if (actor.kind === "retryable") {
      expect(actor.retry).toEqual(policy);
    }
  });

  it("fromHandler is a 'handler' actor", () => {
    expect(tagOf(fromHandler(async () => 1)).kind).toBe("handler");
  });
});
