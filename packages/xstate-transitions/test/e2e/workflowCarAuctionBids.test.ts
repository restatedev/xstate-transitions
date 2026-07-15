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
import { createMachine, type SnapshotFrom, types } from "xstate";
import { eventually } from "./eventually.js";
import { describeE2E } from "./harness";

interface Bid {
  carid: string;
  amount: number;
  bidder: {
    id: string;
    firstName: string;
    lastName: string;
  };
}

// https://github.com/serverlessworkflow/specification/tree/main/examples#handle-car-auction-bids-example
export const workflow = createMachine({
  id: "handleCarAuctionBid",
  description: "Store a single bid whole the car auction is active",
  initial: "StoreCarAuctionBid",
  schemas: {
    context: types<{
      bids: Bid[];
    }>(),
    events: {
      CarBidEvent: types<{
        bid: Bid;
      }>(),
    },
  },
  context: {
    bids: [],
  },
  states: {
    StoreCarAuctionBid: {
      on: {
        CarBidEvent: ({ context, event }) => ({
          context: {
            bids: [...context.bids, event.bid],
          },
        }),
      },
      after: {
        3000: { target: "BiddingEnded" },
      },
    },
    BiddingEnded: {
      type: "final",
    },
  },
  output: ({ context }) => ({
    // highest bid
    winningBid: context.bids.reduce((prev, current) =>
      prev.amount > current.amount ? prev : current,
    ),
  }),
});

describeE2E("A car auction bidding workflow", (createActor) => {
  it("Will complete successfully", { timeout: 60_000 }, async () => {
    using actor = await createActor<SnapshotFrom<typeof workflow>>({
      machine: workflow,
    });

    await actor.send({
      type: "CarBidEvent",
      bid: {
        carid: "car123",
        amount: 3000,
        bidder: {
          id: "xyz",
          firstName: "John",
          lastName: "Wayne",
        },
      },
    });

    await actor.send({
      type: "CarBidEvent",
      bid: {
        carid: "car123",
        amount: 4000,
        bidder: {
          id: "abc",
          firstName: "Jane",
          lastName: "Doe",
        },
      },
    });

    await eventually(() => actor.snapshot()).toMatchObject({
      status: "done",
      value: "BiddingEnded",
      // TODO: figure out why output is not available in the snapshot
      output: {
        winningBid: {
          carid: "car123",
          amount: 4000,
          bidder: {
            id: "abc",
            firstName: "Jane",
            lastName: "Doe",
          },
        },
      },
    });
  });
});
