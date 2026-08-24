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
 * Context-path conditions backed by Restate awakeables make the instant
 * `EvaluateDecision` state observable after the macrostep through a durable
 * context marker. Event delivery remains a separate call from waiting, while
 * `done` still waits for machine completion.
 */

import { expect, it } from "vitest";
import { setup, types } from "xstate";
import { fromPromise } from "../../src";
import { describeE2E } from "./harness";

interface Customer {
  id: string;
  name: string;
  SSN: number;
  yearlyIncome: number;
  address: string;
  employer: string;
}

const workflow = setup({
  schemas: {
    context: types<{
      customer: Customer | null;
      creditCheck: { decision: "Approved" | "Denied" } | null;
      WaitForInput: true;
      EvaluateDecision?: true;
      End?: true;
    }>(),
    input: types<{ customer: Customer }>(),
    events: {
      start: types<{ customer: Customer }>(),
    },
  },
  actors: {
    callCreditCheckMicroservice: fromPromise(
      ({ input }: { input: { customer: Customer } }) =>
        Promise.resolve({
          id: input.customer.id,
          score: 700,
          decision: "Approved" as const,
          reason: "Good credit score",
        }),
    ),
    startApplicationWorkflowId: fromPromise(
      async ({ input: _input }: { input: { customer: Customer } }) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { application: { id: "application123", status: "Approved" } };
      },
    ),
    sendRejectionEmailFunction: fromPromise(
      async ({ input: _input }: { input: { applicant: Customer } }) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { email: { id: "email123", status: "Sent" } };
      },
    ),
  },
}).createMachine({
  id: "customercreditcheck",
  initial: "WaitForInput",
  context: () => ({
    customer: null,
    creditCheck: null,
    WaitForInput: true as const,
  }),
  states: {
    WaitForInput: {
      on: {
        start: {
          context: ({ event }) => ({ customer: event.customer }),
          target: "CheckCredit",
        },
      },
    },
    CheckCredit: {
      invoke: {
        src: "callCreditCheckMicroservice",
        input: ({ context }) => ({ customer: context.customer! }),
        onDone: {
          target: "EvaluateDecision",
          context: ({ output }) => ({
            creditCheck: output,
            EvaluateDecision: true,
          }),
        },
      },
      // PT15M (15 minutes) in the spec.
      after: { 900_000: { target: "Timeout" } },
    },
    EvaluateDecision: {
      always: ({ context }) =>
        context.creditCheck?.decision === "Approved"
          ? { target: "StartApplication" }
          : { target: "RejectApplication" },
    },
    StartApplication: {
      invoke: {
        src: "startApplicationWorkflowId",
        input: ({ context }) => ({ customer: context.customer! }),
        onDone: { target: "End" },
      },
    },
    RejectApplication: {
      invoke: {
        src: "sendRejectionEmailFunction",
        input: ({ context }) => ({ applicant: context.customer! }),
        onDone: { target: "End" },
      },
    },
    End: {
      type: "final",
      entry: () => ({ context: { End: true } }),
    },
    Timeout: {},
  },
  output: ({ context }) => ({ decision: context.creditCheck?.decision }),
});

describeE2E("A credit check workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using wf = await createActor<{
      output?: { decision?: string };
      context: {
        WaitForInput: true;
        EvaluateDecision?: true;
        End?: true;
      };
    }>({ machine: workflow });

    const customer: Customer = {
      id: "customer123",
      name: "John Doe",
      SSN: 123456,
      yearlyIncome: 50000,
      address: "123 MyLane, MyCity, MyCountry",
      employer: "MyCompany",
    };

    await wf.waitFor("/WaitForInput");

    const evaluated = wf.waitFor("/EvaluateDecision", 5_000);
    const ended = wf.waitFor("/End", 5_000);
    const done = wf.waitFor("done", 5_000);
    await wf.send({ type: "start", customer });

    await expect(evaluated).resolves.toMatchObject({
      context: { EvaluateDecision: true },
    });
    await expect(ended).resolves.toMatchObject({
      context: { End: true },
      output: { decision: "Approved" },
    });
    await expect(done).resolves.toMatchObject({
      status: "done",
      output: { decision: "Approved" },
    });

    await expect(wf.waitFor("/EvaluateDecision")).resolves.toMatchObject({
      context: { EvaluateDecision: true },
    });
  });
});
