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
 * The example service. Every example machine is a durable Restate virtual
 * object; this entrypoint binds them all to one endpoint. Each object is
 * reachable at /{name}/{key}/{handler} — e.g. /orders/order-123/create.
 *
 * Run it with `pnpm dev`, then register http://localhost:9080 in the Restate UI.
 */

import * as restate from "@restatedev/restate-sdk";
import { payment } from "./example";
import { greeting } from "./greeting";
import { auction } from "./auction";
import { bookLending } from "./library";
import { orders } from "./orders";

restate
  .endpoint()
  .bind(payment)
  .bind(greeting)
  .bind(auction)
  .bind(bookLending)
  .bind(orders)
  .listen();
