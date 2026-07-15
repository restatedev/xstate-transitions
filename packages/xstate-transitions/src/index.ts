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

// Public API
export { createMachineObject } from "./restate/object";
export { fromHandler, fromPromise } from "./restate/promise";
export type {
  FromPromiseOptions,
  HandlerCreator,
  PromiseCreator,
  RetryPolicy,
} from "./restate/promise";
export type {
  MachineObjectOptions,
  MachineVirtualObject,
  StandardSchema,
  SubscribeRequest,
  WaitForRequest,
} from "./restate/types";
export type { Condition, ReturnedSnapshot, StoredState } from "./xstate/types";
