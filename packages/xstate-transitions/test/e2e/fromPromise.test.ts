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
 * Ctx-less Restate promise actors (fromPromise):
 *  - basic (default): any rejection is terminal -> onError, no retry (fail-fast);
 *  - retryable ({ retry }): transient rejections are retried by Restate's ctx.run,
 *    while a TerminalError or an exhausted policy routes to onError.
 * The creator receives only `{ input }` — no Restate ctx (that is fromHandler).
 */

import { TerminalError } from "@restatedev/restate-sdk";
import { expect, it, vi } from "vitest";
import { setup, types } from "xstate";
import { fromPromise, type FromPromiseOptions } from "../../src";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

const emailMachine = (
  sendEmail: (customer: string) => Promise<void>,
  options?: FromPromiseOptions,
) =>
  setup({
    schemas: {
      input: types<{ customer: string }>(),
      context: types<{ customer: string }>(),
    },
    actorSources: {
      sendEmail: fromPromise<undefined, { customer: string }>(
        async ({ input }) => {
          await sendEmail(input.customer);
        },
        options,
      ),
    },
  }).createMachine({
    id: "ctxless-email",
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

type EmailSnapshot = { status?: string; value?: string } | undefined;

describeE2E("A basic fromPromise (fail-fast)", (createActor) => {
  it("completes on success", { timeout: 20_000 }, async () => {
    const sendEmail = vi
      .fn<(customer: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    using actor = await createActor<EmailSnapshot>({
      machine: emailMachine(sendEmail),
      input: { customer: "bob@mop.com" },
    });
    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "Email sent",
    });
    expect(sendEmail).toHaveBeenCalledWith("bob@mop.com");
  });

  it(
    "routes any rejection to onError without retrying",
    { timeout: 20_000 },
    async () => {
      const sendEmail = vi
        .fn<(customer: string) => Promise<void>>()
        .mockRejectedValue(new Error("smtp down"));
      using actor = await createActor<EmailSnapshot>({
        machine: emailMachine(sendEmail),
        input: { customer: "bob@mop.com" },
      });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "Failed",
      });
      // fail-fast: exactly one attempt, no Restate retry.
      expect(sendEmail).toHaveBeenCalledTimes(1);
    },
  );
});

describeE2E("A retryable fromPromise", (createActor) => {
  it(
    "retries a transient rejection until it succeeds",
    { timeout: 30_000 },
    async () => {
      const sendEmail = vi
        .fn<(customer: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue(undefined);
      using actor = await createActor<EmailSnapshot>({
        machine: emailMachine(sendEmail, { retry: true }),
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

  it(
    "routes to onError once a bounded policy is exhausted",
    { timeout: 30_000 },
    async () => {
      const sendEmail = vi
        .fn<(customer: string) => Promise<void>>()
        .mockRejectedValue(new Error("always failing"));
      using actor = await createActor<EmailSnapshot>({
        machine: emailMachine(sendEmail, { retry: { maxRetryAttempts: 2 } }),
        input: { customer: "bob@mop.com" },
      });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "Failed",
      });
      expect(sendEmail).toHaveBeenCalledTimes(2);
    },
  );

  it("does not retry a TerminalError", { timeout: 20_000 }, async () => {
    const sendEmail = vi
      .fn<(customer: string) => Promise<void>>()
      .mockRejectedValue(new TerminalError("nope"));
    using actor = await createActor<EmailSnapshot>({
      machine: emailMachine(sendEmail, { retry: true }),
      input: { customer: "bob@mop.com" },
    });
    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "Failed",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
