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
import { assign, fromPromise, setup } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const prompt = (_question: string) => Promise.resolve("bob");

const onboardingWorkflow = setup({
  actors: {
    prompt: fromPromise(async ({ input }: { input: { question: string } }) => {
      const response = await prompt(input.question);
      return {
        response,
      };
    }),
  },
}).createMachine({
  id: "onboarding",
  initial: "Welcome",
  context: {
    name: undefined,
  },
  states: {
    Welcome: {
      invoke: {
        src: "prompt",
        input: {
          question: "What is your name?",
        },
        onDone: {
          target: "Personalize",
          actions: assign({
            name: ({ event }) => event.output.response,
          }),
        },
      },
    },
    Personalize: {
      invoke: {
        src: "prompt",
        input: ({ context }) => ({
          question: `Welcome ${String(context.name)}, press enter to finish the onboarding process`,
        }),
        onDone: "Completed",
      },
    },
    Completed: {
      type: "final",
    },
  },
});

export const workflow = setup({
  actors: {
    onboarding: onboardingWorkflow,
  },
}).createMachine({
  id: "async-function-invocation",
  initial: "Onboard",
  states: {
    Onboard: {
      invoke: {
        src: "onboarding",
        onDone: "Onboarded",
      },
    },
    Onboarded: {
      type: "final",
    },
  },
});

describeE2E("An onboarding workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using actor = await createActor<{ value?: string } | undefined>({
      machine: workflow,
    });

    await actor.send({
      type: "Submit",
    });

    await eventually(() => actor.snapshot()).toMatchObject({
      value: "Onboarded",
    });
  });
});
