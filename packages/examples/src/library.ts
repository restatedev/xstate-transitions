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
 * Book lending workflow.
 *
 * Ported from xstate/examples/workflow-book-lending to this integration's
 * pure-transition XState v6 style. It is the "kitchen sink" example:
 *
 *   - strongly-typed events with payloads (`schemas.events`);
 *   - `always` guards that branch on context;
 *   - several durable async actors (`fromPromise`);
 *   - a nested compound state (`Check Out Book`) that completes to the top level;
 *   - a durable two-week `after` timer that Restate keeps for you.
 *
 * Upstream (XState v5): https://github.com/statelyai/xstate/tree/main/examples/workflow-book-lending
 */

import { setup, types } from "xstate";
import {
  createMachineObject,
  fromPromise,
} from "@restatedev/xstate-transitions";

interface Lender {
  name: string;
  address: string;
  phone: string;
}

type BookStatus = "onloan" | "available" | "unknown";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Two weeks. Inlined because named delays are not a v6 setup key; Restate holds
// the timer durably, so a fortnight-long sleep costs nothing while it waits.
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1_000;

export const bookLendingMachine = setup({
  schemas: {
    context: types<{
      book: { title: string; id: string; status: BookStatus } | null;
      lender: Lender | null;
    }>(),
    events: {
      bookLendingRequest: types<{
        book: { title: string; id: string };
        lender: Lender;
      }>(),
      holdBook: types<Record<string, never>>(),
      declineBookhold: types<Record<string, never>>(),
    },
  },
  actorSources: {
    getBookStatus: fromPromise(
      async ({ input }: { input: { bookId: string } }) => {
        console.log("Getting status for book", input.bookId);
        await delay(1000);
        return { status: "available" as Exclude<BookStatus, "unknown"> };
      },
    ),
    sendStatusToLender: fromPromise(
      async ({ input }: { input: { bookId: string; message: string } }) => {
        console.log("Sending status to lender", input);
        await delay(1000);
      },
    ),
    requestHold: fromPromise(
      async ({
        input,
      }: {
        input: { bookId: string; lender: Lender | null };
      }) => {
        console.log("Requesting hold for lender", input);
        await delay(1000);
      },
    ),
    cancelHold: fromPromise(
      async ({
        input,
      }: {
        input: { bookId: string; lender: Lender | null };
      }) => {
        console.log("Cancelling hold request for lender", input);
        await delay(1000);
      },
    ),
    checkOutBook: fromPromise(
      async ({ input }: { input: { bookId: string } }) => {
        console.log("Checking out book", input.bookId);
        await delay(1000);
      },
    ),
    notifyLender: fromPromise(
      async ({
        input,
      }: {
        input: { bookId: string; lender: Lender | null };
      }) => {
        console.log("Notifying lender of checkout", input);
        await delay(1000);
      },
    ),
  },
}).createMachine({
  id: "book-lending",
  context: { book: null, lender: null },
  initial: "Book Lending Request",
  states: {
    "Book Lending Request": {
      on: {
        bookLendingRequest: ({ event }) => ({
          target: "Get Book Status",
          context: {
            book: { ...event.book, status: "unknown" as const },
            lender: event.lender,
          },
        }),
      },
    },
    "Get Book Status": {
      invoke: {
        src: "getBookStatus",
        input: ({ context }) => ({ bookId: context.book?.id ?? "" }),
        onDone: {
          target: "Book Status Decision",
          context: ({ context, output }) => ({
            book: context.book && { ...context.book, status: output.status },
          }),
        },
      },
    },
    "Book Status Decision": {
      always: ({ context }) =>
        context.book?.status === "onloan"
          ? { target: "Report Status To Lender" }
          : context.book?.status === "available"
            ? { target: "Check Out Book" }
            : { target: "End" },
    },
    "Report Status To Lender": {
      invoke: {
        src: "sendStatusToLender",
        input: ({ context }) => ({
          bookId: context.book?.id ?? "",
          message: `Book ${context.book?.title ?? ""} is already on loan`,
        }),
        onDone: { target: "Wait For Lender Response" },
      },
    },
    "Wait For Lender Response": {
      on: {
        holdBook: { target: "Request Hold" },
        declineBookhold: { target: "Cancel Request" },
      },
    },
    "Request Hold": {
      invoke: {
        src: "requestHold",
        input: ({ context }) => ({
          bookId: context.book?.id ?? "",
          lender: context.lender,
        }),
        onDone: { target: "Sleep Two Weeks" },
      },
    },
    "Cancel Request": {
      invoke: {
        src: "cancelHold",
        input: ({ context }) => ({
          bookId: context.book?.id ?? "",
          lender: context.lender,
        }),
        onDone: { target: "End" },
      },
    },
    "Sleep Two Weeks": {
      // Recheck availability after the hold window. A durable Restate timer.
      after: {
        [TWO_WEEKS_MS]: { target: "Get Book Status" },
      },
    },
    "Check Out Book": {
      initial: "Checking Out Book",
      // When the nested flow reaches its final state, complete the whole machine.
      onDone: { target: "End" },
      states: {
        "Checking Out Book": {
          invoke: {
            src: "checkOutBook",
            input: ({ context }) => ({ bookId: context.book?.id ?? "" }),
            onDone: { target: "Notifying Lender" },
          },
        },
        "Notifying Lender": {
          invoke: {
            src: "notifyLender",
            input: ({ context }) => ({
              bookId: context.book?.id ?? "",
              lender: context.lender,
            }),
            onDone: { target: "Checked Out" },
          },
        },
        "Checked Out": { type: "final" },
      },
    },
    End: { type: "final" },
  },
});

export const bookLending = createMachineObject("library", bookLendingMachine, {
  journalRetention: { days: 30 },
});
