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
import { fromPromise, setup } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

// from: https://raw.githubusercontent.com/statelyai/xstate/refs/heads/main/examples/workflow-async-function/main.ts

export const workflow = setup({
  types: {
    input: {} as {
      customer: string;
    },
  },
  actors: {
    sendEmail: fromPromise(
      async ({ input }: { input: { customer: string } }) => {
        console.log("Sending email to", input.customer);

        await new Promise<void>((resolve) =>
          setTimeout(() => {
            console.log("Email sent to", input.customer);
            resolve();
          }, 1),
        );
      },
    ),
  },
}).createMachine({
  id: "async-function-invocation",
  initial: "Send email",
  context: ({ input }) => ({
    customer: input.customer,
  }),
  states: {
    "Send email": {
      invoke: {
        src: "sendEmail",
        input: ({ context }) => ({
          customer: context.customer,
        }),
        onDone: "Email sent",
      },
    },
    "Email sent": {
      type: "final",
    },
  },
});

describeE2E("A fromPromise based state machine", (createActor) => {
  it(
    "Will complete the workflow successfully",
    { timeout: 60_000 },
    async () => {
      using machine = await createActor<{ status?: string } | undefined>({
        machine: workflow,
        input: { customer: "bob@mop.com" },
      });

      await eventually(() => machine.snapshot()).toMatchObject({
        status: "done",
      });
    },
  );
});
