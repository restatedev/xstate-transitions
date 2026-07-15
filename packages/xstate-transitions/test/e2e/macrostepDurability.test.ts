/*
 * Restate journals the complete Step produced by one XState macrostep. These
 * cases deliberately perform several nondeterministic observations inside a
 * transition and couple the resulting snapshot to an emitted actor effect.
 */

import { expect, it } from "vitest";
import { assign, raise, setup } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

interface JournalSnapshot {
  value: string;
  context: {
    first: number;
    second: number;
    latest: number[];
    delivered: number[][];
  };
}

describeE2E("Macrostep durability", (createActor) => {
  it(
    "journals several observations and their emitted effect as one Step",
    { timeout: 60_000 },
    async () => {
      let observations = 0;
      let actorRuns = 0;
      const observe = () => ++observations;

      const echo = fromPromise<number[], number[]>(async ({ input }) => {
        actorRuns += 1;
        return [...input];
      });

      const machine = setup({
        types: {
          context: {} as JournalSnapshot["context"],
          events: {} as
            | { type: "STAMP" }
            | {
                type: "CAPTURE";
                first: number;
                second: number;
                third: number;
              },
        },
        actors: { echo },
      }).createMachine({
        id: "macrostep-journal",
        context: { first: 0, second: 0, latest: [], delivered: [] },
        initial: "ready",
        states: {
          ready: {
            on: {
              STAMP: {
                actions: [
                  assign({ first: () => observe() }),
                  assign({ second: () => observe() }),
                  raise(({ context }) => ({
                    type: "CAPTURE",
                    first: context.first,
                    second: context.second,
                    third: observe(),
                  })),
                ],
              },
              CAPTURE: {
                target: "delivering",
                actions: assign({
                  latest: ({ event }) => [
                    event.first,
                    event.second,
                    event.third,
                  ],
                }),
              },
            },
          },
          delivering: {
            invoke: {
              id: "echo",
              src: "echo",
              input: ({ context }) => context.latest,
              onDone: {
                target: "ready",
                actions: assign({
                  delivered: ({ context, event }) => [
                    ...context.delivered,
                    event.output,
                  ],
                }),
              },
            },
          },
        },
      });

      using actor = await createActor<JournalSnapshot>({ machine });

      await actor.send({ type: "STAMP" });
      await eventually(() => actor.snapshot()).toMatchObject({
        value: "ready",
        context: {
          latest: [1, 2, 3],
          delivered: [[1, 2, 3]],
        },
      });
      expect(observations).toBe(3);
      expect(actorRuns).toBe(1);

      await actor.send({ type: "STAMP" });
      await eventually(() => actor.snapshot()).toMatchObject({
        value: "ready",
        context: {
          latest: [4, 5, 6],
          delivered: [
            [1, 2, 3],
            [4, 5, 6],
          ],
        },
      });

      // Repeated reads and forced handler replay must neither recompute the
      // transition nor re-run either durable actor execution.
      await actor.snapshot();
      expect(observations).toBe(6);
      expect(actorRuns).toBe(2);
    },
  );

  it(
    "serializes concurrent sends without losing or duplicating a macrostep",
    { timeout: 60_000 },
    async () => {
      let observations = 0;
      const machine = setup({
        types: {
          context: {} as {
            processed: Array<{ id: string; observation: number }>;
          },
          events: {} as { type: "ADD"; id: string },
        },
      }).createMachine({
        id: "concurrent-macrosteps",
        context: { processed: [] },
        on: {
          ADD: {
            actions: assign({
              processed: ({ context, event }) => [
                ...context.processed,
                { id: event.id, observation: ++observations },
              ],
            }),
          },
        },
      });

      using actor = await createActor<{
        context: {
          processed: Array<{ id: string; observation: number }>;
        };
      }>({ machine });

      await Promise.all([
        actor.send({ type: "ADD", id: "a" }),
        actor.send({ type: "ADD", id: "b" }),
      ]);

      const snapshot = await actor.snapshot();
      expect(snapshot.context.processed.map(({ id }) => id).sort()).toEqual([
        "a",
        "b",
      ]);
      expect(
        snapshot.context.processed
          .map(({ observation }) => observation)
          .sort((a, b) => a - b),
      ).toEqual([1, 2]);
      expect(observations).toBe(2);
    },
  );
});
