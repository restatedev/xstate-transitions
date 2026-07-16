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
 * Parallel-state semantics, ported from upstream xstate `parallel.test.ts`.
 *
 * The durability-relevant bits here are the shapes we persist: the region-keyed
 * object a parallel `onDone`/`output` aggregates, and the entry set of a
 * reentering transition inside a region. Dynamic `output` functions must be
 * resolved to plain values before that aggregated event is persisted — a
 * snapshot cannot carry functions. Upstream reads these via `enq(() =>
 * spy(...))`; we capture the aggregated `event.output` into context (or read
 * `returned.output`) instead.
 */

import { describe, expect, it } from "vitest";
import { setup, types } from "xstate";
import { initialStep, resumeStep } from "../../src/xstate/interpret";
import type { Step, StoredState } from "../../src/xstate/types";

// Start an instance and drive it through a sequence of events, round-tripping the
// persisted state before each step exactly as the Restate object does.
function drive(
  machine: Parameters<typeof initialStep>[0],
  events: Array<{ type: string; [k: string]: unknown }>,
): Step {
  let step = initialStep(machine, { isChild: false });
  for (const event of events) {
    step = resumeStep(machine, {
      stored: JSON.parse(JSON.stringify(step.nextState)) as StoredState,
      event,
      isChild: false,
      knownChildIds: [],
      knownPromiseIds: [],
    });
  }
  return step;
}

describe("parallel onDone output aggregation", () => {
  it("aggregates region outputs into a region-keyed object", () => {
    type Ctx = { done?: unknown };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "m",
        context: {},
        initial: "processing",
        states: {
          processing: {
            type: "parallel",
            states: {
              upload: {
                initial: "pending",
                states: {
                  pending: { on: { UPLOADED: { target: "done" } } },
                  done: { type: "final", output: { url: "/file.png" } },
                },
              },
              validate: {
                initial: "checking",
                states: {
                  checking: { on: { VALID: { target: "done" } } },
                  done: { type: "final", output: { valid: true } },
                },
              },
            },
            onDone: ({ event }) => ({
              target: "success",
              context: { done: event.output },
            }),
          },
          success: { type: "final" },
        },
      },
    );

    const result = drive(machine, [{ type: "UPLOADED" }, { type: "VALID" }]);
    expect(result.nextState.value).toBe("success");
    expect((result.nextState.context as Ctx).done).toEqual({
      upload: { url: "/file.png" },
      validate: { valid: true },
    });
  });

  it("includes an undefined entry for a region without output", () => {
    type Ctx = { done?: Record<string, unknown> };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "m",
        context: {},
        initial: "processing",
        states: {
          processing: {
            type: "parallel",
            states: {
              withOutput: {
                initial: "active",
                states: {
                  active: { on: { DONE_A: { target: "done" } } },
                  done: { type: "final", output: { data: 42 } },
                },
              },
              withoutOutput: {
                initial: "active",
                states: {
                  active: { on: { DONE_B: { target: "done" } } },
                  done: { type: "final" },
                },
              },
            },
            onDone: ({ event }) => ({
              target: "success",
              context: { done: event.output as Record<string, unknown> },
            }),
          },
          success: { type: "final" },
        },
      },
    );

    const done = (
      drive(machine, [{ type: "DONE_A" }, { type: "DONE_B" }]).nextState
        .context as Ctx
    ).done;
    expect(done?.withOutput).toEqual({ data: 42 });
    expect(done && "withoutOutput" in done).toBe(true);
    expect(done?.withoutOutput).toBeUndefined();
  });

  it("resolves dynamic output functions to plain values before aggregation", () => {
    type Ctx = { count: number; done?: unknown };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "m",
        context: { count: 10 },
        initial: "processing",
        states: {
          processing: {
            type: "parallel",
            states: {
              a: {
                initial: "active",
                states: {
                  active: { on: { DONE: { target: "done" } } },
                  done: {
                    type: "final",
                    output: ({ context }) => ({ doubled: context.count * 2 }),
                  },
                },
              },
            },
            onDone: ({ event }) => ({
              target: "success",
              context: { done: event.output },
            }),
          },
          success: { type: "final" },
        },
      },
    );

    const done = (drive(machine, [{ type: "DONE" }]).nextState.context as Ctx)
      .done;
    // A concrete value, not a function, is what gets persisted.
    expect(done).toEqual({ a: { doubled: 20 } });
  });

  it("provides the aggregated output to an onDone guard for branching", () => {
    const machine = setup({}).createMachine({
      id: "m",
      initial: "processing",
      states: {
        processing: {
          type: "parallel",
          states: {
            a: {
              initial: "active",
              states: {
                active: { on: { DONE: { target: "done" } } },
                done: { type: "final", output: { ok: true } },
              },
            },
            b: {
              initial: "active",
              states: {
                active: { on: { DONE: { target: "done" } } },
                done: { type: "final", output: { ok: false } },
              },
            },
          },
          onDone: ({ event }) => {
            const output = event.output as {
              a: { ok: boolean };
              b: { ok: boolean };
            };
            return output.a.ok && output.b.ok
              ? { target: "allOk" }
              : { target: "someNotOk" };
          },
        },
        allOk: { type: "final" },
        someNotOk: { type: "final" },
      },
    });
    // Both regions reach final on the SAME event, in one macrostep.
    expect(drive(machine, [{ type: "DONE" }]).nextState.value).toBe(
      "someNotOk",
    );
  });

  it("aggregates output for a root parallel machine into its final output", () => {
    const machine = setup({}).createMachine({
      id: "m",
      type: "parallel",
      states: {
        a: {
          initial: "active",
          states: {
            active: { on: { DONE: { target: "final" } } },
            final: { type: "final", output: { from: "a" } },
          },
        },
        b: {
          initial: "active",
          states: {
            active: { on: { DONE: { target: "final" } } },
            final: { type: "final", output: { from: "b" } },
          },
        },
      },
      output: ({ event }) => ({ aggregated: event.output }),
    });

    const result = drive(machine, [{ type: "DONE" }]);
    expect(result.returned.status).toBe("done");
    expect(result.returned.output).toEqual({
      aggregated: { a: { from: "a" }, b: { from: "b" } },
    });
  });
});

