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
 * Restate journals the complete Step produced by one XState macrostep. These
 * cases stamp values inside a transition and couple the resulting snapshot to an
 * emitted actor effect, then confirm the durable actor runs exactly once per
 * macrostep.
 *
 * NOTE (XState v6): transition functions are evaluated multiple times per
 * macrostep (for guard/microstep resolution), so they MUST be pure. We derive
 * the stamped values deterministically from context rather than from a mutable
 * observation counter, and assert the once-per-macrostep guarantee through the
 * durable actor effect (which the integration journals exactly once) rather than
 * by counting transition invocations.
 */

import { expect, it } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

interface JournalSnapshot {
  value: string;
  context: {
    round: number;
    latest: number[];
    delivered: number[][];
  };
}

describeE2E("Macrostep durability", (createActor) => {
  it(
    "journals a stamped macrostep and its emitted effect as one Step",
    { timeout: 60_000 },
    async () => {
      let actorRuns = 0;

      const echo = fromPromise<number[], number[]>(async ({ input }) => {
        actorRuns += 1;
        return [...input];
      });

      const machine = setup({
        schemas: {
          context: types<JournalSnapshot["context"]>(),
          events: {
            STAMP: types<Record<string, never>>(),
            CAPTURE: types<{
              first: number;
              second: number;
              third: number;
            }>(),
          },
        },
        actorSources: { echo },
      }).createMachine({
        id: "macrostep-journal",
        context: { round: 0, latest: [], delivered: [] },
        initial: "ready",
        states: {
          ready: {
            on: {
              // Pure: three stamped values derived from the current round.
              STAMP: ({ context }, enq) => {
                const base = context.round * 3;
                enq.raise({
                  type: "CAPTURE",
                  first: base + 1,
                  second: base + 2,
                  third: base + 3,
                });
                return { context: { round: context.round + 1 } };
              },
              CAPTURE: ({ event }) => ({
                target: "delivering",
                context: {
                  latest: [event.first, event.second, event.third],
                },
              }),
            },
          },
          delivering: {
            invoke: {
              id: "echo",
              src: "echo",
              input: ({ context }) => context.latest,
              onDone: {
                target: "ready",
                context: ({ context, output }) => ({
                  delivered: [...context.delivered, output],
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

      // Repeated reads and forced handler replay must not re-run the durable
      // actor execution.
      await actor.snapshot();
      expect(actorRuns).toBe(2);
    },
  );

  it(
    "serializes concurrent sends without losing or duplicating a macrostep",
    { timeout: 60_000 },
    async () => {
      const machine = setup({
        schemas: {
          context: types<{
            processed: Array<{ id: string; observation: number }>;
          }>(),
          events: {
            ADD: types<{ id: string }>(),
          },
        },
      }).createMachine({
        id: "concurrent-macrosteps",
        context: { processed: [] },
        on: {
          // Pure: the observation index is derived from the committed length, so
          // two serialized macrosteps yield observations 1 then 2 with no gap or
          // duplicate — even though v6 evaluates the transition several times.
          ADD: ({ context, event }) => ({
            context: {
              processed: [
                ...context.processed,
                { id: event.id, observation: context.processed.length + 1 },
              ],
            },
          }),
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
      // Exactly one macrostep per send: contiguous observation indices, no loss
      // or duplication from the concurrent delivery.
      expect(
        snapshot.context.processed
          .map(({ observation }) => observation)
          .sort((a, b) => a - b),
      ).toEqual([1, 2]);
    },
  );
});
