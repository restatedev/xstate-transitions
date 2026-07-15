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
 * A delayed `raise({...}, { delay, id })` is routed through `deliverScheduled`,
 * guarded by a UUID in durable scheduled-event state. `cancel(id)` removes the
 * entry, so a later delivery fails the guard and the event is dropped.
 */

import { expect, it } from "vitest";
import { cancel, createMachine, raise } from "xstate";
import { eventually, wait } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = createMachine({
  id: "cancellable",
  initial: "idle",
  states: {
    idle: {
      on: {
        START_DELAYED: {
          target: "pending",
          actions: raise({ type: "FIRE" }, { delay: 1500, id: "d" }),
        },
      },
    },
    pending: {
      on: {
        CANCEL: { target: "idle", actions: cancel("d") },
        FIRE: "fired",
      },
    },
    fired: { type: "final" },
  },
});

describeE2E("Delayed-event cancellation", (createActor) => {
  it(
    "does NOT fire a cancelled delayed raise",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await actor.send({ type: "START_DELAYED" });
      expect(await actor.snapshot()).toMatchObject({ value: "pending" });

      await wait(400);
      await actor.send({ type: "CANCEL" });
      expect(await actor.snapshot()).toMatchObject({ value: "idle" });

      // Wait past the original delay; the cancelled event must never arrive.
      await wait(1600);
      expect(await actor.snapshot()).toMatchObject({ value: "idle" });
    },
  );

  it(
    "DOES fire a non-cancelled delayed raise",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await actor.send({ type: "START_DELAYED" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "fired",
      });
    },
  );
});
