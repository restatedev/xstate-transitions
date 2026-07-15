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

import { it } from "vitest";
import { createMachine, type SnapshotFrom, types } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

// https://github.com/serverlessworkflow/specification/blob/main/examples/README.md#filling-a-glass-of-water
export const workflow = createMachine({
  id: "fillglassofwater",
  schemas: {
    context: types<{
      counts: {
        current: number;
        max: number;
      };
    }>(),
    input: types<{
      current: number;
      max: number;
    }>(),
  },
  initial: "CheckIfFull",
  context: ({ input }) => ({
    counts: input,
  }),
  states: {
    CheckIfFull: {
      always: ({ context }) =>
        context.counts.current < context.counts.max
          ? { target: "AddWater" }
          : { target: "GlassFull" },
    },
    AddWater: {
      after: {
        500: ({ context }) => ({
          target: "CheckIfFull",
          context: {
            counts: {
              ...context.counts,
              current: context.counts.current + 1,
            },
          },
        }),
      },
    },
    GlassFull: {
      type: "final",
    },
  },
});

describeE2E("Fill water workflow", (createActor) => {
  it("Will complete successfully", { timeout: 30_000 }, async () => {
    using actor = await createActor<SnapshotFrom<typeof workflow>>({
      machine: workflow,
      input: {
        current: 0,
        max: 10,
      },
    });

    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "GlassFull",
    });
  });
});
