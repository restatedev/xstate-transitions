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
import { createCallbackLogic, setup } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

export const stopwatchMachine = setup({
  actorSources: {
    ticks: createCallbackLogic(({ sendBack }) => {
      const interval = setInterval(() => {
        sendBack({ type: "TICK" });
      }, 1000);
      return () => {
        clearInterval(interval);
      };
    }),
  },
}).createMachine({
  id: "stopwatch",
  initial: "stopped",
  context: {
    elapsed: 0,
  },
  states: {
    stopped: {
      on: {
        start: { target: "running" },
      },
    },
    running: {
      invoke: {
        src: "ticks",
      },
      on: {
        TICK: ({ context }) => ({
          context: { elapsed: Number(context.elapsed) + 1 },
        }),
        stop: { target: "stopped" },
      },
    },
  },
  on: {
    reset: {
      target: ".stopped",
      context: () => ({ elapsed: 0 }),
    },
  },
});

// <!> This test is currently disabled as we do not have a support for `fromCallback`.
// Use cases that require `fromCallback` needed to implement in a different way.
// for example, externally sending events to the machine (instead of internally via fromCallback)
describeE2E("A stopwatch machine", (createActor) => {
  it(
    "Will complete successfully",
    { skip: true, timeout: 60_000 },
    async () => {
      using actor = await createActor<
        { context?: { elapsed?: number } } | undefined
      >({
        machine: stopwatchMachine,
      });

      await actor.send({ type: "start" });

      await eventually(
        async () => (await actor.snapshot())?.context?.elapsed,
      ).toBeGreaterThan(0);
    },
  );
});
