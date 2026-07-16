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

/*
 * Tag derivation across transitions, ported from upstream xstate `tags.test.ts`.
 *
 * Tags back our `hasTag:*` wait condition and are exposed on every returned
 * snapshot. Because the snapshot is persisted and rehydrated on each request,
 * tags must be RE-DERIVED from the current (rehydrated) state value after each
 * transition — never carried over stale. These tests round-trip the persisted
 * state between steps so tag recomputation runs against the rehydrated value.
 */

import { describe, expect, it } from "vitest";
import { setup } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { StoredState } from "../../src/xstate/types";

const roundTrip = (stored: StoredState): StoredState =>
  JSON.parse(JSON.stringify(stored)) as StoredState;

describe("state tags", () => {
  it("recomputes tags across transitions and drops them when leaving a tagged state", () => {
    const machine = setup({}).createMachine({
      id: "light",
      initial: "green",
      states: {
        green: { tags: ["go"], on: { TIMER: { target: "yellow" } } },
        yellow: { tags: ["go"], on: { TIMER: { target: "red" } } },
        red: { tags: ["stop"], on: { TIMER: { target: "green" } } },
      },
    });

    const created = initialStep(machine, { isChild: false });
    expect(created.returned.tags).toContain("go");

    const yellow = resumeStep(machine, {
      stored: roundTrip(created.nextState),
      event: { type: "TIMER" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(yellow.returned.tags).toContain("go");

    const red = resumeStep(machine, {
      stored: roundTrip(yellow.nextState),
      event: { type: "TIMER" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    // Leaving the 'go'-tagged states drops the tag; 'stop' is derived fresh.
    expect(red.returned.tags).toContain("stop");
    expect(red.returned.tags).not.toContain("go");
  });

  it("aggregates tags from every active node of a parallel configuration", () => {
    const machine = setup({}).createMachine({
      id: "m",
      type: "parallel",
      states: {
        a: {
          initial: "a1",
          states: {
            a1: { tags: ["a-active"], on: { A: { target: "a2" } } },
            a2: { tags: ["a-done"] },
          },
        },
        b: {
          initial: "b1",
          states: { b1: { tags: ["b-active"] } },
        },
      },
    });

    const created = initialStep(machine, { isChild: false });
    expect(created.returned.tags).toEqual(
      expect.arrayContaining(["a-active", "b-active"]),
    );

    const moved = resumeStep(machine, {
      stored: roundTrip(created.nextState),
      event: { type: "A" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    // Region a flips its tag; region b's tag is preserved.
    expect(moved.returned.tags).toEqual(
      expect.arrayContaining(["a-done", "b-active"]),
    );
    expect(moved.returned.tags).not.toContain("a-active");
  });
});
