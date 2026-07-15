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
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

interface Applicant {
  fname: string;
  lname: string;
  age: number;
  email: string;
}

// https://github.com/serverlessworkflow/specification/tree/main/examples#applicant-request-decision-example
export const workflow = setup({
  schemas: {
    context: types<{
      applicant: Applicant;
    }>(),
    input: types<{
      applicant: Applicant;
    }>(),
  },
  actorSources: {
    startApplicationWorkflowId: fromPromise(async () => {
      console.log("startApplicationWorkflowId workflow started");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log("startApplicationWorkflowId workflow completed");
    }),
    sendRejectionEmailFunction: fromPromise(async () => {
      console.log("sendRejectionEmailFunction workflow started");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log("sendRejectionEmailFunction workflow completed");
    }),
  },
}).createMachine({
  id: "applicantrequest",

  initial: "CheckApplication",
  context: ({ input }) => ({
    applicant: input.applicant,
  }),
  states: {
    CheckApplication: {
      on: {
        Submit: ({ context }) =>
          context.applicant.age >= 18
            ? { target: "StartApplication", reenter: false }
            : { target: "RejectApplication", reenter: false },
      },
    },
    StartApplication: {
      invoke: {
        src: "startApplicationWorkflowId",
        onDone: { target: "End" },
        onError: { target: "RejectApplication" },
      },
    },
    RejectApplication: {
      invoke: {
        src: "sendRejectionEmailFunction",
        input: ({ context }: { context: { applicant: Applicant } }) => ({
          applicant: context.applicant,
        }),
        onDone: { target: "End" },
      },
    },
    End: {
      type: "final",
    },
  },
});

describeE2E("An applicant workflow", (createActor) => {
  it(
    "Will complete the workflow successfully",
    { timeout: 30_000 },
    async () => {
      using actor = await createActor<{ value?: string } | undefined>({
        machine: workflow,
        input: {
          applicant: {
            fname: "John",
            lname: "Stockton",
            age: 22,
            email: "js@something.com",
          },
        },
      });

      await actor.send({
        type: "Submit",
      });

      await eventually(() => actor.snapshot()).toMatchObject({
        value: "End",
      });
    },
  );
});
