/*
 * Phase 0 — behaviour-pinning test.
 *
 * When an invoked promise actor throws, doExecuteAction maps it to an
 * `xstate.error.actor.<id>` event which is sent back to the machine, driving the
 * invoke's `onError` transition. This locks that error-routing path.
 */

import { it } from "vitest";
import { fromPromise, setup } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = setup({
  actors: {
    boom: fromPromise(async () => {
      throw new Error("kaboom");
    }),
  },
}).createMachine({
  id: "on-error",
  initial: "run",
  states: {
    run: {
      invoke: {
        src: "boom",
        onDone: "ok",
        onError: "failed",
      },
    },
    ok: { type: "final" },
    failed: { type: "final" },
  },
});

describeE2E("Promise actor onError", (createActor) => {
  it(
    "routes a thrown error to the onError target",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "failed",
      });
    },
  );
});
