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
 * Cross-object messaging and delayed-event cancellation.
 *
 * Exercises all three of:
 *   (a) a spawned CHILD state-machine actor with stable identity (its own
 *       Restate virtual object, keyed `${parentKey}::task`),
 *   (b) a delayed inter-actor sendTo(child, START, { delay, id }),
 *   (c) cancel(id) of that scheduled event.
 *
 * The child's `execute` actor uses fromHandler so it gets a ctx (ctx.run) inside
 * the child object.
 */

import { expect, it, vi } from "vitest";
import { assign, cancel, sendTo, setup } from "xstate";
import { fromHandler } from "../../src";
import { wait } from "./eventually.js";
import { describeE2E } from "./harness";

type MachineEvents = { type: "START_DELAYED" } | { type: "CANCEL" };
type TaskEvents = { type: "START" };

const machineFactory = (executor: () => Promise<void>) => {
  const taskMachine = setup({
    types: { events: {} as TaskEvents },
    actors: {
      execute: fromHandler(async ({ ctx }) => {
        await ctx.run("Execute", async () => {
          await executor();
        });
      }),
    },
  }).createMachine({
    id: "task",
    initial: "idle",
    states: {
      idle: { on: { START: { target: "running" } } },
      running: { invoke: { onDone: "finished", src: "execute" } },
      finished: { type: "final" },
    },
  });

  return setup({
    actors: { task: taskMachine },
    types: { events: {} as MachineEvents },
    actions: {
      scheduleStart: sendTo(
        "task",
        { type: "START" },
        {
          delay: 1000,
          id: "startDelay",
        },
      ),
      cancelStart: cancel("startDelay"),
    },
  }).createMachine({
    id: "delayedStarter",
    initial: "ready",
    context: { taskRef: null },
    states: {
      ready: {
        entry: assign({
          taskRef: ({ spawn }) => spawn("task", { id: "task" }),
        }),
        on: {
          START_DELAYED: { actions: "scheduleStart", target: "pending" },
        },
      },
      pending: {
        on: { CANCEL: { actions: "cancelStart", target: "ready" } },
      },
    },
  });
};

describeE2E("Scheduled events", (createActor) => {
  it("should run delayed actions", { timeout: 20_000 }, async () => {
    const executor = vi.fn<() => Promise<void>>();
    using actor = await createActor<{ value?: string }>({
      machine: machineFactory(executor),
    });
    await actor.send({ type: "START_DELAYED" });
    await wait(500);
    expect(executor).not.toHaveBeenCalled();
    await wait(1000);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
  });

  it("should cancel delayed actions", { timeout: 20_000 }, async () => {
    const executor = vi.fn<() => Promise<void>>();
    using actor = await createActor<{ value?: string }>({
      machine: machineFactory(executor),
    });
    await actor.send({ type: "START_DELAYED" });
    await wait(500);
    await actor.send({ type: "CANCEL" });
    await wait(1000);
    expect(executor).not.toHaveBeenCalled();
  });
});
