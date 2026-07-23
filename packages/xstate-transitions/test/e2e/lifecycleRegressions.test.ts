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
import { createMachine, setup, types } from "xstate";
import { eventually } from "./eventually";
import { describeE2E } from "./harness";

const delayedSelfMachine = setup({
  schemas: {
    context: types<{ seen: string[] }>(),
    events: {
      SEEN: types<{ value: string }>(),
    },
  },
}).createMachine({
  id: "delayed-self",
  context: { seen: [] },
  entry: ({ self }, enq) => {
    enq.sendTo(self, { type: "SEEN", value: "first" }, { delay: 0 });
    enq.sendTo(self, { type: "SEEN", value: "second" }, { delay: 0 });
  },
  on: {
    SEEN: ({ context, event }) => ({
      context: { seen: [...context.seen, event.value] },
    }),
  },
  always: ({ context }) =>
    context.seen.length === 2 ? { target: ".done" } : undefined,
  initial: "waiting",
  states: {
    waiting: {},
    done: { type: "final" },
  },
});

const child = createMachine({
  id: "restartable-child",
  entry: ({ parent }, enq) => {
    enq.sendTo(parent, { type: "CHILD_READY" });
  },
});

const restartableParent = setup({
  actorSources: { child },
  schemas: {
    context: types<{ readyCount: number }>(),
  },
}).createMachine({
  id: "restartable-parent",
  context: { readyCount: 0 },
  initial: "running",
  on: {
    CHILD_READY: ({ context }) => ({
      context: { readyCount: context.readyCount + 1 },
    }),
  },
  states: {
    running: {
      invoke: { id: "kid", src: "child" },
      on: { RESTART: { target: "running", reenter: true } },
    },
  },
});

const stoppableChild = createMachine({ id: "stoppable-child" });

const explicitStopParent = setup({
  actorSources: { child: stoppableChild },
  schemas: {
    context: types<{ ref: unknown; stopped: boolean }>(),
  },
}).createMachine({
  id: "explicit-stop-parent",
  context: { ref: undefined, stopped: false },
  initial: "running",
  states: {
    running: {
      entry: (_, enq) => ({
        context: { ref: enq.spawn(stoppableChild, { id: "kid" }) },
      }),
      on: {
        STOP: ({ context }, enq) => {
          enq.stop(context.ref as never);
          return { target: "stopped", context: { stopped: true } };
        },
      },
    },
    stopped: {},
  },
});

describeE2E("Lifecycle regressions", (createActor) => {
  it(
    "delivers every unnamed zero-delay sendTo(self) event",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status: string;
        context: { seen: string[] };
      }>({ machine: delayedSelfMachine });

      const snapshot = await actor.waitFor("done", undefined, 5_000);

      expect(snapshot.status).toBe("done");
      expect(snapshot.context.seen).toEqual(["first", "second"]);
    },
  );

  it(
    "disposes and restarts a re-entered machine child",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        context: { readyCount: number };
      }>({ machine: restartableParent });

      await eventually(() => actor.snapshot()).toMatchObject({
        context: { readyCount: 1 },
      });
      await actor.send({ type: "RESTART" });
      await eventually(() => actor.snapshot()).toMatchObject({
        context: { readyCount: 2 },
      });
    },
  );

  it(
    "stops a context-held child ref after durable rehydration",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        value: string;
        context: { stopped: boolean };
      }>({ machine: explicitStopParent });

      await actor.send({ type: "STOP" });
      expect(await actor.snapshot()).toMatchObject({
        value: "stopped",
        context: { stopped: true },
      });
    },
  );
});
