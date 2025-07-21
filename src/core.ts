import {
  type AnyStateMachine,
  type SnapshotFrom,
  type InputFrom,
  type EventFrom,
  fromPromise,
  initialTransition,
  transition,
  setup,
  assign,
} from "xstate";


import * as restate from "@restatedev/restate-sdk";
import type { ExecuteActionRequest, MachineVirtualObject, ActionDispatcher, MachineObjectOptions } from "./types";
import { dispatchAction, doExecuteAction } from "./xstate_integration";
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


// --------------------------------------------------------
// utils 
// --------------------------------------------------------

function actionDispatcher<P extends string, M extends AnyStateMachine>(
  name: P,
  context: restate.ObjectSharedContext
): ActionDispatcher<M> {
  const self = { name } as restate.VirtualObjectDefinition<
    string,
    MachineVirtualObject<M>
  >;

  return {
    dispatchExecuteAction: (action: ExecuteActionRequest) => {
      context.objectSendClient(self, context.key)._execute(action);
    },
    dispatchEvent: (event: EventFrom<M>, delay?: number) => {
      context
        .objectSendClient(self, context.key)
        .send(event, restate.rpc.sendOpts({ delay }));
    },
  };
}

export function createMachineObject<P extends string, M extends AnyStateMachine>(
  name: P,
  machine: M,
  options?: MachineObjectOptions
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  return restate.object({
    name,
    handlers: {
      /**
       * Create a new instance of the machine
       *
       * @param context restate context
       * @param input input for the machine
       */
      create: async (context: restate.ObjectContext, input: InputFrom<M>) => {
        const [state, actions] = initialTransition(machine, input);

        context.set("state", state);

        const self = actionDispatcher(name, context);
        for (const action of actions) {
          dispatchAction(self, action);
        }
      },

      /**
       * Send an event to the machine
       *
       * @param context restate context
       * @param event input event for the machine
       */
      send: async (context: restate.ObjectContext, event: EventFrom<M>) => {
        const state: any = (await context.get("state")) ?? {};
        const snapshot = machine.resolveState(state) as SnapshotFrom<M>;
        const [nextState, actions] = transition(machine, snapshot, event);

        context.set("state", nextState);

        const self = actionDispatcher(name, context);
        for (const action of actions) {
          dispatchAction(self, action);
        }
      },

      /**
       * Execute an action that was emitted by the machine as part of
       * a transition. This is a shared handler so that actions can be executed
       * in parallel for a given machine instance.
       * Once the action completes (either successfully or with an error),
       * the result is sent back to the machine instance.
       *
       * @param context restate context
       * @param action the action to execute
       */
      _execute: restate.handlers.object.shared(
        { ingressPrivate: true, enableLazyState: true },
        async (
          context: restate.ObjectSharedContext,
          action: ExecuteActionRequest
        ) => {
          const result = await doExecuteAction(machine, action);
          const self = actionDispatcher(name, context);
          self.dispatchEvent(result);
        }
      ),
    },
    options: options,
  });
}



