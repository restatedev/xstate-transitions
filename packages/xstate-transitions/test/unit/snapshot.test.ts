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
import type { AnyMachineSnapshot } from "xstate";
import { assign, createMachine, initialTransition, transition } from "xstate";
import {
  fromStored,
  toReturnedSnapshot,
  toStored,
} from "../../src/xstate/snapshot";

const jsonRoundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("toStored / fromStored", () => {
  const counter = createMachine({
    types: {} as { context: { n: number } },
    id: "counter",
    context: { n: 0 },
    initial: "idle",
    states: {
      idle: {
        on: { inc: { actions: assign({ n: ({ context }) => context.n + 1 }) } },
      },
    },
  });

  it("keeps only serializable fields", () => {
    const [snapshot] = initialTransition(counter);
    const stored = toStored(snapshot as AnyMachineSnapshot);
    expect(Object.keys(stored).sort()).toEqual([
      "context",
      "error",
      "historyValue",
      "output",
      "status",
      "value",
    ]);
    expect(stored.value).toBe("idle");
    expect(stored.context).toEqual({ n: 0 });
    expect(stored.status).toBe("active");
  });

  it("round-trips value/context/status through JSON", () => {
    let [snapshot] = initialTransition(counter);
    for (let i = 0; i < 5; i++) {
      const stored = jsonRoundTrip(toStored(snapshot as AnyMachineSnapshot));
      [snapshot] = transition(counter, fromStored(counter, stored), {
        type: "inc",
      } as never);
    }
    expect((snapshot as AnyMachineSnapshot).context).toEqual({ n: 5 });
  });
});

describe("toReturnedSnapshot", () => {
  it("materializes tags as a sorted array and drops methods", () => {
    const machine = createMachine({
      id: "m",
      initial: "a",
      states: { a: { tags: ["z", "a", "m"] } },
    });
    const [snapshot] = initialTransition(machine);
    const returned = toReturnedSnapshot(snapshot as AnyMachineSnapshot);
    expect(returned.tags).toEqual(["a", "m", "z"]);
    expect(returned.value).toBe("a");
    expect(returned.status).toBe("active");
    // plain object -> survives JSON unchanged
    expect(jsonRoundTrip(returned)).toEqual(returned);
  });

  it("exposes output on a final snapshot", () => {
    const machine = createMachine({
      id: "m",
      initial: "done",
      states: { done: { type: "final" } },
      output: () => ({ done: true }),
    });
    const [snapshot] = initialTransition(machine);
    const returned = toReturnedSnapshot(snapshot as AnyMachineSnapshot);
    expect(returned.status).toBe("done");
    expect(returned.output).toEqual({ done: true });
  });
});
