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
 * Calling create() again clears the instance's runtime bookkeeping, runs the
 * initial transition, and replaces its snapshot. This test makes the reset
 * semantics explicit.
 */

import { expect, it } from "vitest";
import { assign, createMachine } from "xstate";
import { describeE2E } from "./harness";

const counter = createMachine({
  types: {} as { context: { count: number } },
  id: "recreate-counter",
  context: { count: 0 },
  initial: "idle",
  states: {
    idle: {
      on: {
        inc: { actions: assign({ count: ({ context }) => context.count + 1 }) },
      },
    },
  },
});

describeE2E("create() idempotency / re-create", (createActor) => {
  it(
    "re-creating resets the machine to its initial snapshot",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        context: { count: number };
        value?: string;
      }>({ machine: counter });

      await actor.send({ type: "inc" });
      await actor.send({ type: "inc" });
      expect((await actor.snapshot()).context.count).toBe(2);

      await actor.create();

      const snap = await actor.snapshot();
      expect(snap.context.count).toBe(0);
      expect(snap.value).toBe("idle");
    },
  );

  it(
    "journals initial observations per instance but refreshes them on create",
    { timeout: 60_000 },
    async () => {
      let observations = 0;
      const machine = createMachine({
        types: {} as { context: { first: number; second: number } },
        id: "recreate-observations",
        context: { first: 0, second: 0 },
        entry: [
          assign({ first: () => ++observations }),
          assign({ second: () => ++observations }),
        ],
      });

      using actor = await createActor<{
        context: { first: number; second: number };
      }>({ machine });

      const first = (await actor.snapshot()).context;
      expect(first.second).toBe(first.first + 1);
      expect(observations).toBe(first.second);

      // Reads may replay the handler but cannot evaluate the initial Step again.
      expect((await actor.snapshot()).context).toEqual(first);
      expect(observations).toBe(first.second);

      await actor.create();
      const second = (await actor.snapshot()).context;
      expect(second.first).toBeGreaterThan(first.second);
      expect(second.second).toBe(second.first + 1);
      expect(observations).toBe(second.second);
    },
  );
});
