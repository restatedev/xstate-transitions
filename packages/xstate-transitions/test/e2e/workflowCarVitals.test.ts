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
import { type SnapshotFrom, setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

async function delay(ms: number, errorProbability: number = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < errorProbability) {
        reject({ type: "ServiceNotAvailable" });
      } else {
        resolve();
      }
    }, ms);
  });
}

const vitalsWorkflow = setup({
  schemas: {
    context: types<{
      tirePressure: null | { value: number };
      oilPressure: null | { value: number };
      coolantLevel: null | { value: number };
      battery: null | { value: number };
    }>(),
  },
  actorSources: {
    checkTirePressure: fromPromise(async () => {
      console.log("Starting checkTirePressure");
      await delay(10);
      console.log("Completed checkTirePressure");
      return { value: 100 };
    }),
    checkOilPressure: fromPromise(async () => {
      console.log("Starting checkOilPressure");
      await delay(150);
      console.log("Completed checkOilPressure");
      return { value: 100 };
    }),
    checkCoolantLevel: fromPromise(async () => {
      console.log("Starting checkCoolantLevel");
      await delay(50);
      console.log("Completed checkCoolantLevel");
      return { value: 100 };
    }),
    checkBattery: fromPromise(async () => {
      console.log("Starting checkBattery");
      await delay(120);
      console.log("Completed checkBattery");
      return { value: 100 };
    }),
  },
}).createMachine({
  id: "vitalscheck",
  context: {
    tirePressure: null,
    oilPressure: null,
    coolantLevel: null,
    battery: null,
  },
  initial: "CheckVitals",
  states: {
    CheckVitals: {
      invoke: [
        {
          src: "checkTirePressure",
          onDone: {
            context: ({ output }) => ({
              tirePressure: output,
            }),
          },
        },
        {
          src: "checkOilPressure",
          onDone: {
            context: ({ output }) => ({
              oilPressure: output,
            }),
          },
        },
        {
          src: "checkCoolantLevel",
          onDone: {
            context: ({ output }) => ({
              coolantLevel: output,
            }),
          },
        },
        {
          src: "checkBattery",
          onDone: {
            context: ({ output }) => ({
              battery: output,
            }),
          },
        },
      ],
      always: ({ context }) =>
        context.tirePressure &&
        context.oilPressure &&
        context.coolantLevel &&
        context.battery
          ? { target: "VitalsChecked" }
          : undefined,
    },
    VitalsChecked: {
      type: "final",
    },
  },
  output: ({ context }) => context,
});

describeE2E("A car vitals workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using actor = await createActor<SnapshotFrom<typeof vitalsWorkflow>>({
      machine: vitalsWorkflow,
    });

    await actor.send({
      type: "CarTurnedOnEvent",
    });

    await actor.send({
      type: "CarTurnedOffEvent",
    });

    await eventually(() => actor.snapshot()).toMatchObject({
      output: {
        tirePressure: { value: 100 },
        oilPressure: { value: 100 },
        coolantLevel: { value: 100 },
        battery: { value: 100 },
      },
    });
  });
});
