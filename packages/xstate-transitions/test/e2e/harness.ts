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

import type { AnyStateMachine } from "xstate";
import { describe } from "vitest";
import {
  createRestateTestActor,
  type RunMachineOptions,
  type RunningMachine,
} from "./runner";

/**
 * A machine-actor factory bound to a replay mode. Same shape as
 * {@link createRestateTestActor}, minus the `alwaysReplay` flag (the harness
 * supplies it). Bind `M` explicitly (e.g. `createActor<Snap, typeof machine>`)
 * when passing a runtime `contract`, so its event/input schemas typecheck
 * against the concrete machine.
 */
export type CreateActor = <
  SnapshotType,
  M extends AnyStateMachine = AnyStateMachine,
>(
  opts: Omit<RunMachineOptions<M>, "alwaysReplay">,
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
