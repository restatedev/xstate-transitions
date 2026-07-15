/*
 * When an invoked promise actor throws, the internal actor handlers translate
 * its outcome to an `xstate.error.actor.<id>` event, which drives the invoke's
 * `onError` transition.
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
