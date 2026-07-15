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
 * below fails once (a transient compute failure), then succeeds; only the
 * successful snapshot and actor effect may be committed. Crucially, the invoked
 * actor must run exactly once — a leaked effect from the failed attempt would
 * run it twice.
 *
 * NOTE (XState v6): transition functions are evaluated multiple times per
 * macrostep, so the transient failure is gated on a one-shot flag (consumed on
 * the first evaluation) and the successful result is deterministic, rather than
 * counting transition invocations.
 */

import { expect, it } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

describeE2E("Transition retry atomicity", (createActor) => {
  it(
    "commits no state or effect from a failed Step computation",
    { timeout: 60_000 },
    async () => {
      let failedOnce = false;
      let actorRuns = 0;
      const work = fromPromise<number, number>(async ({ input }) => {
        actorRuns += 1;
        return input;
      });
      const machine = setup({
        schemas: {
          context: types<{ token: number; result?: number }>(),
        },
        actorSources: { work },
      }).createMachine({
        id: "transition-retry-atomicity",
        context: { token: 0 },
        initial: "idle",
        states: {
          idle: {
            on: {
              GO: () => {
                if (!failedOnce) {
                  failedOnce = true;
                  throw new Error("transient transition failure");
                }
                return { target: "working", context: { token: 1 } };
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
        context: { token: number; result?: number };
      }>({ machine });

      await actor.send({ type: "GO" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "done",
        context: { token: 1, result: 1 },
      });
      // The transient failure was exercised, the retry committed clean state,
      // and the actor effect ran exactly once (no leak from the failed attempt).
      expect(failedOnce).toBe(true);
      expect(actorRuns).toBe(1);
    },
  );
});
