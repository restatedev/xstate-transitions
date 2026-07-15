/*
 * Copyright (c) 2023-2024 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import * as clients from "@restatedev/restate-sdk-clients";
import {
  RestateContainer,
  RestateTestEnvironment,
} from "@restatedev/restate-sdk-testcontainers";
import type { AnyStateMachine } from "xstate";
import { type AnyEventObject } from "xstate";
import type { Condition, MachineVirtualObject } from "../src";
import { createMachineObject, type MachineObjectOptions } from "../src";

export type RunMachineOptions = {
  machine: AnyStateMachine;
  key?: string;
  input?: unknown;
  options?: MachineObjectOptions;
  /**
   * Force restate-server to always replay at suspension points, surfacing any
   * non-determinism in the handlers. Set by the parameterized e2e harness.
   */
  alwaysReplay?: boolean;
};

export type RunningMachine<SnapshotType> = {
  create: (input?: unknown) => Promise<void>;
  send: (event: AnyEventObject) => Promise<void>;
  snapshot(): Promise<SnapshotType>;
  waitFor(
    condition: Condition,
    event?: AnyEventObject,
    timeout?: number,
  ): Promise<SnapshotType>;
  [Symbol.dispose](): void;
};

export async function createRestateTestActor<SnapshotType>(
  opts: RunMachineOptions,
): Promise<RunningMachine<SnapshotType>> {
  const obj = createMachineObject("default", opts.machine, opts.options);
  const env = await RestateTestEnvironment.start(
    { services: [obj], alwaysReplay: opts.alwaysReplay ?? false },
    () =>
      new RestateContainer().withEnvironment({
        RESTATE_DEFAULT_NUM_PARTITIONS: "2",
        RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: "64 MB",
        RESTATE_DISABLE_TELEMETRY: "true",
      }),
  );

  try {
    const rs = clients.connect({
      url: env.baseUrl(),
    });
    const client = rs.objectClient<MachineVirtualObject<AnyStateMachine>>(
      { name: "default" },
      opts.key ?? "default",
    );
    await client.create({ ...(opts.input ?? {}) });
    return {
      create: async (input?: unknown) => {
        return await client.create({ ...((input ?? {}) as object) });
      },
      send: async (event: AnyEventObject) => {
        return await client.send(event);
      },

      snapshot: async () => {
        return (await client.snapshot()) as SnapshotType;
      },

      waitFor: async (
        condition: Condition,
        event?: AnyEventObject,
        timeout?: number,
      ) => {
        return (await client.waitFor({
          condition,
          ...(event === undefined ? {} : { event }),
          ...(timeout === undefined ? {} : { timeout }),
        })) as SnapshotType;
      },

      [Symbol.dispose]: () => {
        env.stop().catch((err: unknown) => {
          console.error("Error stopping environment:", err);
        });
      },
    };
  } catch (error) {
    if (typeof env !== "undefined") {
      await env.stop();
    }
    throw error;
  }
}
