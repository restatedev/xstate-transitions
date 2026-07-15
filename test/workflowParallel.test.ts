/*
 * Copyright (c) 2023-2024 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import { it } from "vitest";
import { describeE2E } from "./harness";

import { fromPromise, setup, type SnapshotFrom } from "xstate";
import { eventually } from "./eventually.js";

// https://github.com/serverlessworkflow/specification/tree/main/examples#parallel-execution-example
export const workflow = setup({
  actors: {
    shortDelay: fromPromise(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          console.log("Resolved shortDelay");
          resolve();
        }, 1000),
      );
    }),
    longDelay: fromPromise(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          console.log("Resolved longDelay");
          resolve();
        }, 3000),
      );
    }),
  },
}).createMachine({
  id: "parallel-execution",
  initial: "ParallelExec",
  states: {
    ParallelExec: {
      type: "parallel",
      states: {
        ShortDelayBranch: {
          initial: "active",
          states: {
            active: {
              invoke: {
                src: "shortDelay",
                onDone: "done",
              },
            },
            done: {
              type: "final",
            },
          },
        },
        LongDelayBranch: {
          initial: "active",
          states: {
            active: {
              invoke: {
                src: "longDelay",
                onDone: "done",
              },
            },
            done: {
              type: "final",
            },
          },
        },
      },
      onDone: "Success",
    },
    Success: {
      type: "final",
    },
  },
});

describeE2E("Parallel workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using actor = await createActor<SnapshotFrom<typeof workflow>>({
      machine: workflow,
    });

    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "Success",
    });
  });
});
