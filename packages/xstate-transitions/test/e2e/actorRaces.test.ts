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
 * Actor work executes independently of the exclusive machine handler. A late
 * outcome must therefore be rejected whenever its execution was cancelled by
 * another actor winning the race or by create() replacing the whole instance.
 */

import { expect, it, vi } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { wait } from "./eventually.js";
import { describeE2E } from "./harness";

interface PendingRun {
  id: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

const deferredWork = (pending: PendingRun[]) =>
  fromPromise<string, { id: string }>(
    ({ input }) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ id: input.id, resolve, reject });
      }),
  );

describeE2E("Actor completion races", (createActor) => {
  it(
    "ignores a loser that rejects after another actor exits the race",
    { timeout: 30_000 },
    async () => {
      const pending: PendingRun[] = [];
      const machine = setup({
        schemas: { context: types<{ winner?: string }>() },
        actorSources: { work: deferredWork(pending) },
      }).createMachine({
        id: "actor-winner-loser",
        context: {},
        initial: "racing",
        states: {
          racing: {
            invoke: [
              {
                id: "a",
                src: "work",
                input: { id: "a" },
                onDone: {
                  target: "done",
                  context: ({ output }) => ({ winner: output }),
                },
              },
              {
                id: "b",
                src: "work",
                input: { id: "b" },
                onDone: {
                  target: "done",
                  context: ({ output }) => ({ winner: output }),
                },
              },
            ],
          },
          done: { type: "final" },
        },
      });

      using actor = await createActor<{
        status: string;
        value: string;
        context: { winner?: string };
      }>({ machine });

      await vi.waitFor(() => expect(pending).toHaveLength(2));
      const winner = pending.find(({ id }) => id === "a");
      const loser = pending.find(({ id }) => id === "b");
      if (!winner || !loser) throw new Error("Expected both racing actors");

      winner.resolve("a");
      await expect(
        actor.waitFor("done", undefined, 5_000),
      ).resolves.toMatchObject({
        status: "done",
        value: "done",
        context: { winner: "a" },
      });

      loser.reject(new Error("late loser failure"));
      await wait(250);
      expect(await actor.snapshot()).toMatchObject({
        status: "done",
        context: { winner: "a" },
      });
      expect(pending).toHaveLength(2);
    },
  );

  it(
    "ignores an actor completion from the instance before create",
    { timeout: 30_000 },
    async () => {
      const pending: PendingRun[] = [];
      const machine = setup({
        schemas: {
          input: types<{ generation: number }>(),
          context: types<{ generation: number; result?: string }>(),
        },
        actorSources: { work: deferredWork(pending) },
      }).createMachine({
        id: "actor-recreate-race",
        context: ({ input }) => ({ generation: input.generation }),
        initial: "running",
        states: {
          running: {
            invoke: {
              id: "work",
              src: "work",
              input: ({ context }) => ({ id: String(context.generation) }),
              onDone: {
                target: "done",
                context: ({ output }) => ({ result: output }),
              },
            },
          },
          done: { type: "final" },
        },
      });

      using actor = await createActor<{
        status: string;
        value: string;
        context: { generation: number; result?: string };
      }>({ machine, input: { generation: 1 } });

      await vi.waitFor(() => expect(pending).toHaveLength(1));
      await actor.create({ generation: 2 });
      await vi.waitFor(() => expect(pending).toHaveLength(2));

      const stale = pending.find(({ id }) => id === "1");
      const current = pending.find(({ id }) => id === "2");
      if (!stale || !current)
        throw new Error("Expected actors from both instances");

      stale.resolve("stale");
      await wait(250);
      expect(await actor.snapshot()).toMatchObject({
        status: "active",
        value: "running",
        context: { generation: 2 },
      });

      current.resolve("current");
      await expect(
        actor.waitFor("done", undefined, 5_000),
      ).resolves.toMatchObject({
        status: "done",
        value: "done",
        context: { generation: 2, result: "current" },
      });
      expect(pending).toHaveLength(2);
    },
  );
});
