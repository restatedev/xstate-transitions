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
 * Cross-machine (invoke of a child MACHINE, keyed parent::childId) semantics
 * that only matter across virtual-object boundaries: the ordering of a child's
 * own outgoing event vs. the invoke's done report, input flowing into a child's
 * context, an unhandled error cascading up, and done events being addressed to
 * the correct invoking region when two regions invoke the same child machine.
 *
 * Ported from upstream xstate final.test.ts / invoke.test.ts / input.test.ts /
 * errors.test.ts, adapted to observe everything through the parent (the runner
 * exposes only the root instance) and through persisted snapshots.
 */

import { it } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

// --- child final outgoing event vs xstate.done.actor ordering ----------------

const cancelingChild = setup({}).createMachine({
  id: "child",
  initial: "running",
  states: {
    running: { always: { target: "canceled" } },
    canceled: {
      type: "final",
      // The child's final entry sends an application event to the parent. It
      // must reach the parent BEFORE the invoke's xstate.done.actor.* report, so
      // the parent lands in `canceled`, not `completed`.
      entry: ({ parent }, enq) => {
        enq.sendTo(parent, { type: "CHILD_CANCELED" });
      },
    },
  },
});

const orderingParent = setup({
  actorSources: { child: cancelingChild },
}).createMachine({
  id: "parent",
  initial: "waiting",
  states: {
    waiting: {
      invoke: { src: "child", id: "kid", onDone: { target: "completed" } },
      on: { CHILD_CANCELED: { target: "canceled" } },
    },
    completed: { type: "final" },
    canceled: { type: "final" },
  },
});

// --- input flowing into a child machine's context ----------------------------

const echoChild = setup({
  schemas: {
    context: types<{ greeting?: string }>(),
    input: types<{ greeting: string }>(),
  },
}).createMachine({
  id: "echo",
  context: ({ input }) => ({ greeting: input.greeting }),
  initial: "done",
  states: {
    done: {
      type: "final",
      output: ({ context }) => ({ echo: context.greeting }),
    },
  },
});

const inputParent = setup({ actorSources: { echo: echoChild } }).createMachine({
  id: "input-parent",
  schemas: { context: types<{ childEcho: string | null }>() },
  context: { childEcho: null },
  initial: "run",
  states: {
    run: {
      invoke: {
        src: "echo",
        input: () => ({ greeting: "hello" }),
        onDone: {
          target: "done",
          context: ({ event }) => ({
            childEcho: (event.output as { echo: string }).echo,
          }),
        },
      },
    },
    done: { type: "final" },
  },
});

// --- unhandled error cascade across virtual objects --------------------------

const throwingChild = setup({
  actorSources: {
    boom: fromPromise(async () => {
      throw new Error("boom");
    }),
  },
}).createMachine({
  id: "throwing-child",
  initial: "run",
  // No onError anywhere: the rejection is unhandled and the child reaches
  // status 'error'.
  states: { run: { invoke: { src: "boom" } } },
});

const cascadeParent = setup({
  actorSources: { child: throwingChild },
}).createMachine({
  id: "cascade-parent",
  initial: "run",
  // No onError: the child's error is reported to the parent and is likewise
  // unhandled, so the parent must also reach status 'error'.
  states: { run: { invoke: { src: "child", id: "kid" } } },
});

// --- done addressing across two invokes of the SAME child machine ------------

const worker = setup({}).createMachine({
  id: "worker",
  initial: "a",
  states: { a: { type: "final", output: { done: true } } },
});

const twoInvokesParent = setup({
  actorSources: { worker },
}).createMachine({
  id: "two-invokes",
  type: "parallel",
  schemas: { context: types<{ first: unknown; second: unknown }>() },
  context: { first: null, second: null },
  states: {
    r1: {
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "worker",
            id: "w1",
            onDone: {
              target: "done",
              context: ({ context, event }) => ({
                ...context,
                first: event.output,
              }),
            },
          },
        },
        done: { type: "final" },
      },
    },
    r2: {
      initial: "run",
      states: {
        run: {
          invoke: {
            src: "worker",
            id: "w2",
            onDone: {
              target: "done",
              context: ({ context, event }) => ({
                ...context,
                second: event.output,
              }),
            },
          },
        },
        done: { type: "final" },
      },
    },
  },
});

describeE2E("Cross-machine ordering and routing", (createActor) => {
  it(
    "delivers a child's final outgoing event to the parent before the invoke's done event",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<
        { status?: string; value?: string },
        typeof orderingParent
      >({ machine: orderingParent });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "canceled",
      });
    },
  );

  it(
    "populates an invoked child machine's context from parent-supplied input",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<
        { value?: string; context: { childEcho: string | null } },
        typeof inputParent
      >({ machine: inputParent });

      await eventually(() => actor.snapshot()).toMatchObject({
        value: "done",
        context: { childEcho: "hello" },
      });
    },
  );

  it(
    "cascades an unhandled child error up to the parent virtual object",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<
        { status?: string },
        typeof cascadeParent
      >({ machine: cascadeParent });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "error",
      });
    },
  );

  it(
    "addresses each done to its own invoking region when two invoke the same child machine",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<
        { status?: string; context: { first: unknown; second: unknown } },
        typeof twoInvokesParent
      >({ machine: twoInvokesParent });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        context: { first: { done: true }, second: { done: true } },
      });
    },
  );
});
