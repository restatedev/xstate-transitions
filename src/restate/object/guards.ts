import * as restate from "@restatedev/restate-sdk";
import type { StoredState } from "../../xstate/types";
import { getState, isDisposed } from "../state";

/** Reject (410) once an instance has been disposed after its final state. */
export async function validateNotDisposed(
  context: restate.ObjectSharedContext,
): Promise<void> {
  if (await isDisposed(context)) {
    throw new restate.TerminalError(
      "The state machine has been disposed after reaching it's final state",
      { errorCode: 410 },
    );
  }
}

/** Reject (404) when a handler is called before `create`. */
export async function getRequiredState(
  context: restate.ObjectSharedContext,
): Promise<StoredState> {
  const stored = await getState(context);
  if (stored !== null) return stored;

  throw new restate.TerminalError(
    "No state machine found for this workflow ID. Call 'create' first.",
    { errorCode: 404 },
  );
}
