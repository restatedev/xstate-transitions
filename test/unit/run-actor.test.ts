import { describe, expect, it, vi } from "vitest";
import * as restate from "@restatedev/restate-sdk";
import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import { fromPromise as xstateFromPromise, setup } from "xstate";
import { fromPromise } from "../../src/restate/promise";
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

const fakeContext = { key: "machine-key" } as ObjectSharedContext;

describe("runActor", () => {
  it("passes Restate context and actor input to a Restate-aware promise", async () => {
    const creator = vi.fn(
      async ({
        input,
      }: {
        input: { value: number };
        ctx: ObjectSharedContext;
      }) => input.value * 2,
    );
    const machine = setup({
      actors: { work: fromPromise(creator) },
    }).createMachine({
      id: "machine",
      invoke: { id: "work", src: "work", input: { value: 21 } },
    });

    const event = await runActor(machine, invokedParams(machine), fakeContext);

    expect(creator).toHaveBeenCalledWith({
      input: { value: 21 },
      ctx: fakeContext,
    });
    expect(event).toEqual({
      type: "xstate.done.actor.work",
      output: 42,
      actorId: "work",
    });
  });

  it("converts TerminalError into an actor error event", async () => {
    const machine = setup({
      actors: {
        work: fromPromise(async () => {
          throw new restate.TerminalError("invalid input", { errorCode: 422 });
        }),
      },
    }).createMachine({
      id: "machine",
      invoke: { id: "work", src: "work" },
    });

    await expect(
      runActor(machine, invokedParams(machine), fakeContext),
    ).resolves.toMatchObject({
      type: "xstate.error.actor.work",
      error: { message: "invalid input" },
      actorId: "work",
    });
  });

  it("rethrows transient errors so Restate can retry the invocation", async () => {
    const transient = new Error("try again");
    const machine = setup({
      actors: {
        work: fromPromise(async () => {
          throw transient;
        }),
      },
    }).createMachine({
      id: "machine",
      invoke: { id: "work", src: "work" },
    });

    await expect(
      runActor(machine, invokedParams(machine), fakeContext),
    ).rejects.toBe(transient);
  });

  it("turns vanilla promise rejection into a serializable actor error", async () => {
    const machine = setup({
      actors: {
        work: xstateFromPromise(async () => {
          throw new TypeError("boom");
        }),
      },
    }).createMachine({
      id: "machine",
      invoke: { id: "work", src: "work" },
    });

    await expect(
      runActor(machine, invokedParams(machine), fakeContext),
    ).resolves.toEqual({
      type: "xstate.error.actor.work",
      error: { name: "TypeError", message: "boom" },
      actorId: "work",
    });
  });
});
