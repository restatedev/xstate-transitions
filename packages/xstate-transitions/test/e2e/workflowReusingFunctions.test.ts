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

import { it } from "vitest";
import {
  createAsyncLogic,
  createMachine,
  type SnapshotFrom,
  setup,
  types,
} from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

interface PaymentReceivedEvent {
  type: "PaymentReceivedEvent";
  accountId: string;
  payment: {
    amount: number;
  };
  customer: {
    name: string;
  };
  funds: {
    available: boolean;
  };
}

interface ConfirmationCompletedEvent {
  type: "ConfirmationCompletedEvent";
  payment: {
    amount: number;
  };
}

export const workflow = setup({
  schemas: {
    context: types<{
      payment: {
        amount: number;
      } | null;
      customer: {
        name: string;
      } | null;
      funds: {
        available: boolean;
      } | null;
      accountId: string | null;
    }>(),
    events: {
      PaymentReceivedEvent: types<Omit<PaymentReceivedEvent, "type">>(),
    },
  },

  actorSources: {
    checkfunds: createAsyncLogic({
      run: async ({
        input,
      }: {
        input: {
          account: string;
          paymentamount: number;
        };
      }) => {
        console.log("Running checkfunds");
        await delay(10);

        console.log("checkfunds done");

        return {
          available: input.paymentamount < 1000,
        };
      },
    }),
    sendSuccessEmail: createAsyncLogic({
      run: async ({
        input,
      }: {
        input: { applicant: { name: string } | null };
      }) => {
        console.log({ input });
        console.log("Running sendSuccessEmail");
        console.log("sendSuccessEmail done");
      },
    }),
    sendInsufficientFundsEmail: createAsyncLogic({
      run: async ({
        input,
      }: {
        input: { applicant: { name: string } | null };
      }) => {
        console.log({ input });
        console.log("Running sendInsufficientFundsEmail");
        console.log("sendInsufficientFundsEmail done");
      },
    }),
  },
}).createMachine({
  id: "paymentconfirmation",
  initial: "Pending",
  context: {
    customer: null,
    payment: null,
    funds: null,
    accountId: null,
  },
  states: {
    Pending: {
      on: {
        PaymentReceivedEvent: {
          context: ({ event }) => ({
            accountId: event.accountId,
            customer: event.customer,
            payment: event.payment,
            funds: event.funds,
          }),
          target: "PaymentReceived",
        },
      },
    },
    PaymentReceived: {
      invoke: {
        src: "checkfunds",
        input: ({ context }) => ({
          account: String(context.accountId),
          paymentamount: Number(context.payment?.amount),
        }),
        onDone: {
          context: ({ output }) => ({
            funds: output,
          }),
          target: "ConfirmBasedOnFunds",
        },
      },
    },
    ConfirmBasedOnFunds: {
      // inlined guard: fundsAvailable === !!context.funds?.available
      always: ({ context }) =>
        context.funds?.available
          ? { target: "SendPaymentSuccess" }
          : { target: "SendInsufficientResults" },
    },
    SendPaymentSuccess: {
      invoke: {
        src: "sendSuccessEmail",
        input: ({ context }) => ({
          applicant: context.customer,
        }),
        onDone: {
          target: "End",
        },
      },
    },
    SendInsufficientResults: {
      invoke: {
        src: "sendInsufficientFundsEmail",
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
      entry: ({ parent }, enq) => {
        enq.sendTo(parent, {
          type: "ConfirmationCompletedEvent",
          payment: { amount: 1337 },
        } satisfies ConfirmationCompletedEvent);
      },
    },
  },
});

const parentWorkflow = createMachine({
  id: "parent",
  schemas: {
    context: types<{ payment: { amount: number } | null }>(),
    events: {
      PaymentReceivedEvent: types<Omit<PaymentReceivedEvent, "type">>(),
      ConfirmationCompletedEvent:
        types<Omit<ConfirmationCompletedEvent, "type">>(),
    },
  },
  context: { payment: null },
  invoke: {
    id: "paymentconfirmation",
    src: workflow,
  },
  on: {
    PaymentReceivedEvent: ({ children, event }, enq) => {
      enq.sendTo(children.paymentconfirmation, event);
    },
    ConfirmationCompletedEvent: ({ event }) => ({
      context: {
        payment: event.payment,
      },
    }),
  },
});

describeE2E("Reusing functions workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using actor = await createActor<SnapshotFrom<typeof parentWorkflow>>({
      machine: parentWorkflow,
    });

    await actor.send({
      type: "PaymentReceivedEvent",
      accountId: "1234",
      payment: {
        amount: 100,
      },
      customer: {
        name: "John Doe",
      },
      funds: {
        available: true,
      },
    });

    await eventually(() => actor.snapshot()).toMatchObject({
      context: {
        payment: {
          amount: 1337,
        },
      },
    });
  });
});
