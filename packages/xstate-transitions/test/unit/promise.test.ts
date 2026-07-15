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
import { createAsyncLogic, createMachine } from "xstate";
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

  it("is false for a vanilla xstate actor and other values", () => {
    expect(isRestateActor(createAsyncLogic({ run: async () => 1 }))).toBe(
      false,
    );
    expect(isRestateActor(createMachine({ id: "m" }))).toBe(false);
    // sentinel + kind but no callable config -> rejected.
    expect(isRestateActor({ sentinel: RESTATE_ACTOR, kind: "promise" })).toBe(
      false,
    );
    expect(isRestateActor(null)).toBe(false);
  });
});

describe("actor kinds", () => {
  it("fromPromise is a 'promise' actor; without retry it is fail-fast (no policy)", () => {
    for (const actor of [
      tagOf(fromPromise(async () => 1)),
      tagOf(fromPromise(async () => 1, { retry: false })),
    ]) {
      expect(actor.kind).toBe("promise");
      if (actor.kind === "promise") {
        expect(actor.retry).toBeUndefined();
      }
    }
  });

  it("fromPromise with retry: true is a 'promise' actor carrying the default policy", () => {
    const actor = tagOf(fromPromise(async () => 1, { retry: true }));
    expect(actor.kind).toBe("promise");
    if (actor.kind === "promise") {
      expect(actor.retry).toEqual({});
    }
  });

  it("fromPromise with a policy is a 'promise' actor carrying it verbatim", () => {
    const policy = { maxRetryAttempts: 3, initialRetryInterval: 100 };
    const actor = tagOf(fromPromise(async () => 1, { retry: policy }));
    expect(actor.kind).toBe("promise");
    if (actor.kind === "promise") {
      expect(actor.retry).toEqual(policy);
    }
  });

  it("fromHandler is a 'handler' actor", () => {
    expect(tagOf(fromHandler(async () => 1)).kind).toBe("handler");
  });
});
