// Public API
export { createMachineObject } from "./restate/object";
export { fromPromise } from "./restate/promise";
export type { RestatePromiseCreator } from "./restate/promise";
export type {
  MachineObjectOptions,
  MachineContract,
  MachineVirtualObject,
  StandardSchema,
  WaitForRequest,
  SubscribeRequest,
} from "./restate/types";
export type { StoredState, ReturnedSnapshot, Condition } from "./xstate/types";
