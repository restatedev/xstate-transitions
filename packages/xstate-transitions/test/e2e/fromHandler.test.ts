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
 * Ctx-aware Restate actors (fromHandler): the creator receives the Restate ctx
 * and journals its own side effects with ctx.run, across three outcomes:
 *  (1) success: the ctx.run side-effect runs once -> "Email sent";
 *  (2) transient error: rejected twice then resolves -> 3 invocations (the inner
 *      ctx.run retries the effect) -> "Email sent";
 *  (3) TerminalError: not retried -> 1 invocation -> onError -> "Failed".
 */

import { TerminalError } from "@restatedev/restate-sdk";
import { expect, it, vi } from "vitest";
import { setup, types } from "xstate";
import { fromHandler } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const machineFactory = (sendEmail: (customer: string) => Promise<void>) =>
  setup({
    schemas: {
      input: types<{ customer: string }>(),
      context: types<{ customer: string }>(),
    },
    actorSources: {
      sendEmail: fromHandler<undefined, { customer: string }>(
        async ({ input, ctx }) => {
          await ctx.run("Sending email to", async () => {
            await sendEmail(input.customer);
          });
        },
      ),
    },
  }).createMachine({
    id: "handler-invocation",
    initial: "Send email",
    context: ({ input }) => ({ customer: input.customer }),
    states: {
      "Send email": {
        invoke: {
          src: "sendEmail",
          input: ({ context }) => ({ customer: context.customer }),
          onDone: { target: "Email sent" },
          onError: { target: "Failed" },
        },
      },
      "Email sent": { type: "final" },
      Failed: { type: "final" },
    },
  });

describeE2E("A fromHandler state machine", (createActor) => {
  it(
    "runs the actor with the Restate context",
    { timeout: 20_000 },
    async () => {
      const sendEmail = vi.fn<(customer: string) => Promise<void>>();
      using actor = await createActor<{ status?: string } | undefined>({
        machine: machineFactory(sendEmail),
        input: { customer: "bob@mop.com" },
      });
      await vi.waitFor(() =>
        expect(sendEmail).toHaveBeenCalledWith("bob@mop.com"),
      );
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "Email sent",
      });
    },
  );

  it(
    "retries a transient error via the inner ctx.run",
    { timeout: 30_000 },
    async () => {
      const sendEmail = vi
        .fn<(customer: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("Fail to send email"))
        .mockRejectedValueOnce(new Error("Fail to send email"))
        .mockResolvedValue(undefined);
      using actor = await createActor<{ status?: string } | undefined>({
        machine: machineFactory(sendEmail),
        input: { customer: "bob@mop.com" },
      });
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(3), {
        timeout: 20_000,
      });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "Email sent",
      });
    },
  );

  it("routes a TerminalError to onError", { timeout: 20_000 }, async () => {
    const sendEmail = vi
      .fn<(customer: string) => Promise<void>>()
      .mockRejectedValueOnce(new TerminalError("Fail to send email"));
    using actor = await createActor<{ status?: string } | undefined>({
      machine: machineFactory(sendEmail),
      input: { customer: "bob@mop.com" },
    });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "Failed",
    });
  });
});
