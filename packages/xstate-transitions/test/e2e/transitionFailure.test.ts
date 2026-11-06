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
 * A machine transition is pure, synchronous computation, so an error it throws
 * recurs on every attempt. The integration fails such an invocation terminally
 * instead of retrying it forever (which would block the object's queue): the
 * caller gets the error, nothing from the failed Step is committed, and the
 * instance keeps serving later events.
 */

import { expect, it } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

describeE2E("Transition failure", (createActor) => {
  it(
    "fails the event terminally, commits nothing, and keeps the instance usable",
    { timeout: 60_000 },
    async () => {
      let failing = true;
      let actorRuns = 0;
      const work = fromPromise<number, number>(async ({ input }) => {
        actorRuns += 1;
        return input;
      });
      const machine = setup({
        schemas: {
          context: types<{ token: number; result?: number }>(),
        },
        actors: { work },
      }).createMachine({
        id: "transition-failure",
        context: { token: 0 },
        initial: "idle",
        states: {
          idle: {
            on: {
              GO: () => {
                if (failing) throw new Error("boom in transition");
                return { target: "working", context: { token: 1 } };
              },
            },
          },
          working: {
            invoke: {
              id: "work",
              src: "work",
              input: ({ context }) => context.token,
              onDone: {
                target: "done",
                context: ({ output }) => ({ result: output }),
              },
            },
          },
          done: { type: "final" },
        },
      });

      using actor = await createActor<{
        status: string;
        value: string;
        context: { token: number; result?: number };
      }>({ machine });

      await expect(actor.send({ type: "GO" })).rejects.toThrow(
        /State machine transition failed.*boom in transition/,
      );
      expect(await actor.snapshot()).toMatchObject({
        status: "active",
        value: "idle",
        context: { token: 0 },
      });
      expect(actorRuns).toBe(0);

      failing = false;
      await actor.send({ type: "GO" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "done",
        context: { token: 1, result: 1 },
      });
      expect(actorRuns).toBe(1);
    },
  );

  it(
    "fails an infinite eventless loop terminally instead of exhausting memory",
    { timeout: 60_000 },
    async () => {
      const machine = setup({
        schemas: { context: types<{ loops: number }>() },
      }).createMachine({
        id: "transition-loop",
        context: { loops: 0 },
        initial: "idle",
        states: {
          idle: { on: { SPIN: { target: "a" }, PING: { target: "ok" } } },
          a: { always: { target: "b" } },
          b: { always: { target: "a" } },
          ok: {},
        },
      });

      using actor = await createActor<{ value: string }>({ machine });

      await expect(actor.send({ type: "SPIN" })).rejects.toThrow(
        /InfiniteTransitionError/,
      );
      expect(await actor.snapshot()).toMatchObject({ value: "idle" });
      await actor.send({ type: "PING" });
      expect(await actor.snapshot()).toMatchObject({ value: "ok" });
    },
  );

  it(
    "leaves an existing instance untouched when re-creating it fails",
    { timeout: 60_000 },
    async () => {
      // XState turns a throwing context factory into an `error` snapshot, so
      // use a failure XState does throw: an eventless loop chosen by input.
      const machine = setup({
        schemas: {
          input: types<{ spin?: boolean }>(),
          context: types<{ created: number; spin: boolean }>(),
        },
      }).createMachine({
        id: "transition-create-failure",
        context: ({ input }) => ({ created: 1, spin: input.spin === true }),
        initial: "idle",
        states: {
          idle: {
            always: ({ context }) =>
              context.spin ? { target: "spinning" } : undefined,
            on: { NEXT: { target: "next" } },
          },
          spinning: { always: { target: "idle" } },
          next: {},
        },
      });

      using actor = await createActor<{
        value: string;
        context: { created: number; spin: boolean };
      }>({ machine });
      await actor.send({ type: "NEXT" });

      await expect(actor.create({ spin: true })).rejects.toThrow(
        /State machine transition failed \(create\).*InfiniteTransitionError/,
      );
      expect(await actor.snapshot()).toMatchObject({
        value: "next",
        context: { created: 1 },
      });
    },
  );
});
