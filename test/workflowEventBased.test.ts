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

import { setup, assign, type SnapshotFrom, fromPromise } from "xstate";
import { eventually } from "./eventually.js";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

interface PatientInfo {
  name: string;
  pet: string;
  reason: string;
}

// https://github.com/serverlessworkflow/specification/tree/main/examples#event-based-service-invocation
export const workflow = setup({
  actors: {
    MakeAppointmentAction: fromPromise(
      async ({ input }: { input: { patientInfo: PatientInfo } }) => {
        console.log("Making vet appointment for", input.patientInfo);
        await delay(2000);

        const appointmentInfo = {
          appointmentId: "1234",
          appointmentDate: new Date().toISOString(),
        };

        console.log("Vet appointment made", appointmentInfo);
        return {
          appointmentInfo,
        };
      },
    ),
  },
}).createMachine({
  id: "VetAppointmentWorkflow",
  types: {} as {
    context: {
      patientInfo: PatientInfo | null;
      appointmentInfo: {
        appointmentId: string;
        appointmentDate: string;
      } | null;
    };
    events: {
      type: "MakeVetAppointment";
      patientInfo: {
        name: string;
        pet: string;
        reason: string;
      };
    };
  },
  initial: "Idle",
  context: {
    patientInfo: null,
    appointmentInfo: null,
  } as {
    patientInfo: PatientInfo | null;
    appointmentInfo: {
      appointmentId: string;
      appointmentDate: string;
    } | null;
  },
  states: {
    Idle: {
      on: {
        MakeVetAppointment: {
          target: "MakeVetAppointmentState",
          actions: assign({
            patientInfo: ({ event }) => event.patientInfo,
          }),
        },
      },
    },
    MakeVetAppointmentState: {
      invoke: {
        src: "MakeAppointmentAction",
        input: ({ context }) => ({
          patientInfo: context.patientInfo,
        }),
        onDone: {
          target: "Idle",
          actions: assign({
            appointmentInfo: ({ event }) => event.output,
          }),
        },
      },
    },
  },
});

describeE2E("An event based workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using actor = await createActor<SnapshotFrom<typeof workflow>>({
      machine: workflow,
      input: {
        person: { name: "Jenny" },
      },
    });

    await actor.send({
      type: "MakeVetAppointment",
      patientInfo: {
        name: "Jenny",
        pet: "Ato",
        reason: "Annual checkup",
      },
    });

    await eventually(
      async () =>
        (await actor.snapshot()).context.appointmentInfo.appointmentInfo
          ?.appointmentId,
    ).toStrictEqual("1234");
  });
});
