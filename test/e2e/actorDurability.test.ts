/*
 * Every actor runs inside ctx.run, so its side effect executes exactly once and
 * its result is journaled (replay-safe). This covers both a vanilla xstate
 * fromPromise and our ctx-less fromPromise.
 *
 * The assertion that matters runs under the alwaysReplay mode of describeE2E: if
 * the actor re-ran on replay (as it would without the ctx.run wrapping), the
 * in-process counter would climb past 1.
 */

import { expect, it } from "vitest";
import {
  assign,
  setup,
  type AnyActorLogic,
  fromPromise as xstateFromPromise,
} from "xstate";
import { fromPromise } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

type CounterSnapshot = { status?: string; context: { result: number } };

const counterMachine = (work: AnyActorLogic) =>
  setup({ actors: { work } }).createMachine({
    id: "durability",
    initial: "running",
    context: { result: 0 },
    states: {
      running: {
        invoke: {
          src: "work",
          onDone: {
            target: "done",
            actions: assign({ result: ({ event }) => event.output as number }),
          },
        },
      },
      done: { type: "final" },
    },
  });

describeE2E("Actor durability (exactly-once via ctx.run)", (createActor) => {
  it(
    "runs a vanilla xstate actor's side effect exactly once (journaled)",
    { timeout: 20_000 },
    async () => {
      let runs = 0;
      using actor = await createActor<CounterSnapshot>({
        machine: counterMachine(xstateFromPromise(async () => ++runs)),
      });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
      });

      const snap = await actor.snapshot();
      expect(snap.context.result).toBe(1);
      // Journaled: replay does not re-run the actor, so the counter stays at 1.
      expect(runs).toBe(1);
    },
  );

  it(
    "runs a basic fromPromise's side effect exactly once (journaled)",
    { timeout: 20_000 },
    async () => {
      let runs = 0;
      using actor = await createActor<CounterSnapshot>({
        machine: counterMachine(fromPromise(async () => ++runs)),
      });

      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
      });

      const snap = await actor.snapshot();
      expect(snap.context.result).toBe(1);
      expect(runs).toBe(1);
    },
  );
});
