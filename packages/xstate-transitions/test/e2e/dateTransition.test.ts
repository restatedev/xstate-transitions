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
 * Non-determinism guard: a transition `assign` that reads Date.now().
 *
 * The machine writes Date.now() into context on the `submit` transition. Because
 * the transition is journaled via ctx.run, the recorded timestamp must survive a
 * handler replay — so under `alwaysReplay` the value read back must equal the
 * value observed before replay. This runs in both modes via the e2e harness; the
 * alwaysReplay run is the one that would catch a regression of the ctx.run wrap.
 */

import { expect, it } from "vitest";
import { assign, createMachine } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = createMachine({
  types: {} as { context: { at: number } },
  id: "date-transition",
  context: { at: 0 },
  initial: "idle",
  states: {
    idle: {
      on: {
        submit: {
          target: "done",
          actions: assign({ at: () => Date.now() }),
        },
      },
    },
    done: { type: "final" },
  },
});

describeE2E("Date.now() captured on a transition", (createActor) => {
  it(
    "records the timestamp durably and reads back the same value",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        context: { at: number };
      }>({ machine });

      await actor.send({ type: "submit" });

      const first = await actor.snapshot();
      expect(first.status).toBe("done");
      expect(first.context.at).toBeGreaterThan(0);

      // Re-reading (which may trigger a replay under alwaysReplay) must return
      // the same journaled timestamp, not a freshly recomputed one.
      await eventually(() => actor.snapshot()).toMatchObject({
        context: { at: first.context.at },
      });
    },
  );
});
