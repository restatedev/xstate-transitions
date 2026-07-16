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
 * Event-descriptor matching and selection priority, ported from upstream xstate
 * `eventDescriptors.test.ts`. This matching is static and deterministic and
 * passes straight through our integration, but we had no coverage of it — and it
 * governs which transition (hence which effects) an event selects, so it is part
 * of the deterministic result we persist and replay.
 */

import { describe, expect, it } from "vitest";
import { createMachine } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { StoredState } from "../../src/xstate/types";

// Send one event to a freshly-created instance and return the settled value.
function sendOnce(
  machine: Parameters<typeof initialStep>[0],
  type: string,
): unknown {
  const created = initialStep(machine, { isChild: false });
  const result = resumeStep(machine, {
    stored: created.nextState as StoredState,
    event: { type },
    isChild: false,
    knownChildIds: [],
    knownPromiseIds: [],
  });
  return result.nextState.value;
}

describe("event descriptors", () => {
  it("falls back to a wildcard transition when no explicit descriptor matches", () => {
    const machine = createMachine({
      id: "m",
      initial: "A",
      states: {
        A: { on: { FOO: { target: "B" }, "*": { target: "C" } } },
        B: {},
        C: {},
      },
    });
    expect(sendOnce(machine, "BAR")).toBe("C");
  });

  it("prioritizes an explicit descriptor even if the wildcard comes first", () => {
    const machine = createMachine({
      id: "m",
      initial: "A",
      states: {
        A: { on: { "*": { target: "fail" }, NEXT: { target: "pass" } } },
        fail: {},
        pass: {},
      },
    });
    expect(sendOnce(machine, "NEXT")).toBe("pass");
  });

  it("prioritizes an exact descriptor over a partial one that comes first", () => {
    const machine = createMachine({
      id: "m",
      initial: "A",
      states: {
        A: {
          on: { "foo.*": { target: "fail" }, "foo.bar": { target: "pass" } },
        },
        fail: {},
        pass: {},
      },
    });
    expect(sendOnce(machine, "foo.bar")).toBe("pass");
  });

  it("prioritizes a longer partial descriptor over a shorter one that comes first", () => {
    const machine = createMachine({
      id: "m",
      initial: "A",
      states: {
        A: {
          on: {
            "foo.*": { target: "fail" },
            "foo.bar.*": { target: "pass" },
          },
        },
        fail: {},
        pass: {},
      },
    });
    expect(sendOnce(machine, "foo.bar.baz")).toBe("pass");
  });

  it("supports prefix matching with a trailing wildcard (+0, +1, +n)", () => {
    const machine = createMachine({
      id: "m",
      initial: "start",
      states: {
        start: { on: { "event.*": { target: "success" } } },
        success: { type: "final" },
      },
    });
    expect(sendOnce(machine, "event")).toBe("success");
    expect(sendOnce(machine, "event.whatever")).toBe("success");
    expect(sendOnce(machine, "event.first.second")).toBe("success");
    // A token that merely shares a prefix string must NOT match.
    expect(sendOnce(machine, "eventually")).toBe("start");
    expect(sendOnce(machine, "eventually.event")).toBe("start");
  });

  it("does not match infix wildcards", () => {
    const machine = createMachine({
      id: "m",
      initial: "start",
      states: {
        start: {
          on: {
            "event.*.bar.*": { target: "success" },
            "*.event.*": { target: "success" },
          },
        },
        success: { type: "final" },
      },
    });
    expect(sendOnce(machine, "event.foo.bar.first.second")).toBe("start");
  });
});
