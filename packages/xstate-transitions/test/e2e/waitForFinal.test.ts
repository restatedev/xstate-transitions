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
 * A `waitFor` that arrives after an instance is already final must resolve
 * immediately from the persisted snapshot, not hang. In our model `subscribe`
 * evaluates the condition against the rehydrated snapshot and resolves the
 * awakeable right away when it is already decided — this pins that behavior for
 * an instance that reached its final state before anyone subscribed.
 */

import { expect, it } from "vitest";
import { createMachine } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = createMachine({
  id: "wait-after-done",
  initial: "active",
  states: {
    active: { on: { GO: { target: "finished" } } },
    finished: { type: "final" },
  },
  output: () => ({ ok: true }),
});

describeE2E("waitFor on an already-final instance", (createActor) => {
  it(
    "resolves immediately from the persisted final snapshot",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{ status?: string; output?: unknown }>({
        machine,
      });

      // Drive the instance to its final state first.
      await actor.send({ type: "GO" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
      });

      // Subscribing for completion now must resolve straight away.
      await expect(actor.waitFor("done")).resolves.toMatchObject({
        status: "done",
        output: { ok: true },
      });
    },
  );
});
