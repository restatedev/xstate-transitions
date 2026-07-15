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
 * Drives a machine with a shallow history state through the real Restate object
 * (create/send/snapshot). The snapshot layer persists historyValue as node IDs
 * and rehydrates them, so RESUME restores the remembered sub-state across the
 * durable round-trip.
 */

import { expect, it } from "vitest";
import { createMachine } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = createMachine({
  id: "hist",
  initial: "main",
  states: {
    main: {
      initial: "one",
      on: { PAUSE: { target: "paused" } },
      states: {
        one: { on: { NEXT: { target: "two" } } },
        two: {},
        hist: { type: "history", history: "shallow" },
      },
    },
    paused: { on: { RESUME: { target: "#hist.main.hist" } } },
  },
});

describeE2E("History state persistence", (createActor) => {
  it(
    "restores the remembered sub-state after RESUME",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{ value?: unknown }>({
        machine,
      });

      await actor.send({ type: "NEXT" }); // main.two
      await actor.send({ type: "PAUSE" }); // -> paused (history = two)
      expect(await actor.snapshot()).toMatchObject({ value: "paused" });

      await actor.send({ type: "RESUME" }); // -> main.hist -> main.two
      await eventually(() => actor.snapshot()).toMatchObject({
        value: { main: "two" },
      });
    },
  );
});
