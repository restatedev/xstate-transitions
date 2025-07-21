import assert from "assert";
import {
  AnyStateMachine,
  fromPromise,
  initialTransition,
  transition,
  setup,
  ExecutableActionsFrom,
  EventFrom,
  ExecutableSpawnAction,
  createActor,
  toPromise,
  InvokeConfig,
  DoneActorEvent,
  InputFrom,
  assign,
  ErrorActorEvent,
} from "xstate";


import * as restate from "@restatedev/restate-sdk";
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

export function createDoneActorEvent(
  invokeId: string,
  output?: unknown
): DoneActorEvent {
  return {
    type: `xstate.done.actor.${invokeId}`,
    output,
    actorId: invokeId,
  };
}

export function createErrorActorEvent(
  invokeId: string,
  error: unknown
): ErrorActorEvent {
  return {
    type: `xstate.error.actor.${invokeId}`,
    error,
    actorId: invokeId,
  };
}

async function sleep(arg0: number) {
  await new Promise((resolve) => setTimeout(resolve, arg0));
}

export type ExecuteActionRequest = {
  params: ExecutableSpawnAction['params'];
};

async function execute(
  context: restate.ObjectContext,
  action: ExecutableActionsFrom<typeof machine>
) {
  console.log("Executing action", action);
  switch (action.type) {
    case "xstate.spawnChild": {
      const spawnAction = action as ExecutableSpawnAction;
      context.objectSendClient(workflow, context.key).execute({
        params: spawnAction.params,
      });
      break;
    }
    case "xstate.raise": {
      if (action.params.delay) {
        context
          .objectSendClient(workflow, context.key)
          .send(
            action.params.event,
            restate.rpc.sendOpts({ delay: action.params.delay })
          );
      } else {
        // TODO:
      }
      break;
    }
    default: {
      break;
    }
  }
}

export function resolveReferencedActor(machine: AnyStateMachine, src: string) {
  const match = src.match(/^xstate\.invoke\.(\d+)\.(.*)/)!;
  if (!match) {
    return machine.implementations.actors[src];
  }
  const [, indexStr, nodeId] = match;
  const node = machine.getStateNodeById(nodeId);
  const invokeConfig = node.config.invoke!;
  return (
    Array.isArray(invokeConfig)
      ? invokeConfig[indexStr as any]
      : (invokeConfig as InvokeConfig<
          any,
          any,
          any,
          any,
          any,
          any,
          any, // TEmitted
          any // TMeta
        >)
  ).src;
}

export const create = async (
  restate: restate.ObjectContext,
  input: InputFrom<typeof machine>
) => {
  const [state, actions] = initialTransition(machine, input);

  restate.set("state", state);

  for (const action of actions) {
    await execute(restate, action);
  }
};

export const send = async (
  restate: restate.ObjectContext,
  event: EventFrom<typeof machine>
) => {
  const state: any = (await restate.get("state")) ?? {};
  const [nextState, actions] = transition(
    machine,
    machine.resolveState(state),
    event
  );

  restate.set("state", nextState);

  for (const action of actions) {
    await execute(restate, action);
  }
};

/**
 * Internal function to execute an action in the context of a shared restate object.
 */
export const executeAction = async (
  restate: restate.ObjectSharedContext,
  action: ExecuteActionRequest
) => {
  const params = action.params;
  const logic =
    typeof params.src === "string"
      ? resolveReferencedActor(machine, params.src)
      : params.src;

  assert("transition" in logic);
  let event;
  try {
  const output = await toPromise(createActor(logic, params).start());
   event = createDoneActorEvent(params.id, output);
  } catch (err) {
    event = createErrorActorEvent(params.id, err);
  }
  restate.objectSendClient(workflow, restate.key).send(event);
  
};

export const workflow = restate.object({
  name: "workflow",
  handlers: {
    create,
    send,
    execute: restate.handlers.object.shared(
      { ingressPrivate: true, enableLazyState: true },
      executeAction
    ),
  },
  options: {
    journalRetention: { days: 1 },
  },
});

restate.endpoint().bind(workflow).listen();
