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

import * as clients from "@restatedev/restate-sdk-clients";
import {
  RestateContainer,
  RestateTestEnvironment,
} from "@restatedev/restate-sdk-testcontainers";
import type { AnyStateMachine } from "xstate";
import { type AnyEventObject } from "xstate";
import type { Condition, MachineVirtualObject } from "../../src";
import { createMachineObject, type MachineObjectOptions } from "../../src";

export type RunMachineOptions<M extends AnyStateMachine = AnyStateMachine> = {
  machine: M;
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

export async function createRestateTestActor<
  SnapshotType,
  M extends AnyStateMachine = AnyStateMachine,
>(opts: RunMachineOptions<M>): Promise<RunningMachine<SnapshotType>> {
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
    // This generic runner works with any machine, so it erases the client to a
    // loose test shape. (A real caller keeps its concrete machine type, whose
    // `EventFrom<M>` is precise; only `AnyStateMachine` erases the event type to
    // `never` under v6.)
    const client = rs.objectClient<MachineVirtualObject<AnyStateMachine>>(
      { name: "default" },
      opts.key ?? "default",
    ) as unknown as {
      create: (input: object) => Promise<void>;
      send: (event: AnyEventObject) => Promise<void>;
      snapshot: () => Promise<unknown>;
      waitFor: (req: {
        condition: Condition;
        event?: AnyEventObject;
        timeout?: number;
      }) => Promise<unknown>;
    };
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
