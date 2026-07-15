import { assign, createMachine, sendParent, sendTo, setup } from "xstate";
import { expect, it } from "vitest";
import { eventually } from "./eventually";
import { describeE2E } from "./harness";

const delayedSelfMachine = setup({
  types: {
    context: {} as { seen: string[] },
    events: {} as { type: "SEEN"; value: string },
  },
}).createMachine({
  id: "delayed-self",
  context: { seen: [] },
  entry: [
    sendTo(({ self }) => self, { type: "SEEN", value: "first" }, { delay: 0 }),
    sendTo(({ self }) => self, { type: "SEEN", value: "second" }, { delay: 0 }),
  ],
  on: {
    SEEN: {
      actions: assign({
        seen: ({ context, event }) => [...context.seen, event.value],
      }),
    },
  },
  always: {
    guard: ({ context }) => context.seen.length === 2,
    target: ".done",
  },
  initial: "waiting",
  states: {
    waiting: {},
    done: { type: "final" },
  },
});

const child = createMachine({
  id: "restartable-child",
  entry: sendParent({ type: "CHILD_READY" }),
});

const restartableParent = setup({
  actors: { child },
  types: {
    context: {} as { readyCount: number },
    events: {} as { type: "CHILD_READY" } | { type: "RESTART" },
  },
}).createMachine({
  id: "restartable-parent",
  context: { readyCount: 0 },
  initial: "running",
  on: {
    CHILD_READY: {
      actions: assign({
        readyCount: ({ context }) => context.readyCount + 1,
      }),
    },
  },
  states: {
    running: {
      invoke: { id: "kid", src: "child" },
      on: { RESTART: { target: "running", reenter: true } },
    },
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
});
