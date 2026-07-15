import * as restate from "@restatedev/restate-sdk";
import type { AnyStateMachine } from "xstate";
import { buildRegistry } from "../../xstate/registry";
import { selfDef } from "../effects";
import type { MachineDefinition } from "../types";

/** Immutable dependencies shared by every handler in one object definition. */
export interface MachineObjectRuntime<
  M extends AnyStateMachine = AnyStateMachine,
> {
  readonly rootMachine: M;
  readonly registry: ReadonlyMap<string, AnyStateMachine>;
  readonly self: MachineDefinition;
  readonly finalStateTTL: number | undefined;
}

export function createMachineObjectRuntime<M extends AnyStateMachine>(
  name: string,
  rootMachine: M,
  finalStateTTL: number | undefined,
): MachineObjectRuntime<M> {
  return {
    rootMachine,
    registry: buildRegistry(rootMachine),
    self: selfDef(name),
    finalStateTTL,
  };
}

/** Resolve the machine definition persisted for a root or child instance. */
export function resolveMachine(
  runtime: MachineObjectRuntime,
  machineId: string | null,
): AnyStateMachine {
  if (machineId === null) return runtime.rootMachine;

  const machine = runtime.registry.get(machineId);
  if (machine !== undefined) return machine;

  throw new restate.TerminalError(
    `No machine with id "${machineId}" is registered for this object.`,
    { errorCode: 500 },
  );
}
