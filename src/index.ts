// Public API
export { createMachineObject } from "./restate/object";
export { fromPromise } from "./restate/promise";
export type { RestatePromiseCreator } from "./restate/promise";
export type {
  MachineObjectOptions,
  MachineVirtualObject,
  WaitForRequest,
  SubscribeRequest,
} from "./restate/types";
export type { StoredState, ReturnedSnapshot } from "./xstate/snapshot";
export type { Condition } from "./xstate/conditions";
