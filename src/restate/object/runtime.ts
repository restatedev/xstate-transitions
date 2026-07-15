import * as restate from "@restatedev/restate-sdk";
import type { AnyStateMachine } from "xstate";
import { buildRegistry } from "../../xstate/registry";
import { selfDef } from "../effects";
import type { MachineDefinition } from "../types";

/** Immutable dependencies shared by every handler in one object definition. */
export class MachineRuntime<M extends AnyStateMachine = AnyStateMachine> {
  readonly rootMachine: M;
  readonly self: MachineDefinition;
  readonly finalStateTTL: number | undefined;
  private readonly registry: ReadonlyMap<string, AnyStateMachine>;

  constructor(name: string, rootMachine: M, finalStateTTL: number | undefined) {
    this.rootMachine = rootMachine;
    this.registry = buildRegistry(rootMachine);
    this.self = selfDef(name);
    this.finalStateTTL = finalStateTTL;
  }

  /** Resolve the machine persisted for a root or child instance. */
  resolveMachine(machineId: string | null): AnyStateMachine {
    if (machineId === null) return this.rootMachine;

    const machine = this.registry.get(machineId);
    if (machine !== undefined) return machine;

    throw new restate.TerminalError(
      `No machine with id "${machineId}" is registered for this object.`,
      { errorCode: 500 },
    );
  }
}
