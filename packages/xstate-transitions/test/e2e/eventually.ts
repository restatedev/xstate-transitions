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

import { expect } from "vitest";

export function eventually<T>(fn: () => T): ReturnType<typeof expect.poll<T>> {
  return expect.poll<T>(fn, {
    timeout: 30000,
    interval: 250,
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
