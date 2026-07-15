import * as restate from "@restatedev/restate-sdk";
import type { AnyStateMachine, EventFrom, InputFrom } from "xstate";
import type {
  MachineContract,
  MachineObjectOptions,
  MachineVirtualObject,
  StandardSchema,
} from "../types";
import {
  cleanupState,
  executeActor,
  getSnapshot,
  handleActorDone,
  handleActorError,
  handleScheduledEvent,
  sendPublicEvent,
  subscribe,
  waitFor,
} from "./handlers";
import {
  createMachineObjectRuntime,
  type MachineObjectRuntime,
} from "./runtime";
import { applyEvent, initializeChild, initializeRoot } from "./transitions";
import { validateFinalStateTTL } from "./validation";

const PRIVATE_HANDLER = { ingressPrivate: true } as const;
const PRIVATE_LAZY_HANDLER = {
  ingressPrivate: true,
  enableLazyState: true,
} as const;

/**
 * Turn an XState machine into a Restate virtual object.
 *
 * Each object key is one durable machine instance whose state is the persisted
 * snapshot. Handlers drive the machine through pure initial/resume functions,
 * record their results for replay, and execute the resulting effects through
 * Restate.
 *
 * Public handlers:
 * - `create(input)` starts a new instance from its initial transition.
 * - `send(event)` applies an event and returns after the macrostep is persisted.
 * - `snapshot()` reads the current serializable snapshot.
 * - `subscribe(request)` resolves an awakeable when a condition is met.
 * - `waitFor(request)` provides awakeable-backed long polling.
 *
 * Internal ingress-private handlers carry child initialization, actor results,
 * machine messages, delayed events, promise execution, and state cleanup.
 *
 * @param name The virtual object service name.
 * @param machine The root machine and entry point to its reachable child graph.
 * @param options Restate options, runtime contracts, and optional final-state
 * cleanup TTL.
 * @returns A Restate virtual object definition ready to bind to an endpoint.
 */
export function createMachineObject<
  P extends string,
  M extends AnyStateMachine,
>(
  name: P,
  machine: M,
  options?: MachineObjectOptions<M>,
): restate.VirtualObjectDefinition<P, MachineVirtualObject<M>> {
  const { finalStateTTL, contract, ...objectOptions } = options ?? {};
  const runtime = createMachineObjectRuntime(name, machine, finalStateTTL);
  validateFinalStateTTL(finalStateTTL);

  return restate.object({
    name,
    handlers: createHandlers(runtime, contract),
    options: objectOptions,
  });
}

function createHandlers<M extends AnyStateMachine>(
  runtime: MachineObjectRuntime<M>,
  contract: MachineContract<M> | undefined,
): MachineVirtualObject<M> {
  return {
    create: createRootHandler(runtime, contract?.input),
    initChild: restate.createObjectHandler(
      PRIVATE_HANDLER,
      initializeChild.bind(undefined, runtime),
    ),
    send: createSendHandler(runtime, contract?.event),
    deliverEvent: restate.createObjectHandler(
      PRIVATE_HANDLER,
      applyEvent.bind(undefined, runtime),
    ),
    actorDone: restate.createObjectHandler(
      PRIVATE_HANDLER,
      handleActorDone.bind(undefined, runtime),
    ),
    actorError: restate.createObjectHandler(
      PRIVATE_HANDLER,
      handleActorError.bind(undefined, runtime),
    ),
    deliverScheduled: restate.createObjectHandler(
      PRIVATE_HANDLER,
      handleScheduledEvent.bind(undefined, runtime),
    ),
    executeActor: restate.createObjectSharedHandler(
      PRIVATE_LAZY_HANDLER,
      executeActor.bind(undefined, runtime),
    ),
    snapshot: getSnapshot.bind(undefined, runtime),
    subscribe: subscribe.bind(undefined, runtime),
    waitFor: restate.createObjectSharedHandler(
      waitFor.bind(undefined, runtime, contract?.event),
    ),
    cleanupState: restate.createObjectHandler(PRIVATE_HANDLER, cleanupState),
  };
}

function createRootHandler<M extends AnyStateMachine>(
  runtime: MachineObjectRuntime<M>,
  schema: StandardSchema<InputFrom<M>> | undefined,
): MachineVirtualObject<M>["create"] {
  const handler = initializeRoot.bind(undefined, runtime);
  return schema
    ? restate.createObjectHandler(
        { input: restate.serde.schema(schema) },
        handler,
      )
    : handler;
}

function createSendHandler<M extends AnyStateMachine>(
  runtime: MachineObjectRuntime<M>,
  schema: StandardSchema<EventFrom<M>> | undefined,
): MachineVirtualObject<M>["send"] {
  const handler = sendPublicEvent.bind(undefined, runtime);
  return schema
    ? restate.createObjectHandler(
        { input: restate.serde.schema(schema) },
        handler,
      )
    : handler;
}
