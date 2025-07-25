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

import {
  RestateContainer,
  RestateTestEnvironment,
} from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import { AnyStateMachine, type AnyEventObject } from "xstate";
import { createMachineObject } from "../src/core";
import { MachineVirtualObject } from "../src/types";

export type RunMachineOptions = {
  machine: AnyStateMachine;
  machines?: AnyStateMachine[];
  key?: string;
  input?: unknown;
};

export type RunningMachine<SnapshotType> = {
  send: (event: AnyEventObject) => Promise<void>;
  snapshot(): Promise<SnapshotType>;
  [Symbol.dispose](): void;
};

export async function createRestateTestActor<SnapshotType>(
  opts: RunMachineOptions
): Promise<RunningMachine<SnapshotType>> {
  const env = await RestateTestEnvironment.start(
    (restateServer) => {
      const obj = createMachineObject("default", opts.machine, {
        machines: opts.machines || [opts.machine],
      });
      restateServer.bind(obj);
    },
    () =>
      new RestateContainer().withEnvironment({
        RESTATE_DEFAULT_NUM_PARTITIONS: "2",
        RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE: "64 MB",
        RESTATE_DISABLE_TELEMETRY: "true",
      })
  );

  try {
    const rs = clients.connect({
      url: env.baseUrl(),
    });
    const client = rs.objectClient<MachineVirtualObject<AnyStateMachine>>(
      { name: "default" },
      opts.key ?? "default"
    );
    await client.create({
      input: { ...(opts.input ?? {}) },
      machineId: opts.machine.id,
    });
    return {
      send: async (event: AnyEventObject) => {
        return await client.send({ event, machineId: opts.machine.id });
      },

      snapshot: async () => {
        return (await client.snapshot()) as SnapshotType;
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
