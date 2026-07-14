/*
 * GAP TEST (scaffold, todo) — BLOCKED BY: Phase 4 "Restate-aware fromPromise (ctx)"
 * and Phase 5 "promise retry semantics".
 *
 * Target behaviour (3 cases):
 *  (1) success: the ctx.run side-effect runs once -> "Email sent";
 *  (2) transient error: rejected twice then resolves -> 3 invocations (Restate
 *      retries the effect) -> "Email sent";
 *  (3) TerminalError: not retried -> 1 invocation -> onError -> "Failed".
 *
 * Un-skip when: a Restate-aware `fromPromise` from ../src passes `{ input, ctx }`
 * to the creator (ctx.run available), `_execute` catches ONLY TerminalError to emit
 * onError while letting transient errors propagate for Restate to retry.
 *
 * NOTE: currently imports vanilla `fromPromise` from "xstate" so collection
 * succeeds; switch to `../src` when it exists. `ctx` usage below is the
 * target shape and only type-checks against the future module.
 */

import { describe, expect, it, vi } from "vitest";
import { createRestateTestActor } from "./runner";
import { fromPromise } from "../src";
import { setup } from "xstate";
import { eventually } from "./eventually.js";
import { TerminalError } from "@restatedev/restate-sdk";

const machineFactory = (sendEmail: (customer: string) => Promise<void>) =>
  setup({
    types: {
      input: {} as { customer: string },
      context: {} as { customer: string },
    },
    actors: {
      sendEmail: fromPromise<undefined, { customer: string }>(
        async ({ input, ctx }) => {
          await ctx.run("Sending email to", async () => {
            await sendEmail(input.customer);
          });
        },
      ),
    },
  }).createMachine({
    id: "async-function-invocation",
    initial: "Send email",
    context: ({ input }) => ({ customer: input.customer }),
    states: {
      "Send email": {
        invoke: {
          src: "sendEmail",
          input: ({ context }) => ({ customer: context.customer }),
          onDone: "Email sent",
          onError: "Failed",
        },
      },
      "Email sent": { type: "final" },
      Failed: { type: "final" },
    },
  });

describe("A Restate-aware fromPromise state machine", () => {
  it(
    "should run the promise actor with restate context",
    { timeout: 20_000 },
    async () => {
      const sendEmail = vi.fn<(customer: string) => Promise<void>>();
      using actor = await createRestateTestActor<
        { status?: string } | undefined
      >({
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
    "should retry a transient error in fromPromise",
    { timeout: 20_000 },
    async () => {
      const sendEmail = vi
        .fn<(customer: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("Fail to send email"))
        .mockRejectedValueOnce(new Error("Fail to send email"))
        .mockResolvedValue(undefined);
      using actor = await createRestateTestActor<
        { status?: string } | undefined
      >({
        machine: machineFactory(sendEmail),
        input: { customer: "bob@mop.com" },
      });
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(3), {
        timeout: 10_000,
      });
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "Email sent",
      });
    },
  );

  it(
    "should route a terminal error to onError",
    { timeout: 20_000 },
    async () => {
      const sendEmail = vi
        .fn<(customer: string) => Promise<void>>()
        .mockRejectedValueOnce(new TerminalError("Fail to send email"));
      using actor = await createRestateTestActor<
        { status?: string } | undefined
      >({
        machine: machineFactory(sendEmail),
        input: { customer: "bob@mop.com" },
      });
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
      await eventually(() => actor.snapshot()).toMatchObject({
        status: "done",
        value: "Failed",
      });
    },
  );
});
