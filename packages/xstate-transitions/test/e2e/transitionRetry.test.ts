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
 * A failed ctx.run attempt must not leak a partial XState Step. The transition
 * below fails after observing user code once, then succeeds; only the successful
 * snapshot and actor effect may be committed.
 */

import { expect, it } from "vitest";
import { assign, setup } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

describeE2E("Transition retry atomicity", (createActor) => {
  it(
    "commits no state or effect from a failed Step computation",
    { timeout: 60_000 },
    async () => {
      let attempts = 0;
      let actorRuns = 0;
      const work = fromPromise<number, number>(async ({ input }) => {
        actorRuns += 1;
        return input;
      });
      const machine = setup({
        types: {
          context: {} as { token: number; result?: number },
          events: {} as { type: "GO" },
        },
        actors: { work },
      }).createMachine({
        id: "transition-retry-atomicity",
        context: { token: 0 },
        initial: "idle",
        states: {
          idle: {
            on: {
              GO: {
                target: "working",
                actions: assign({
                  token: () => {
                    attempts += 1;
                    if (attempts === 1) {
                      throw new Error("transient transition failure");
                    }
                    return attempts;
                  },
                }),
              },
            },
          },
          working: {
            invoke: {
              id: "work",
              src: "work",
              input: ({ context }) => context.token,
              onDone: {
                target: "done",
                actions: assign({ result: ({ event }) => event.output }),
              },
            },
          },
          done: { type: "final" },
        },
      });

      using actor = await createActor<{
        status: string;
        value: string;
        context: { token: number; result?: number };
      }>({ machine });

      await actor.send({ type: "GO" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "done",
        context: { token: 2, result: 2 },
      });
      expect(attempts).toBe(2);
      expect(actorRuns).toBe(1);
    },
  );
});
