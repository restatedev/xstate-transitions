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
 * Car auction workflow.
 *
 * Ported from xstate/examples/workflow-car-auction-bids to this integration's
 * pure-transition XState v6 style. It highlights two durable primitives:
 *
 *   - a strongly-typed event (`CarBidEvent`) whose payload is inferred inside
 *     the transition via `schemas.events`; and
 *   - a durable `after` timer that closes the auction. Restate owns the clock,
 *     so the Node.js process does not need to stay alive while bidding is open.
 *
 * Upstream (XState v5): https://github.com/statelyai/xstate/tree/main/examples/workflow-car-auction-bids
 */

import { setup, types } from "xstate";
import { z } from "zod";
import { createMachineObject } from "@restatedev/xstate";

const Bid = z.object({
  carId: z.string(),
  amount: z.number(),
  bidder: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
  }),
});
type Bid = z.infer<typeof Bid>;

// How long the auction accepts bids. In production this would be minutes or
// hours; the value is inlined because named delays are not a v6 setup key.
const BIDDING_WINDOW_MS = 3_000;

export const auctionMachine = setup({
  schemas: {
    context: types<{ bids: Bid[] }>(),
    events: {
      // The payload carried by every `CarBidEvent`. A real Zod schema here makes
      // the event validate at ingress and surface its JSON Schema in discovery.
      CarBidEvent: z.object({ bid: Bid }),
    },
  },
}).createMachine({
  id: "auction",
  description:
    "Collect bids while the car auction is open, then pick a winner.",
  context: { bids: [] },
  initial: "Open",
  states: {
    Open: {
      on: {
        // Internal transition (no `target`): append the bid and stay Open.
        // Transitions must be pure, so this returns a fresh array.
        CarBidEvent: ({ context, event }) => ({
          context: { bids: [...context.bids, event.bid] },
        }),
      },
      after: {
        [BIDDING_WINDOW_MS]: { target: "Closed" },
      },
    },
    Closed: {
      type: "final",
      output: ({ context }) => ({
        winningBid: context.bids.reduce<Bid | null>(
          (best, bid) =>
            best === null || bid.amount > best.amount ? bid : best,
          null,
        ),
      }),
    },
  },
});

export const auction = createMachineObject("auction", auctionMachine, {
  journalRetention: { days: 1 },
});
