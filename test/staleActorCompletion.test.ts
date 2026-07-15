import { assign, setup } from "xstate";
import { expect, it, vi } from "vitest";
import { fromPromise } from "../src";
import { describeE2E } from "./harness";
import { wait } from "./eventually";

interface PendingRun {
  generation: number;
  resolve: (value: string) => void;
}

describeE2E("Actor execution generations", (createActor) => {
  it(
    "ignores a late completion from a re-entered promise invoke",
    { timeout: 30_000 },
    async () => {
      const pending: PendingRun[] = [];
      const work = fromPromise<string, { generation: number }>(
        ({ input }) =>
          new Promise<string>((resolve) => {
            pending.push({ generation: input.generation, resolve });
          }),
      );
      const machine = setup({
        types: {
          context: {} as { generation: number; result?: string },
          events: {} as { type: "REENTER" },
        },
        actors: { work },
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
                actions: assign({ result: ({ event }) => event.output }),
              },
            },
            on: {
              REENTER: {
                target: "running",
                reenter: true,
                actions: assign({
                  generation: ({ context }) => context.generation + 1,
                }),
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
});
