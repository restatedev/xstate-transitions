import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk";
import { describe, expect, it, vi } from "vitest";
import { setup, fromPromise as xstateFromPromise } from "xstate";
import { fromHandler, fromPromise } from "../../src/restate/promise";
import { runActor } from "../../src/restate/run-actor";
import { initialStep } from "../../src/xstate/interpret";
import type { SpawnParams } from "../../src/xstate/types";

function invokedParams(
  machine: Parameters<typeof initialStep>[0],
): SpawnParams {
  const effect = initialStep(machine, { isChild: false }).effects.find(
    (candidate) => candidate.kind === "runPromise",
  );
  if (effect?.kind !== "runPromise") {
    throw new Error("Expected the machine to invoke a promise actor");
  }
  return effect.params;
}

/**
 * A fake ObjectSharedContext whose `run` models Restate's ctx.run retry
 * contract: a TerminalError is never retried; a non-terminal error is retried up
 * to `maxRetryAttempts`, after which ctx.run throws a TerminalError wrapping the
 * last message. Records each call's name and options for assertions.
 */
function fakeContext(defaultMaxAttempts = 5) {
  const runCalls: { name: string; options: unknown }[] = [];
  const ctx = {
    key: "machine-key",
    run: async (
      name: string,
      action: () => unknown,
      options?: { maxRetryAttempts?: number },
    ) => {
      runCalls.push({ name, options });
      const cap = options?.maxRetryAttempts ?? defaultMaxAttempts;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await action();
        } catch (err) {
          if (err instanceof restate.TerminalError) throw err;
          if (attempt >= cap) {
            throw new restate.TerminalError(
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    },
  } as unknown as ObjectSharedContext;
  return { ctx, runCalls };
}

describe("runActor — fromPromise (ctx-less, wrapped in ctx.run)", () => {
  it("runs the ctx-less creator inside ctx.run and returns its output", async () => {
    const creator = vi.fn(
      async ({ input }: { input: { value: number } }) => input.value * 2,
    );
    const machine = setup({
      actors: { work: fromPromise(creator) },
    }).createMachine({
      id: "machine",
      invoke: { id: "work", src: "work", input: { value: 21 } },
    });
    const { ctx, runCalls } = fakeContext();

    const outcome = await runActor(machine, invokedParams(machine), ctx);

    // No Restate ctx is handed to the creator — that is fromHandler's job.
    expect(creator).toHaveBeenCalledWith({ input: { value: 21 } });
    expect(outcome).toEqual({ status: "done", output: 42 });
    // Fail-fast uses the 2-arg ctx.run (no retry options).
    expect(runCalls).toEqual([{ name: "actor:work", options: undefined }]);
  });

  it("is fail-fast by default: a rejection becomes a terminal error, not retried", async () => {
    const creator = vi
      .fn<(args: { input: unknown }) => Promise<string>>()
      .mockRejectedValue(new Error("nope"));
    const machine = setup({
      actors: { work: fromPromise(creator) },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx } = fakeContext();

    const outcome = await runActor(machine, invokedParams(machine), ctx);

    expect(creator).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: "error",
      error: { message: "nope" },
    });
  });

  it("retryable (retry: true) retries a transient rejection until it succeeds", async () => {
    const creator = vi
      .fn<(args: { input: unknown }) => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const machine = setup({
      actors: { work: fromPromise(creator, { retry: true }) },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx } = fakeContext();

    const outcome = await runActor(machine, invokedParams(machine), ctx);

    expect(creator).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({ status: "done", output: "ok" });
  });

  it("passes a custom retry policy through to ctx.run and fails terminally when exhausted", async () => {
    const creator = vi
      .fn<(args: { input: unknown }) => Promise<string>>()
      .mockRejectedValue(new Error("always"));
    const machine = setup({
      actors: {
        work: fromPromise(creator, { retry: { maxRetryAttempts: 2 } }),
      },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx, runCalls } = fakeContext();

    const outcome = await runActor(machine, invokedParams(machine), ctx);

    expect(creator).toHaveBeenCalledTimes(2);
    expect(runCalls[0]?.options).toEqual({ maxRetryAttempts: 2 });
    expect(outcome).toMatchObject({
      status: "error",
      error: { message: "always" },
    });
  });

  it("does not retry a TerminalError even when retry is enabled", async () => {
    const creator = vi
      .fn<(args: { input: unknown }) => Promise<string>>()
      .mockRejectedValue(new restate.TerminalError("fatal"));
    const machine = setup({
      actors: { work: fromPromise(creator, { retry: true }) },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx } = fakeContext();

    const outcome = await runActor(machine, invokedParams(machine), ctx);

    expect(creator).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status: "error",
      error: { message: "fatal" },
    });
  });
});

describe("runActor — fromHandler (ctx-aware)", () => {
  it("passes the Restate ctx and input to the handler creator", async () => {
    const creator = vi.fn(
      async ({ input }: { input: { v: number }; ctx: ObjectSharedContext }) =>
        input.v + 1,
    );
    const machine = setup({
      actors: { work: fromHandler(creator) },
    }).createMachine({
      id: "machine",
      invoke: { id: "work", src: "work", input: { v: 41 } },
    });
    const { ctx } = fakeContext();

    const outcome = await runActor(machine, invokedParams(machine), ctx);

    expect(creator).toHaveBeenCalledWith({ input: { v: 41 }, ctx });
    expect(outcome).toEqual({ status: "done", output: 42 });
  });

  it("converts a TerminalError into an actor error event", async () => {
    const machine = setup({
      actors: {
        work: fromHandler(async () => {
          throw new restate.TerminalError("invalid input", { errorCode: 422 });
        }),
      },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx } = fakeContext();

    await expect(
      runActor(machine, invokedParams(machine), ctx),
    ).resolves.toMatchObject({
      status: "error",
      error: { message: "invalid input" },
    });
  });

  it("rethrows a transient error so Restate can retry the invocation", async () => {
    const transient = new Error("try again");
    const machine = setup({
      actors: {
        work: fromHandler(async () => {
          throw transient;
        }),
      },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx } = fakeContext();

    await expect(runActor(machine, invokedParams(machine), ctx)).rejects.toBe(
      transient,
    );
  });
});

describe("runActor — vanilla xstate actor", () => {
  it("turns a vanilla promise rejection into a serializable actor error", async () => {
    const machine = setup({
      actors: {
        work: xstateFromPromise(async () => {
          throw new TypeError("boom");
        }),
      },
    }).createMachine({ id: "machine", invoke: { id: "work", src: "work" } });
    const { ctx } = fakeContext();

    await expect(
      runActor(machine, invokedParams(machine), ctx),
    ).resolves.toEqual({
      status: "error",
      error: { name: "TypeError", message: "boom" },
    });
  });
});
