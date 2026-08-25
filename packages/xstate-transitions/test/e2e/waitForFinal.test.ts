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
 * A `waitFor` that arrives after an instance is already final must resolve
 * immediately from the persisted snapshot. The exclusive `subscribe` handler
 * rechecks the rehydrated snapshot for both completion and context markers,
 * so neither condition can be missed when registration races a transition.
 */

import { expect, it } from "vitest";
import { createMachine } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machine = createMachine({
  id: "wait-after-done",
  context: {} as { completed?: boolean },
  initial: "active",
  states: {
    active: {
      on: { GO: { target: "finished", context: { completed: false } } },
    },
    finished: { type: "final" },
  },
  output: () => ({ ok: true }),
});

describeE2E("waitFor on an already-final instance", (createActor) => {
  it(
    "resolves immediately from the persisted final snapshot",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{ status?: string; output?: unknown }>({
        machine,
      });

      // Drive the instance to its final state first.
      await actor.send({ type: "GO" });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
      });

      // Subscribing for completion now must resolve straight away.
      await expect(actor.waitFor("done")).resolves.toMatchObject({
        status: "done",
        context: { completed: false },
        output: { ok: true },
      });
    },
  );

  it(
    "does not miss a marker when waiting and sending concurrently",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor<{
        status?: string;
        context: { completed?: boolean };
      }>({ machine });

      const waiting = actor.waitFor("/completed", 5_000);
      await actor.send({ type: "GO" });

      await expect(waiting).resolves.toMatchObject({
        status: "done",
        context: { completed: false },
      });
    },
  );

  it(
    "rejects a missing context marker once the machine is terminal",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor({ machine });
      await actor.send({ type: "GO" });

      await expect(actor.waitFor("/missing")).rejects.toThrow(
        "State machine completed without the condition being met",
      );
    },
  );

  it(
    "unregisters a waiter after its timeout",
    { timeout: 60_000 },
    async () => {
      using actor = await createActor({ machine });

      await expect(actor.waitFor("/missing", 100)).rejects.toThrow();

      // The exclusive unregister call must finish without blocking later work.
      await actor.send({ type: "GO" });
      await expect(actor.snapshot()).resolves.toMatchObject({ status: "done" });
    },
  );
});
