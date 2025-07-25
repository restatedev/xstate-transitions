import type { AnyStateMachine } from "xstate";
import * as restate from "@restatedev/restate-sdk";

export function machineStateKey(machineId: string) {
  return `state-${machineId}`;
}

export function actorKey(actorId: string) {
  return `actor-${actorId}`;
}

export function resolveMachine(
  machineId?: string,
  machines?: AnyStateMachine[]
) {
  const match = machineId?.match(/^xstate\.invoke\.(\d+)\.(.*)/)!;
  const resolvedMachine = machines?.find(
    ({ id }) => id === machineId || id === match?.[2]
  );
  if (!resolvedMachine) {
    throw new restate.TerminalError(
      "Please provide the machine for " + String(machineId)
    );
  }
  return resolvedMachine;
}
