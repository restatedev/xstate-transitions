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
import { setup } from "xstate";
import { fromHandler } from "../../src";
import { wait } from "./eventually.js";
import { describeE2E } from "./harness";

const machineFactory = (executor: () => Promise<void>) => {
  const taskMachine = setup({
    actorSources: {
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
      running: { invoke: { onDone: { target: "finished" }, src: "execute" } },
      finished: { type: "final" },
    },
  });

  return setup({
    actorSources: { task: taskMachine },
  }).createMachine({
    id: "delayedStarter",
    initial: "ready",
    context: { taskRef: null as unknown },
    states: {
      ready: {
        entry: (_, enq) => ({
          context: {
            taskRef: enq.spawn(taskMachine, { id: "task" }),
          },
        }),
        on: {
          START_DELAYED: ({ children }, enq) => {
            enq.sendTo(
              children.task,
              { type: "START" },
              { delay: 1000, id: "startDelay" },
            );
            return { target: "pending" };
          },
        },
      },
      pending: {
        on: {
          CANCEL: (_, enq) => {
            enq.cancel("startDelay");
            return { target: "ready" };
          },
        },
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
