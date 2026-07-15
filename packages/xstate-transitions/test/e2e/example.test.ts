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

import { expect, it } from "vitest";
import { assign, createMachine } from "xstate";
import { describeE2E } from "./harness";

const xmachine = createMachine({
  id: "counterv1",
  context: {
    count: 0,
  },
  on: {
    inc: {
      actions: assign({
        count: ({ context }) => context.count + 1,
      }),
    },
    dec: {
      actions: assign({
        count: ({ context }) => context.count - 1,
      }),
    },
  },
});

describeE2E("Simple count machine", (createActor) => {
  it(
    "Will respond to different count events",
    { timeout: 60_000 },
    async () => {
      using machine = await createActor<{
        context: { count: number };
      }>({
        machine: xmachine,
      });

      await machine.send({ type: "inc" });
      await machine.send({ type: "inc" });
      await machine.send({ type: "dec" });

      const snap = await machine.snapshot();
      expect(snap.context.count).toBe(1);
    },
  );
});