describe("parallel transition semantics", () => {
  it("handles simultaneous orthogonal transitions and merges the result", () => {
    type Ctx = { value: string };
    const machine = setup({
      schemas: {
        context: types<Ctx>(),
        events: {
          CHANGE: types<{ value: string }>(),
          SAVE: types<Record<string, never>>(),
        },
      },
    }).createMachine({
      id: "editor",
      type: "parallel",
      context: { value: "" },
      states: {
        editing: {
          on: {
            CHANGE: ({ context, event }) => ({
              context: { ...context, value: event.value },
            }),
          },
        },
        status: {
          initial: "unsaved",
          states: {
            unsaved: { on: { SAVE: { target: "saved" } } },
            // A single CHANGE both writes context (in `editing`) and flips
            // status saved -> unsaved (in `status`).
            saved: { on: { CHANGE: { target: "unsaved" } } },
          },
        },
      },
    });

    const result = drive(machine, [
      { type: "SAVE" },
      { type: "CHANGE", value: "something" },
    ]);
    expect(result.nextState.value).toEqual({ editing: {}, status: "unsaved" });
    expect(result.nextState.context).toEqual({ value: "something" });
  });

  it("recomputes the entry set for a reentering transition inside a region", () => {
    type Ctx = { log: string[] };
    const machine = setup({ schemas: { context: types<Ctx>() } }).createMachine(
      {
        id: "test",
        type: "parallel",
        context: { log: [] },
        states: {
          foo: {
            initial: "foobar",
            states: {
              foobar: { on: { GOTO_FOOBAZ: { target: "foobaz" } } },
              foobaz: {
                entry: ({ context }) => ({
                  context: { log: [...context.log, "entered foobaz"] },
                }),
                on: {
                  GOTO_FOOBAZ: { target: "foobaz", reenter: true },
                },
              },
            },
          },
          bar: {},
        },
      },
    );

    // First send enters foobaz (log length 1); second is a reenter:true
    // self-transition that must re-run the entry (log length 2).
    const result = drive(machine, [
      { type: "GOTO_FOOBAZ" },
      { type: "GOTO_FOOBAZ" },
    ]);
    expect((result.nextState.context as Ctx).log).toEqual([
      "entered foobaz",
      "entered foobaz",
    ]);
  });
});
