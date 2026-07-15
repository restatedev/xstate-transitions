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
 * A single macrostep that enters two invokes (here, two parallel regions)
 * dispatches two `xstate.spawnChild` actions that run concurrently through the
 * shared `executeActor` handler. Both done events must feed back and their context
 * assignments must merge. This locks the shared-handler fan-out + merge.
 */

import { it } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const machine = setup({
  schemas: {
    context: types<{ a: string | null; b: string | null }>(),
  },
  actorSources: {
    actorA: fromPromise(async () => {
      await delay(20);
      return "A";
    }),
    actorB: fromPromise(async () => {
      await delay(20);
      return "B";
    }),
  },
}).createMachine({
  id: "concurrent-invokes",
  type: "parallel",
  context: { a: null, b: null },
  states: {
    ra: {
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "actorA",
            onDone: {
              target: "done",
              context: ({ output }) => ({ a: output as string }),
            },
          },
        },
        done: { type: "final" },
      },
    },
    rb: {
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "actorB",
            onDone: {
              target: "done",
              context: ({ output }) => ({ b: output as string }),
            },
          },
        },
        done: { type: "final" },
      },
    },
  },
});

describeE2E("Concurrent invokes from parallel regions", (createActor) => {
  it(
    "runs both invokes concurrently and merges both results",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        context: { a: string | null; b: string | null };
      }>({ machine });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        context: { a: "A", b: "B" },
      });
    },
  );
});
