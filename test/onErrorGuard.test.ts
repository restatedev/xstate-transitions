/*
 * Phase 1 — error propagation normalization.
 *
 * A thrown Error is normalized to a serializable { name, message } before it
 * crosses the JSON boundary, so an onError transition guarded on
 * event.error.message can select a branch. Without normalization the error
 * serializes to {} and the guard would fall through.
 */

import { it } from "vitest";
import { fromPromise, setup } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = setup({
  actors: {
    boom: fromPromise(async () => {
      throw new Error("NOT_FOUND");
    }),
  },
}).createMachine({
  id: "on-error-guard",
  initial: "run",
  states: {
    run: {
      invoke: {
        src: "boom",
        onDone: "ok",
        onError: [
          {
            guard: ({ event }) =>
              (event.error as { message?: string } | undefined)?.message ===
              "NOT_FOUND",
            target: "notFound",
          },
          { target: "otherError" },
        ],
      },
    },
    ok: { type: "final" },
    notFound: { type: "final" },
    otherError: { type: "final" },
  },
});

describeE2E("onError guard on event.error.message", (createActor) => {
  it(
    "selects the branch matching the normalized error message",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        value?: string;
      }>({ machine });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "notFound",
      });
    },
  );
});
