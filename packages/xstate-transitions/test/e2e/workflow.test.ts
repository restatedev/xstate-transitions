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

import { assign, setup } from "xstate";
import { fromPromise } from "../../src";
import { describeE2E } from "./harness";

/**
 * Need to make the type inference work for workflow
 * https://github.com/statelyai/xstate/issues/5090#issuecomment-2493180191
 */
import "xstate/guards";
import { eventually } from "./eventually.js";

const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// this will be set by the test run.
let global_report = {};

// https://github.com/serverlessworkflow/specification/blob/main/examples/README.md#accumulate-room-readings
export const workflow = setup({
  types: {} as {
    events:
      | {
          type: "TemperatureEvent";
          roomId: string;
          temperature: number;
        }
      | {
          type: "HumidityEvent";
          roomId: string;
          humidity: number;
        };
    context: {
      temperature: number | null;
      humidity: number | null;
    };
  },
  delays: {
    PT1H: 1_000,
  },
  actors: {
    produceReport: fromPromise(
      ({
        input,
      }: {
        input: {
          temperature: number | null;
          humidity: number | null;
        };
      }): Promise<void> => {
        global_report = input;
        return Promise.resolve();
      },
    ),
  },
}).createMachine({
  id: "roomreadings",

  initial: "ConsumeReading",
  context: {
    temperature: null,
    humidity: null,
  },
  states: {
    ConsumeReading: {
      entry: assign({
        temperature: null,
        humidity: null,
      }),
      on: {
        TemperatureEvent: {
          actions: assign({
            temperature: ({ event }) => event.temperature,
          }),
        },
        HumidityEvent: {
          actions: assign({
            humidity: ({ event }) => event.humidity,
          }),
        },
      },
      after: {
        PT1H: {
          guard: ({ context }) =>
            context.temperature !== null && context.humidity !== null,
          target: "GenerateReport",
        },
      },
    },
    GenerateReport: {
      invoke: {
        src: "produceReport",
        input: ({ context }) => ({
          temperature: context.temperature,
          humidity: context.humidity,
        }),
        onDone: {
          target: "ConsumeReading",
        },
      },
    },
  },
});

describeE2E("A Temperate workflow", (createActor) => {
  it(
    "Will complete the workflow successfully",
    { timeout: 30_000 },
    async () => {
      using actor = await createActor<{ status?: string } | undefined>({
        machine: workflow,
      });

      await actor.send({
        type: "TemperatureEvent",
        roomId: "kitchen",
        temperature: 20,
      });
      await actor.send({
        type: "HumidityEvent",
        roomId: "kitchen",
        humidity: 50,
      });

      await delay(5_000);

      await eventually(() => global_report).toMatchObject({
        temperature: 20,
        humidity: 50,
      });
    },
  );
});
