/*
 * Phase 0 — behaviour-pinning test.
 *
 * An `after` delayed transition surfaces as a delayed `xstate.raise` action,
 * which dispatchAction turns into a Restate delayed self-send. The host (Restate)
 * owns the clock, so the machine must NOT advance before the delay elapses, and
 * must advance after. This locks the delayed-self-send pattern.
 */

import { expect, it } from "vitest";
import { createMachine } from "xstate";
import { eventually, wait } from "./eventually.js";
import { describeE2E } from "./harness";

const DELAY = 2000;

const machine = createMachine({
  id: "after-delay",
  initial: "waiting",
  states: {
    waiting: { after: { [DELAY]: "done" } },
    done: { type: "final" },
  },
});

describeE2E("after (delayed) transition", (createActor) => {
  it("advances only after the delay elapses", { timeout: 60_000 }, async () => {
    using actor = await createActor<{
      status?: string;
      value?: string;
    }>({ machine });

    // Not yet advanced right after creation...
    expect(await actor.snapshot()).toMatchObject({ value: "waiting" });
    await wait(700);
    // ...and still waiting well before the delay elapses.
    expect(await actor.snapshot()).toMatchObject({ value: "waiting" });

    // Eventually advances once the delayed self-send fires.
    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "done",
    });
  });
});
