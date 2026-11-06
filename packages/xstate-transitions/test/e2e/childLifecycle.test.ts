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
 * Child machines are separate virtual objects (keyed `<parentKey>::<childId>`).
 * Whenever an instance forgets a child (it is reset by `create`, or it is
 * itself disposed), the child must be disposed too, so no child keeps running
 * unowned. A child that cannot even start must still report back to its parent.
 */

import { expect, it } from "vitest";
import { createMachine, setup, types } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const DISPOSED = /disposed/;

const idleChild = createMachine({
  id: "idle-child",
  initial: "idle",
  states: { idle: {} },
});

describeE2E("Child lifecycle", (createActor) => {
  it(
    "disposes the children of an instance that is re-created",
    { timeout: 60_000 },
    async () => {
      const machine = setup({
        schemas: {
          input: types<{ childId: string }>(),
          context: types<{ childId: string }>(),
        },
        actors: { child: idleChild },
      }).createMachine({
        id: "recreated-parent",
        context: ({ input }) => ({ childId: input.childId }),
        entry: ({ context }, enq) => {
          enq.spawn("child", { id: context.childId });
        },
      });

      using actor = await createActor({ machine, input: { childId: "a" } });
      await eventually(() => actor.snapshotOf("default::a")).toMatchObject({
        value: "idle",
      });

      await actor.create({ childId: "b" });

      await eventually(() => actor.snapshotOf("default::b")).toMatchObject({
        value: "idle",
      });
      await eventually(() =>
        actor.snapshotOf("default::a").then(
          () => "alive",
          (error: Error) => error.message,
        ),
      ).toMatch(DISPOSED);
    },
  );

  it(
    "disposes grandchildren when a child is stopped",
    { timeout: 60_000 },
    async () => {
      const middle = setup({ actors: { leaf: idleChild } }).createMachine({
        id: "middle",
        invoke: { src: "leaf", id: "g" },
      });
      const machine = setup({ actors: { middle } }).createMachine({
        id: "grandparent",
        initial: "running",
        states: {
          running: {
            invoke: { src: "middle", id: "c" },
            on: { STOP: { target: "stopped" } },
          },
          stopped: {},
        },
      });

      using actor = await createActor({ machine });
      await eventually(() => actor.snapshotOf("default::c::g")).toMatchObject({
        value: "idle",
      });

      await actor.send({ type: "STOP" });

      await eventually(() =>
        actor.snapshotOf("default::c").then(
          () => "alive",
          (error: Error) => error.message,
        ),
      ).toMatch(DISPOSED);
      await eventually(() =>
        actor.snapshotOf("default::c::g").then(
          () => "alive",
          (error: Error) => error.message,
        ),
      ).toMatch(DISPOSED);
    },
  );

  it(
    "reports a child that fails to start to its parent's onError",
    { timeout: 60_000 },
    async () => {
      const broken = createMachine({
        id: "broken-child",
        initial: "a",
        states: {
          a: { always: { target: "b" } },
          b: { always: { target: "a" } },
        },
      });
      const machine = setup({
        schemas: { context: types<{ error?: unknown }>() },
        actors: { broken },
      }).createMachine({
        id: "hopeful-parent",
        context: {},
        initial: "waiting",
        states: {
          waiting: {
            invoke: {
              src: "broken",
              id: "kid",
              onError: {
                target: "failed",
                context: ({ event }) => ({ error: event.error }),
              },
            },
          },
          failed: {},
        },
      });

      using actor = await createActor<{
        value: string;
        context: { error?: { message?: string } };
      }>({ machine });

      await eventually(() => actor.snapshot()).toMatchObject({
        value: "failed",
        context: {
          error: { message: expect.stringMatching(/InfiniteTransitionError/) },
        },
      });
    },
  );
});
