import {
  createActor,
  toPromise,
  type AnyActorLogic,
  type AnyStateMachine,
} from "xstate";
import * as restate from "@restatedev/restate-sdk";
import type { ObjectSharedContext } from "@restatedev/restate-sdk";
import {
  resolveReferencedActor,
  isRestatePromiseActor,
  createDoneActorEvent,
  createErrorActorEvent,
} from "../xstate/actors";
import type { SpawnParams } from "../xstate/interpret";

/**
 * Run an invoked/spawned actor out-of-band and produce the done/error event to
 * feed back to the machine.
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
) {
  const logic =
    typeof params.src === "string"
      ? resolveReferencedActor(machine, params.src)
      : params.src;

  if (isRestatePromiseActor(logic)) {
    try {
      const output = await logic.config({ input: params.input, ctx });
      return createDoneActorEvent(params.id, output);
    } catch (err) {
      if (err instanceof restate.TerminalError) {
        return createErrorActorEvent(params.id, err);
      }
      throw err;
    }
  }

  try {
    const output = await toPromise(
      createActor(logic as AnyActorLogic, params as never).start(),
    );
    return createDoneActorEvent(params.id, output);
  } catch (err) {
    return createErrorActorEvent(params.id, err);
  }
}
