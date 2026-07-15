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
 * When an invoked promise actor throws, the internal actor handlers translate
 * its outcome to an `xstate.error.actor.<id>` event, which drives the invoke's
 * `onError` transition.
 */

import { it } from "vitest";
import { setup } from "xstate";
import { fromPromise } from "../../src";
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
