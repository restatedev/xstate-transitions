import { createActor, toPromise } from "xstate";
import type { AnyActorLogic, AnyStateMachine } from "xstate";
import * as restate from "@restatedev/restate-sdk";
import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import {
  resolveReferencedActor,
  isRestatePromiseActor,
  normalizeError,
} from "../xstate/actors";
import type { NormalizedError } from "../xstate/actors";
import type { SpawnParams } from "../xstate/types";

/** Result of running actor logic, before translating it to XState's protocol. */
export type ActorOutcome =
  | { status: "done"; output?: unknown }
  | { status: "error"; error: NormalizedError };

/**
 * Run an invoked/spawned actor out-of-band and return a plain outcome. The
 * exclusive actorDone/actorError handlers translate it to XState's protocol.
 *
 * - Restate-aware promise actors run with the Restate ctx (ctx.run/date/rand);
 *   only TerminalError routes to onError, transient errors are rethrown so
 *   Restate retries this invocation.
 * - Vanilla actors run once via createActor+toPromise; any error routes to onError.
 */
export async function runActor(
  machine: AnyStateMachine,
  params: SpawnParams,
  ctx: ObjectSharedContext,
): Promise<ActorOutcome> {
  const logic =
    typeof params.src === "string"
      ? resolveReferencedActor(machine, params.src)
      : params.src;

  if (isRestatePromiseActor(logic)) {
    try {
      const output = await logic.config({ input: params.input, ctx });
      return { status: "done", output };
    } catch (err) {
      if (err instanceof restate.TerminalError) {
        return { status: "error", error: normalizeError(err) };
      }
      throw err;
    }
  }

  try {
    const output = await toPromise(
      createActor(logic as AnyActorLogic, params as never).start(),
    );
    return { status: "done", output };
  } catch (err) {
    return { status: "error", error: normalizeError(err) };
  }
}
