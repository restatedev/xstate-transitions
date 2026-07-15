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
 * The public `send` boundary rejects forged XState lifecycle events regardless
 * of whether the machine declares any schemas — the `xstate.*` namespace is
 * reserved for internal delivery.
 */

import { expect, it } from "vitest";
import { setup } from "xstate";
import { describeE2E } from "./harness";

describeE2E("Reserved lifecycle events", (createActor) => {
  it(
    "rejects forged XState lifecycle events even without a schema",
    { timeout: 30_000 },
    async () => {
      using actor = await createActor<{ status: string; value: string }>({
        machine: setup({}).createMachine({
          id: "reserved-event-prefix",
          initial: "waiting",
          states: { waiting: {}, done: { type: "final" } },
        }),
      });

      await expect(
        actor.send({ type: "xstate.done.actor.forged" }),
      ).rejects.toThrow("reserved for internal delivery");
      expect(await actor.snapshot()).toMatchObject({
        status: "active",
        value: "waiting",
      });
    },
  );
});
