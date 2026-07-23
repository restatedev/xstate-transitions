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
 * Greeting workflow.
 *
 * Ported from xstate/examples/workflow-greeting to the pure-transition XState v6
 * authoring style used by this integration. It shows the smallest useful shape:
 * typed `input`, a single durable async actor, and a `final` state that produces
 * `output`.
 *
 * Upstream (XState v5): https://github.com/statelyai/xstate/tree/main/examples/workflow-greeting
 */

import { setup, types } from "xstate";
import { z } from "zod";
import { createMachineObject, fromPromise } from "@restatedev/xstate";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const greetingMachine = setup({
  // `schemas` types the machine's public surface. A real Zod schema on `input`
  // makes `createMachineObject` validate `create` and publish its JSON Schema to
  // Restate discovery; `context` stays type-only (it is not an ingress boundary).
  schemas: {
    input: z.object({ person: z.object({ name: z.string() }) }),
    context: types<{ name: string; greeting: string | null }>(),
  },
  actorSources: {
    greetingFunction: fromPromise(
      async ({ input }: { input: { name: string } }) => {
        await delay(1000);
        return { greeting: `Hello, ${input.name}!` };
      },
    ),
  },
}).createMachine({
  id: "greeting",
  context: ({ input }) => ({ name: input.person.name, greeting: null }),
  initial: "Greet",
  states: {
    Greet: {
      invoke: {
        src: "greetingFunction",
        input: ({ context }) => ({ name: context.name }),
        onDone: {
          target: "Greeted",
          context: ({ output }) => ({ greeting: output.greeting }),
        },
      },
    },
    Greeted: {
      type: "final",
      output: ({ context }) => ({ greeting: context.greeting }),
    },
  },
});

export const greeting = createMachineObject("greeting", greetingMachine, {
  journalRetention: { days: 1 },
});
