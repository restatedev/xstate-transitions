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

import { setup, types } from "xstate";
import {
  createMachineObject,
  fromPromise,
} from "@restatedev/xstate-transitions";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

interface PaymentReceivedEvent {
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

export const workflow = setup({
  schemas: {
    events: {
      PaymentReceivedEvent: types<PaymentReceivedEvent>(),
    },
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
  },

  actorSources: {
    checkfunds: fromPromise(
      async ({
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
    ),
    sendSuccessEmail: fromPromise(
      async ({ input }: { input: { applicant: { name: string } | null } }) => {
        console.log({ input });
        console.log("Running sendSuccessEmail");
        console.log("sendSuccessEmail done");
      },
    ),
    sendInsufficientFundsEmail: fromPromise(
      async ({ input }: { input: { applicant: { name: string } | null } }) => {
        console.log({ input });
        console.log("Running sendInsufficientFundsEmail");
        console.log("sendInsufficientFundsEmail done");
      },
    ),
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
        PaymentReceivedEvent: ({ event }) => ({
          target: "PaymentReceived",
          context: {
            accountId: event.accountId,
            customer: event.customer,
            payment: event.payment,
            funds: event.funds,
          },
        }),
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
          target: "ConfirmBasedOnFunds",
          context: ({ output }) => ({ funds: output }),
        },
      },
    },
    ConfirmBasedOnFunds: {
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
    },
  },
});

export const payment = createMachineObject("payment", workflow, {
  journalRetention: { days: 1 },
});
