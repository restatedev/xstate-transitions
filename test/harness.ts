import { describe } from "vitest";
import {
  createRestateTestActor,
  type RunMachineOptions,
  type RunningMachine,
} from "./runner";

/**
 * A machine-actor factory bound to a replay mode. Same shape as
 * {@link createRestateTestActor}, minus the `alwaysReplay` flag (the harness
 * supplies it).
 */
export type CreateActor = <SnapshotType>(
  opts: Omit<RunMachineOptions, "alwaysReplay">,
) => Promise<RunningMachine<SnapshotType>>;

const REPLAY_MODES = [
  { label: "normal", alwaysReplay: false },
  { label: "alwaysReplay", alwaysReplay: true },
] as const;

/**
 * Define an end-to-end test group that runs twice against a real Restate
 * container: once normally, then with `alwaysReplay` enabled to surface any
 * non-determinism in the handlers. The body receives a `createActor` factory
 * already bound to the current mode.
 */
export function describeE2E(
  title: string,
  body: (createActor: CreateActor) => void,
): void {
  describe.each(REPLAY_MODES)(`${title} [$label]`, ({ alwaysReplay }) => {
    const createActor: CreateActor = (opts) =>
      createRestateTestActor({ ...opts, alwaysReplay });
    body(createActor);
  });
}
