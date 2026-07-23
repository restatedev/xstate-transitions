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
 * Order workflow — a schemas-first example.
 *
 * XState v5 examples typically declare `types: {} as { ... }`. XState v6's
 * `setup({ schemas })` is a strict upgrade: `input`, `context`, and each event's
 * payload are declared once, and every transition below infers them precisely —
 * `event.quantity`, `output.reservationId`, and `context.*` are all fully typed
 * with no casts.
 *
 * It also shows the pieces you reach for in a real durable workflow:
 *   - `fromHandler` for a ctx-aware effect journaled with `ctx.run`;
 *   - `onDone` / `onError` branches from a single invoke;
 *   - a `final` state with `tags` and `output`, which `waitFor("hasTag:ready")`
 *     and the returned snapshot expose.
 *
 * This example uses real Zod schemas in `schemas`, so `createMachineObject`
 * derives the ingress serdes automatically — validating and coercing
 * `create`/`send` and publishing JSON Schemas to Restate discovery. (Type-only
 * `types<T>()` erases at runtime and yields no schema; see MANUAL.md, "Runtime
 * ingress validation".)
 */

import * as restate from "@restatedev/restate-sdk";
import { setup, types } from "xstate";
import { z } from "zod";
import { createMachineObject, fromHandler } from "@restatedev/xstate";

const OrderInput = z.object({
  sku: z.string(),
  quantity: z.number(),
});
type OrderInput = z.infer<typeof OrderInput>;

interface ReserveOutput {
  reservationId: string;
}

// A ctx-aware effect. `ctx.run` journals the result, so it executes exactly once
// even across retries and replays. A real implementation would call out to an
// inventory service here; we return a deterministic id to keep the demo hermetic.
const reserveInventory = fromHandler<ReserveOutput, OrderInput>(
  async ({ input, ctx }) =>
    ctx.run("reserve-inventory", async () => {
      if (input.quantity > 100) {
        throw new restate.TerminalError("Insufficient inventory");
      }
      return { reservationId: `res-${input.sku}-${input.quantity}` };
    }),
);

export const orderMachine = setup({
  schemas: {
    input: OrderInput,
    context: types<
      OrderInput & {
        reservationId: string | null;
        failure: { name: string; message: string } | null;
      }
    >(),
    events: {
      SUBMIT: z.object({}),
      CANCEL: z.object({}),
      // A typed payload: `event.quantity` is a `number` in the transition.
      ADJUST: z.object({ quantity: z.number() }),
    },
  },
  actorSources: {
    reserveInventory,
  },
}).createMachine({
  id: "order",
  initial: "draft",
  context: ({ input }) => ({
    ...input,
    reservationId: null,
    failure: null,
  }),
  states: {
    draft: {
      on: {
        SUBMIT: { target: "reserving" },
        CANCEL: { target: "cancelled" },
        ADJUST: ({ event }) => ({ context: { quantity: event.quantity } }),
      },
    },
    reserving: {
      invoke: {
        src: "reserveInventory",
        input: ({ context }) => ({
          sku: context.sku,
          quantity: context.quantity,
        }),
        onDone: {
          target: "confirmed",
          context: ({ output }) => ({ reservationId: output.reservationId }),
        },
        onError: {
          target: "failed",
          context: ({ event }) => ({
            failure: event.error as { name: string; message: string },
          }),
        },
      },
    },
    confirmed: {
      type: "final",
      tags: ["ready"],
      output: ({ context }) => ({ reservationId: context.reservationId }),
    },
    cancelled: { type: "final" },
    failed: {
      type: "final",
      output: ({ context }) => ({ failure: context.failure }),
    },
  },
});

export const orders = createMachineObject("orders", orderMachine, {
  journalRetention: { days: 7 },
  finalStateTTL: 30 * 24 * 60 * 60 * 1_000,
});
