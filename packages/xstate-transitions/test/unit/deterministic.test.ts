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
 * Deterministic transition-resolution edge cases, ported from upstream xstate
 * `deterministic.test.ts`. In our rehydrate-per-request model each of these must
 * resolve identically whether computed in one pass or after a snapshot round
 * trip: an unhandled event is a silent no-op, an event bubbles to an ancestor
 * that can handle it, and a forbidden (`undefined`) transition blocks that
 * bubbling.
 */

import { describe, expect, it } from "vitest";
import { createMachine } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { Step, StoredState } from "../../src/xstate/types";

const lightMachine = () =>
  createMachine({
    id: "light",
    initial: "green",
    states: {
      green: {
        on: { TIMER: { target: "yellow" }, POWER_OUTAGE: { target: "red" } },
      },
      yellow: {
        on: { TIMER: { target: "red" }, POWER_OUTAGE: { target: "red" } },
      },
      red: {
        on: { TIMER: { target: "green" }, POWER_OUTAGE: { target: "red" } },
        initial: "walk",
        states: {
          walk: {
            on: {
              PED_COUNTDOWN: { target: "wait" },
              TIMER: undefined, // forbidden: blocks the ancestor's TIMER
            },
          },
          wait: {
            on: {
              PED_COUNTDOWN: { target: "stop" },
              TIMER: undefined, // forbidden
            },
          },
          stop: {},
        },
      },
    },
  });

// Start an instance and apply a sequence of events, round-tripping the persisted
// state before each step, returning the last Step.
function drive(
  machine: Parameters<typeof initialStep>[0],
  events: string[],
): Step {
  let step = initialStep(machine, { isChild: false });
  for (const type of events) {
    step = resumeStep(machine, {
      stored: JSON.parse(JSON.stringify(step.nextState)) as StoredState,
      event: { type },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
  }
  return step;
}

describe("deterministic transitions", () => {
  it("treats an unhandled event as a silent no-op with no effects", () => {
    const result = drive(lightMachine(), ["BOGUS"]);
    expect(result.nextState.value).toBe("green");
    expect(result.effects).toEqual([]);
  });

  it("bubbles an event up to an ancestor when the active leaf cannot handle it", () => {
    // Drive to { red: 'stop' }, where 'stop' has no TIMER handler; TIMER must
    // bubble to the `red` ancestor (TIMER -> green).
    const atStop = drive(lightMachine(), [
      "POWER_OUTAGE", // -> { red: 'walk' }
      "PED_COUNTDOWN", // -> { red: 'wait' }
      "PED_COUNTDOWN", // -> { red: 'stop' }
    ]);
    expect(atStop.nextState.value).toEqual({ red: "stop" });

    const bubbled = resumeStep(lightMachine(), {
      stored: JSON.parse(JSON.stringify(atStop.nextState)) as StoredState,
      event: { type: "TIMER" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(bubbled.nextState.value).toBe("green");
  });

  it("blocks bubbling when the active leaf forbids the event (undefined transition)", () => {
    // At { red: 'walk' } the `walk` leaf declares TIMER: undefined, which forbids
    // the event and prevents it from bubbling to `red`'s TIMER -> green.
    const atWalk = drive(lightMachine(), ["POWER_OUTAGE"]);
    expect(atWalk.nextState.value).toEqual({ red: "walk" });

    const blocked = resumeStep(lightMachine(), {
      stored: JSON.parse(JSON.stringify(atWalk.nextState)) as StoredState,
      event: { type: "TIMER" },
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
    expect(blocked.nextState.value).toEqual({ red: "walk" });
    expect(blocked.effects).toEqual([]);
  });
});
