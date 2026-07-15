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

import { expect, it, vi } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { wait } from "./eventually";
import { describeE2E } from "./harness";

interface PendingRun {
  generation: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function generationMachine(pending: PendingRun[]) {
  const work = fromPromise<string, { generation: number }>(
    ({ input }) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ generation: input.generation, resolve, reject });
      }),
  );

  return setup({
    schemas: {
      context: types<{ generation: number; result?: string }>(),
    },
    actorSources: { work },
  }).createMachine({
    id: "stale-promise-completion",
    context: { generation: 1 },
    initial: "running",
    states: {
      running: {
        invoke: {
          id: "work",
          src: "work",
          input: ({ context }) => ({ generation: context.generation }),
          onDone: {
            target: "done",
            context: ({ output }) => ({ result: output }),
          },
          onError: { target: "failed" },
        },
        on: {
          REENTER: {
            target: "running",
            reenter: true,
            context: ({ context }) => ({
              generation: context.generation + 1,
            }),
          },
        },
      },
      done: { type: "final" },
      failed: { type: "final" },
    },
  });
}

describeE2E("Actor execution generations", (createActor) => {
  it(
    "ignores a late completion from a re-entered promise invoke",
    { timeout: 30_000 },
    async () => {
      const pending: PendingRun[] = [];
      const machine = generationMachine(pending);

      using actor = await createActor<{
        status: string;
        value: string;
        context: { generation: number; result?: string };
      }>({ machine });

      await vi.waitFor(() => expect(pending).toHaveLength(1));
      await actor.send({ type: "REENTER" });
      await vi.waitFor(() => expect(pending).toHaveLength(2));

      const stale = pending.find((run) => run.generation === 1);
      const current = pending.find((run) => run.generation === 2);
      if (!stale || !current)
        throw new Error("Expected both actor generations");

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
    },
  );

  it(
    "ignores a late rejection from a re-entered promise invoke",
    { timeout: 30_000 },
    async () => {
      const pending: PendingRun[] = [];
      using actor = await createActor<{
        status: string;
        value: string;
        context: { generation: number; result?: string };
      }>({ machine: generationMachine(pending) });

      await vi.waitFor(() => expect(pending).toHaveLength(1));
      await actor.send({ type: "REENTER" });
      await vi.waitFor(() => expect(pending).toHaveLength(2));

      const stale = pending.find((run) => run.generation === 1);
      const current = pending.find((run) => run.generation === 2);
      if (!stale || !current)
        throw new Error("Expected both actor generations");

      stale.reject(new Error("stale failure"));
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
    },
  );
});
