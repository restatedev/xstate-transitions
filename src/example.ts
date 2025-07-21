import { assign, fromPromise, setup } from "xstate";
import * as restate from "@restatedev/restate-sdk";
import { createMachineObject } from "./core";

/* const machine = setup({
  actors: {
    sendWelcomeEmail: fromPromise(async () => {
      return {
        status: "sent",
      };
    }),
  },
}).createMachine({
  initial: "sendingWelcomeEmail",
  states: {
    sendingWelcomeEmail: {
      invoke: {
        src: "sendWelcomeEmail",
        input: () => ({ message: "hello world", subject: "hi" }),
        onDone: "logSent",
      },
    },
    logSent: {
      invoke: {
        src: fromPromise(async () => {}),
        onDone: "finish",
      },
    },
    finish: {},
  },
});
 */


/*
export type Applicant = {
  name: string;
  age: number;
  email: string;
};

export const machine = setup({
  types: {} as {
    context: {
      applicant: Applicant;
    };
    input: {
      applicant: Applicant;
    };
  },
  actors: {
    startApplicationWorkflowId: fromPromise(async () => {
      console.log("startApplicationWorkflowId workflow started");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log("startApplicationWorkflowId workflow completed");
    }),
    sendRejectionEmailFunction: fromPromise(async () => {
      console.log("sendRejectionEmailFunction workflow started");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log("sendRejectionEmailFunction workflow completed");
    }),
  },
  guards: {
    isOver18: ({ context }) => context.applicant.age >= 18,
  },
}).createMachine({
  id: "applicantrequest",

  initial: "CheckApplication",
  context: ({ input }) => ({
    applicant: input.applicant,
  }),
  states: {
    CheckApplication: {
      on: {
        Submit: [
          {
            target: "StartApplication",
            guard: "isOver18",
            reenter: false,
          },
          {
            target: "RejectApplication",
            reenter: false,
          },
        ],
      },
    },
    StartApplication: {
      invoke: {
        src: "startApplicationWorkflowId",
        onDone: "End",
        onError: "RejectApplication",
      },
    },
    RejectApplication: {
      invoke: {
        src: "sendRejectionEmailFunction",
        input: ({ context }) => ({
          applicant: context.applicant,
        }),
        onDone: "End",
      },
    },
    End: {
      type: "final",
    },
  },
});
*/

interface Customer {
  id: string;
  name: string;
  SSN: number;
  yearlyIncome: number;
  address: string;
  employer: string;
}


// https://github.com/serverlessworkflow/specification/tree/main/examples#perform-customer-credit-check-example
export const machine = setup({
  types: {
    context: {} as {
      customer: Customer;
      creditCheck: {
        decision: "Approved" | "Denied";
      } | null;
    },
    input: {} as {
      customer: Customer;
    },
  },
  actors: {
    callCreditCheckMicroservice: fromPromise(
      ({ input }: { input: { customer: Customer } }) => {
        console.log("calling credit check microservice", input);
        return Promise.resolve({
          id: "customer123",
          score: 700,
          decision: "Approved" as const,
          reason: "Good credit score",
        });
      },
    ),
    startApplicationWorkflowId: fromPromise(
      async ({ input }: { input: { customer: Customer } }) => {
        console.log("starting application workflow", input);
        // fake 1s
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          application: {
            id: "application123",
            status: "Approved",
          },
        };
      },
    ),
    sendRejectionEmailFunction: fromPromise(
      async ({ input }: { input: { applicant: Customer } }) => {
        console.log("sending rejection email", input);
        // fake 1s
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          email: {
            id: "email123",
            status: "Sent",
          },
        };
      },
    ),
  },
  delays: {
    PT15M: 15 /** 60 * 1000*/,
  },
}).createMachine({
  id: "customercreditcheck",
  initial: "CheckCredit",
  context: ({ input }) => ({
    customer: input.customer,
    creditCheck: null,
  }),
  states: {
    CheckCredit: {
      invoke: {
        src: "callCreditCheckMicroservice",
        input: ({ context }) => ({
          customer: context.customer,
        }),
        onDone: {
          target: "EvaluateDecision",
          actions: assign({
            creditCheck: ({ event }) => event.output,
          }),
        },
      },
      // timeout
      after: {
        PT15M: "Timeout",
      },
    },
    EvaluateDecision: {
      always: [
        {
          guard: ({ context }) => context.creditCheck?.decision === "Approved",
          target: "StartApplication",
        },
        {
          guard: ({ context }) => context.creditCheck?.decision === "Denied",
          target: "RejectApplication",
        },
        {
          target: "RejectApplication",
        },
      ],
    },
    StartApplication: {
      invoke: {
        src: "startApplicationWorkflowId",
        input: ({ context }) => ({
          customer: context.customer,
        }),
        onDone: {
          target: "End",
        },
      },
    },
    RejectApplication: {
      invoke: {
        src: "sendRejectionEmailFunction",
        input: ({ context }) => ({
          applicant: context.customer,
        }),
        onDone: {
          target: "End",
        },
      },
    },
    End: {
      type: "final",
    },

    Timeout: {
      type: "final",
    },
  },
  output: ({ context }) => ({
    decision: context.creditCheck?.decision,
  }),
});

restate
  .endpoint()
  .bind(
    createMachineObject("workflow", machine, { journalRetention: { days: 1 } })
  )
  .listen();