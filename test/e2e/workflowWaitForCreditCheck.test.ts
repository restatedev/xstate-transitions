/*
 * Server-side conditions backed by Restate awakeables:
 *  - waitFor("hasTag:WaitForInput") resolves on the start node's tag;
 *  - waitFor("done", startEvent) sends an event and awaits final -> output.decision === "Approved";
 *  - waitFor("hasTag:EvaluateDecision") rejects "State machine completed without the
 *    condition being met" (that state is transited-through instantaneously, never observed
 *    as a settled macrostep);
 *  - waitFor("hasTag:End") resolves on the final state.
 */

import { expect, it } from "vitest";
import { assign, fromPromise, setup } from "xstate";
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
  types: {
    context: {} as {
      customer: Customer | null;
      creditCheck: { decision: "Approved" | "Denied" } | null;
    },
    input: {} as { customer: Customer },
    events: {} as { type: "start"; customer: Customer },
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
  delays: { PT15M: 15 * 60 * 1000 },
}).createMachine({
  id: "customercreditcheck",
  initial: "WaitForInput",
  context: () => ({ customer: null, creditCheck: null }),
  states: {
    WaitForInput: {
      on: {
        start: {
          actions: assign({ customer: ({ event }) => event.customer }),
          target: "CheckCredit",
        },
      },
      tags: ["WaitForInput"],
    },
    CheckCredit: {
      invoke: {
        src: "callCreditCheckMicroservice",
        input: ({ context }) => ({ customer: context.customer! }),
        onDone: {
          target: "EvaluateDecision",
          actions: assign({ creditCheck: ({ event }) => event.output }),
        },
      },
      after: { PT15M: "Timeout" },
    },
    EvaluateDecision: {
      always: [
        {
          guard: ({ context }) => context.creditCheck?.decision === "Approved",
          target: "StartApplication",
        },
        { target: "RejectApplication" },
      ],
      tags: ["EvaluateDecision"],
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
    End: { type: "final", tags: ["End"] },
    Timeout: {},
  },
  output: ({ context }) => ({ decision: context.creditCheck?.decision }),
});

describeE2E("A credit check workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using wf = await createActor<{ output?: { decision?: string } }>({
      machine: workflow,
    });

    const customer: Customer = {
      id: "customer123",
      name: "John Doe",
      SSN: 123456,
      yearlyIncome: 50000,
      address: "123 MyLane, MyCity, MyCountry",
      employer: "MyCompany",
    };

    await wf.waitFor("hasTag:WaitForInput");

    await Promise.all([
      expect(
        wf.waitFor("done", { type: "start", customer }),
      ).resolves.toMatchObject({ output: { decision: "Approved" } }),

      expect(wf.waitFor("hasTag:EvaluateDecision")).rejects.toThrow(
        "State machine completed without the condition being met",
      ),

      expect(wf.waitFor("hasTag:End")).resolves.toMatchObject({
        output: { decision: "Approved" },
      }),
    ]);
  });
});
