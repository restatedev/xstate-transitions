# XState + Restate Integration Manual

This manual explains how to run XState v5 machines as durable Restate virtual
objects. The first half is a user guide; the second half describes the
implementation, durability model, and testing strategy.

> [!IMPORTANT]
> This repository is currently an experiment rather than a published package.
> Its integration layer also depends on XState internals and therefore pins
> XState to `5.32.4`. Treat an XState upgrade as an integration change that
> requires the full test suite.

## Contents

- [Part I: User guide](#part-i-user-guide)
  - [The mental model](#the-mental-model)
  - [Quick start](#quick-start)
  - [Calling a machine](#calling-a-machine)
  - [Modeling durable workflows](#modeling-durable-workflows)
  - [Promise actors and external effects](#promise-actors-and-external-effects)
  - [Delays and cancellation](#delays-and-cancellation)
  - [Waiting for progress](#waiting-for-progress)
  - [Child machines and messaging](#child-machines-and-messaging)
  - [Snapshots, creation, and disposal](#snapshots-creation-and-disposal)
  - [Supported features and limitations](#supported-features-and-limitations)
  - [Testing applications](#testing-applications)
  - [Troubleshooting](#troubleshooting)
- [Part II: Implementation guide](#part-ii-implementation-guide)
  - [Architecture](#architecture)
  - [The pure transition core](#the-pure-transition-core)
  - [Handler and commit lifecycle](#handler-and-commit-lifecycle)
  - [Persisted representation](#persisted-representation)
  - [Effect execution](#effect-execution)
  - [Promise actor execution](#promise-actor-execution)
  - [Child-machine execution](#child-machine-execution)
  - [Delayed delivery and cancellation](#delayed-delivery-and-cancellation)
  - [Waiting and subscriptions](#waiting-and-subscriptions)
  - [Replay and determinism](#replay-and-determinism)
  - [Source map](#source-map)
  - [Contributor test strategy](#contributor-test-strategy)
- [Appendix A: API reference](#appendix-a-api-reference)
- [Appendix B: Durable state keys](#appendix-b-durable-state-keys)
- [Appendix C: Error reference](#appendix-c-error-reference)

# Part I: User guide

## The mental model

`createMachineObject(name, machine)` turns an XState machine definition into a
Restate virtual object definition. Each virtual-object key identifies one
durable instance of that machine:

```text
service name: orders
object key:   order-123
instance:     one persisted execution of the order machine
```

The machine is not kept alive as an in-memory XState actor. For each call, the
integration:

1. loads a serializable machine snapshot from Restate state;
2. rehydrates it into an XState snapshot;
3. computes one XState macrostep without performing external effects;
4. persists the new snapshot; and
5. translates supported XState actions into Restate operations.

This makes the process stateless between requests while Restate owns durable
state, message delivery, retries, delays, and recovery.

## Quick start

The repository currently exposes the integration from [`src/index.ts`](src/index.ts).
The examples below therefore import from `./src`; replace that path with your
package entrypoint if you package the integration.

Define a fully typed machine and use the integration's Restate-aware
`fromPromise` for external work:

```ts
import * as restate from "@restatedev/restate-sdk";
import { assign, setup } from "xstate";
import { createMachineObject, fromPromise } from "./src";

interface OrderInput {
  sku: string;
  quantity: number;
}

interface OrderContext extends OrderInput {
  reservationId?: string;
  failure?: { name: string; message: string };
}

type OrderEvent = { type: "SUBMIT" } | { type: "CANCEL" };

interface ReserveInput {
  sku: string;
  quantity: number;
}

interface ReserveOutput {
  reservationId: string;
}

const reserveInventory = fromPromise<ReserveOutput, ReserveInput>(
  async ({ input, ctx }) =>
    ctx.run("reserve-inventory", async () => {
      const response = await fetch("https://inventory.example/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });

      if (response.status === 409) {
        throw new restate.TerminalError("Inventory is unavailable");
      }
      if (!response.ok) {
        throw new Error(`Inventory service returned ${response.status}`);
      }

      return (await response.json()) as ReserveOutput;
    }),
);

export const orderMachine = setup({
  types: {
    input: {} as OrderInput,
    context: {} as OrderContext,
    events: {} as OrderEvent,
  },
  actors: {
    reserveInventory,
  },
}).createMachine({
  id: "order-v1",
  initial: "draft",
  context: ({ input }) => ({ ...input }),
  states: {
    draft: {
      on: {
        SUBMIT: "reserving",
        CANCEL: "cancelled",
      },
    },
    reserving: {
      invoke: {
        id: "reservation",
        src: "reserveInventory",
        input: ({ context }) => ({
          sku: context.sku,
          quantity: context.quantity,
        }),
        onDone: {
          target: "confirmed",
          actions: assign({
            reservationId: ({ event }) => event.output.reservationId,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            failure: ({ event }) =>
              event.error as { name: string; message: string },
          }),
        },
      },
    },
    confirmed: {
      type: "final",
      tags: ["ready"],
    },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

const orders = createMachineObject("orders", orderMachine, {
  journalRetention: { days: 7 },
  finalStateTTL: 30 * 24 * 60 * 60 * 1_000,
});

restate.endpoint().bind(orders).listen();
```

The important import distinction is:

```ts
// Durable external effects: receives Restate ctx.
import { fromPromise } from "./src";

// Ordinary XState promise actor: no Restate ctx.
import { fromPromise } from "xstate";
```

Prefer the integration's version whenever the actor performs I/O or needs
Restate's durable primitives.

To run the included example locally:

```sh
pnpm install
pnpm dev
docker run --net host --add-host=host.docker.internal:host-gateway restatedev/restate:latest
```

Then register the deployment at `http://localhost:9080` in Restate's UI at
<http://localhost:9070>. Restate ingress is available at
`http://localhost:8080` with the default local configuration.

## Calling a machine

The public handler surface is `create`, `send`, `snapshot`, `waitFor`, and the
lower-level `subscribe` handler. The URL shape through Restate ingress is:

```text
/{service-name}/{object-key}/{handler-name}
```

For the `orders` object above:

```sh
# Create or reset this object key to the machine's initial state.
curl http://localhost:8080/orders/order-123/create \
  --json '{"sku":"ABC-42","quantity":2}'

# Deliver a typed machine event.
curl http://localhost:8080/orders/order-123/send \
  --json '{"type":"SUBMIT"}'

# Read the current serializable snapshot.
curl http://localhost:8080/orders/order-123/snapshot \
  --json '{}'

# Wait at most 30 seconds for a settled snapshot carrying the ready tag.
curl http://localhost:8080/orders/order-123/waitFor \
  --json '{"condition":"hasTag:ready","timeout":30000}'
```

You can also use a generated Restate client or the TypeScript SDK client. The
exported `MachineVirtualObject<typeof machine>` type describes the handler
surface, while `EventFrom` and `InputFrom` flow from the XState machine into
`send` and `create`.

`send` completes after the event's macrostep has been computed, persisted, and
its resulting effects have been dispatched. Invoked promise actors and child
machines continue asynchronously and report their results through later events.

## Modeling durable workflows

### Keep transition logic pure

Treat these parts of a machine as pure functions:

- context initializers;
- guards;
- `assign` expressions;
- event and actor-input mappers; and
- output expressions.

They should compute values, not perform network calls, write files, send email,
or mutate process-global state. Model external work as an invoked or spawned
promise actor instead.

Although the resulting `Step` is journaled for replay, pure and deterministic
transition logic remains easier to test, reason about, and migrate. Use
`ctx.date`, `ctx.rand`, or a `ctx.run` result inside a Restate-aware promise actor
when a workflow decision needs time, randomness, or I/O.

### Persist only serializable data

Context, events, actor input/output, errors, and machine output cross a durable
serialization boundary. Store plain data:

- objects, arrays, strings, numbers, booleans, and `null`;
- explicit identifiers instead of live service clients;
- timestamps instead of `Date` instances; and
- plain error data instead of relying on an `Error` prototype.

Do not store functions, class instances, sockets, database handles, or arbitrary
XState actor references in context. Actor references created by supported
`spawn` patterns are reconstructed only for routing; they are not general
serializable application data.

### Make illegal states hard to express

Use discriminated event unions and narrow context types. Give every machine a
stable, explicit, unique `id`. Use explicit invoke or spawn IDs when later
actions address or stop a child.

```ts
type PaymentEvent =
  { type: "AUTHORIZE"; amount: number } | { type: "DECLINE"; reason: string };
```

The root and every reachable child machine must have a unique machine `id`.
`createMachineObject` rejects distinct machine definitions that reuse an ID,
because persisted child records resolve their logic by that ID.

### Understand macrosteps

One call applies one external event and lets XState settle the complete
macrostep. Immediate `raise` events, `always` transitions, guards, and `assign`
actions settle before the snapshot is committed. Observers see the settled
snapshot, not every transient microstate visited inside it.

## Promise actors and external effects

### Restate-aware `fromPromise`

The integration's `fromPromise` creator receives:

```ts
{
  input: TInput;
  ctx: ObjectSharedContext;
}
```

Use `ctx.run` for non-Restate calls and use Restate-native clients directly from
`ctx` when calling other Restate services. Follow the Restate SDK's idempotency
guidance for any external system: a process can fail after the external system
accepts a request but before its result is durably recorded.

Its error behavior is deliberate:

| Actor outcome          | Integration behavior                                               |
| ---------------------- | ------------------------------------------------------------------ |
| Returns a value        | Sends `xstate.done.actor.<id>` with that output                    |
| Throws `TerminalError` | Sends `xstate.error.actor.<id>` and enters `onError` if configured |
| Throws another error   | Rethrows from the Restate handler so Restate can retry             |

Use a `TerminalError` for a permanent business or input failure that retrying
cannot fix. Throw an ordinary error for a transient operational failure.

### Vanilla XState `fromPromise`

Ordinary XState promise actors remain supported, but receive no Restate context.
Any rejection is normalized and immediately returned to the machine as an actor
error event; it is not treated as a retryable Restate handler failure.

That makes vanilla promise actors appropriate for self-contained asynchronous
computation. They are not the preferred boundary for durable external I/O.

### Concurrent actors

Multiple invokes emitted by the same transition are dispatched through a
shared internal Restate handler and may run concurrently. Each completion is
sent back as a separate event. The virtual object's exclusive `send` handler
serializes those result events and applies them one at a time.

Do not depend on completion order unless the state machine models that ordering
explicitly.

## Delays and cancellation

XState `after`, delayed `raise`, and delayed `sendTo` actions are translated to
Restate delayed calls. Restate owns the clock, so the Node.js process does not
need to remain alive while a timer is pending.

```ts
import { cancel, sendTo } from "xstate";

const machine = setup({
  // ...
}).createMachine({
  entry: sendTo(
    ({ self }) => self,
    { type: "REMIND" },
    { id: "reminder", delay: 60_000 },
  ),
  on: {
    FINISH: {
      actions: cancel("reminder"),
    },
  },
});
```

Cancellation removes the durable token for that ID. Restate may still deliver
the already queued internal call, but the integration compares its unique token
and turns a cancelled or superseded delivery into a no-op.

Useful details:

- an explicit delay of `0` is still scheduled;
- immediate `raise` is drained inside the current macrostep;
- delayed actions without an explicit ID receive a generated unique ID; and
- use an explicit ID when you need to cancel or replace a particular delivery.

To model a recurring timer, have the delivered event schedule its next delayed
self-event. Do not use `setInterval` or a callback actor.

## Waiting for progress

`waitFor` supports two condition forms:

```ts
type Condition = "done" | `hasTag:${string}`;
```

- `done` resolves when the machine's settled snapshot has status `done`.
- `hasTag:ready` resolves when the settled snapshot has the `ready` tag.

The request can contain a timeout and an event:

```ts
await client.waitFor({
  condition: "hasTag:ready",
  event: { type: "SUBMIT" },
  timeout: 30_000,
});
```

When an event is supplied, the integration registers the subscription before
sending the event. This ordering prevents a fast transition from satisfying the
condition before the waiter exists.

Conditions are checked against settled snapshots. A tag that is entered and
left within a single macrostep may not be observable. If the machine reaches
`done` without the requested tag, that tag condition rejects. An error snapshot
rejects every pending condition.

`subscribe` is the low-level building block for integrating an existing Restate
awakeable. Most callers should use `waitFor`, which creates and awaits the
awakeable for them.

A timed-out waiter is not currently removed from the durable subscription map
immediately. Its entry is removed when the condition is later decided or the
instance is reset. Prefer bounded waits, and account for this behavior when a
condition may remain pending indefinitely.

## Child machines and messaging

An invoked or spawned state machine runs as a separate instance of the same
Restate virtual object definition. Its key is derived from the parent:

```text
parent key: order-123
child id:   payment
child key:  order-123::payment
```

Nested children extend the same pattern. The integration discovers child
machine definitions recursively from `setup({ actors })` and direct
`invoke.src` references.

Supported routing includes:

- `sendTo(self, event)` for self-messaging;
- `sendTo(child, event)` for a known child;
- `forwardTo(child)`;
- `sendParent(event)` from a child; and
- delayed `sendTo` for supported targets.

When an invoked child reaches `done` or `error`, it reports the appropriate
XState actor event to its parent exactly once. Exiting an invoke stops and
disposes its child instance. Re-entering it starts a fresh child under the same
derived key.

Choose child IDs as stable workflow-local identities. If two logical children
need independent lifecycles, they need distinct IDs.

## Snapshots, creation, and disposal

### Returned snapshot

The `snapshot` and `waitFor` handlers return a plain serializable projection:

```ts
interface ReturnedSnapshot {
  value: unknown;
  context: unknown;
  status: "active" | "done" | "error" | "stopped";
  output?: unknown;
  error?: unknown;
  tags: string[];
}
```

Tags are materialized as a sorted array. XState methods, live state nodes, and
actor internals are not returned.

### Creation resets an instance

Calling `create(input)` initializes the root machine at that object key. Calling
`create` again is an intentional reset: it clears runtime bookkeeping and
replaces the machine snapshot with a new initial snapshot using the new input.
It is not a read-or-create no-op.

Use reset only after coordinating or quiescing the existing execution. Reset
does not revoke promise actors or delayed calls already in flight, and it does
not send cleanup calls to children whose routing records it clears. A late
result from the previous execution can therefore reach the newly initialized
machine if the old work is still active.

Calling `send`, `snapshot`, or `waitFor` before `create` fails with status 404.

### Final-state retention

By default, a completed snapshot remains available indefinitely. Configure
`finalStateTTL` in milliseconds to dispose it after completion:

```ts
createMachineObject("orders", orderMachine, {
  finalStateTTL: 24 * 60 * 60 * 1_000,
});
```

The TTL applies when `status === "done"`, including a machine that is final on
entry. It does not currently schedule cleanup for an `error` status. After
cleanup, public handlers fail with status 410. A later explicit `create` starts
a fresh instance and clears the disposed marker.

The value must be finite and non-negative. `0` requests immediate cleanup.

## Supported features and limitations

This table describes the behavior implemented and covered by tests in this
repository, not every feature available in XState itself.

| Pattern                                            | Status                 | Notes                                                  |
| -------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| Compound and parallel states                       | Supported              | One full macrostep is persisted per event              |
| Guards, `assign`, `always`, immediate `raise`      | Supported              | Resolved during pure transition computation            |
| Final output and tags                              | Supported              | Exposed in returned snapshots                          |
| Shallow and deep history                           | Supported              | State-node references are serialized as IDs            |
| Promise `invoke` and `spawn`                       | Supported              | Prefer the Restate-aware `fromPromise` for I/O         |
| Concurrent promise invokes                         | Supported              | Completion order is not guaranteed                     |
| Machine `invoke` and `spawn`                       | Supported              | Each child becomes its own keyed object instance       |
| `sendTo`, `forwardTo`, `sendParent`                | Supported targets only | Self, known child, and parent routing                  |
| `after`, delayed `raise`, delayed `sendTo`         | Supported              | Implemented with Restate delayed calls                 |
| `cancel(id)`                                       | Supported              | Uses a durable delivery token                          |
| `waitFor` and tags                                 | Integration feature    | Conditions are `done` and `hasTag:<tag>`               |
| Repeated `create`                                  | Reset with caveat      | Does not revoke in-flight work from the prior run      |
| Arbitrary executable XState actions                | **Not supported**      | Unknown/custom action effects are not executed         |
| Callback actors (`fromCallback`)                   | **Not supported**      | No long-lived in-process actor exists                  |
| Observable actors and other long-lived actor logic | Not guaranteed         | Only tested actor patterns should be relied upon       |
| Arbitrary actor-system addressing                  | **Not supported**      | Routing is limited to self, parent, and known children |

The custom-action limitation is especially important. A declaration such as
`actions: "sendEmail"` may type-check in XState, but this integration does not
execute that arbitrary action implementation. Put the operation in an invoked
or spawned promise actor so it becomes an explicit durable effect boundary.

Callback actors conflict with the stateless-between-requests architecture. For
push sources, either send events into the object from an external Restate
service or model polling/ticking as recurring delayed self-events.

## Testing applications

The design deliberately exposes a pure core and a thin Restate adapter. Use
both layers in application tests.

### 1. Test machine decisions as pure logic

Use XState's pure transition APIs or the integration's `initialStep` and
`resumeStep` functions internally to cover:

- every event/state decision table;
- guards and context updates;
- final output;
- emitted abstract effects; and
- snapshot JSON round-trips.

Pure tests should make up most of the suite because they are fast and isolate
modeling mistakes precisely.

### 2. Unit-test effect functions

Move business I/O behind small typed functions. Test the decision-free
function separately, then test the Restate-aware actor with a minimal fake
context where practical. At minimum, cover:

- success and output mapping;
- transient failure;
- `TerminalError` and `onError`;
- request idempotency behavior; and
- malformed responses from external dependencies.

### 3. Run the complete machine against Restate

The repository's E2E harness starts a real Restate testcontainer and creates a
typed object client. Each E2E suite runs twice:

- normal execution; and
- `alwaysReplay`, which forces replay at suspension points and exposes
  nondeterminism or incorrect journal use.

A representative test looks like:

```ts
import { expect, it } from "vitest";
import { describeE2E } from "./harness";

describeE2E("order workflow", (createActor) => {
  it("reserves and completes", async () => {
    using order = await createActor({
      machine: orderMachine,
      key: "order-123",
      input: { sku: "ABC-42", quantity: 2 },
    });

    await order.send({ type: "SUBMIT" });

    await expect(order.waitFor("done")).resolves.toMatchObject({
      status: "done",
      value: "confirmed",
    });
  });
});
```

Include E2E cases for the boundaries pure tests cannot prove:

- retry and terminal-error behavior;
- process/replay safety;
- concurrent actor completion;
- delayed delivery and cancellation;
- parent/child messaging and child re-entry;
- waiter registration races and timeouts;
- repeated `create`; and
- final-state cleanup.

### Repository commands

```sh
# Fast pure/unit suite; no Docker required.
pnpm test:unit

# Type-check production and test code, lint, format-check, then unit tests.
pnpm check

# Full Vitest suite, including Restate testcontainers. Requires Docker.
pnpm test

# Complete pre-merge validation.
pnpm verify
```

When fixing a bug, first add the smallest pure regression test that reproduces
it. Add an E2E regression when the defect involves Restate state, replay,
concurrency, timers, awakeables, retries, or object-to-object delivery.

## Troubleshooting

### The machine never leaves an invoke state

Check which `fromPromise` was imported, whether the promise resolves, and
whether its `onDone`/`onError` transitions exist. An ordinary error from the
Restate-aware version is intentionally retried rather than sent to `onError`.

### A named action did nothing

Arbitrary executable XState actions are not an effect mechanism in this
integration. Convert the action to an invoked/spawned promise actor, a supported
send, or a supported delayed event.

### A waiter missed a state

Waiters observe settled macrosteps. Attach a persistent tag to the stable state
that clients should observe. Do not depend on a tag that is entered and left by
immediate transitions in one macrostep.

### A cancelled delayed call still appears in Restate

This is expected. Cancellation invalidates the integration's durable token; it
does not remove Restate's already queued internal call. Delivery checks the
token and exits without sending the event.

### A child machine cannot be resolved

Give every machine a unique explicit `id`, and make the child reachable through
`setup({ actors })` or a direct `invoke.src` machine reference. Duplicate IDs
are rejected when the object definition is created.

### Behavior changed after upgrading XState

Restore the pinned version, then inspect action shapes and inert actor-scope
behavior before attempting the upgrade again. Run unit probes and the complete
normal/`alwaysReplay` E2E suite. See [Replay and determinism](#replay-and-determinism).

# Part II: Implementation guide

## Architecture

The integration has a pure XState-facing core and an effectful Restate-facing
shell:

```mermaid
flowchart TD
    Client["Restate client"] --> Handler["Virtual-object handler"]
    Handler --> Load["Load StoredState"]
    Load --> Compute["ctx.run: initialStep / resumeStep"]
    Compute --> Step["Step = state + snapshot + effects"]
    Step --> Persist["Persist next StoredState"]
    Step --> Effects["Execute abstract effects"]
    Effects --> Actor["Promise actor handler"]
    Effects --> Timer["Delayed self-call"]
    Effects --> Child["Child object instance"]
    Effects --> Message["Self / parent / child send"]
    Step --> Waiters["Settle subscriptions"]
    Actor --> Result["Done/error event"]
    Timer --> Result
    Child --> Result
    Message --> Result
    Result --> Handler
```

The dependency direction is intentional:

```text
src/xstate/*   knows XState and plain TypeScript data
src/restate/*  executes xstate effects using Restate
```

`src/xstate/interpret.ts` has no Restate import. It can be tested with ordinary
objects and machine definitions. `src/restate/effects.ts` does not decide state
transitions; it executes a closed `Effect` union.

## The pure transition core

The two entrypoints are:

```ts
initialStep(machine, { input, isChild }): Step

resumeStep(machine, {
  stored,
  event,
  isChild,
  knownChildIds,
}): Step
```

Both return:

```ts
interface Step {
  nextState: StoredState;
  returned: ReturnedSnapshot;
  effects: Effect[];
}
```

The interpreter uses an inert XState actor scope to run the initial transition
or one macrostep. XState resolves guards, `assign`, `always`, and immediate
raises. The integration inspects the remaining executable XState actions and
maps recognized internal action types to its own discriminated `Effect` union:

```ts
type Effect =
  | { kind: "runPromise"; params: SpawnParams }
  | {
      kind: "startChild";
      childId: string;
      machineId: string;
      input: unknown;
    }
  | { kind: "stopChild"; childId: string }
  | { kind: "send"; target: Target; event: AnyEventObject }
  | {
      kind: "scheduleSend";
      sendId?: string;
      target: Target;
      event: AnyEventObject;
      delay: number;
    }
  | { kind: "cancel"; sendId: string };
```

This is the central separation of pure logic from effects. Adding a new effect
requires an explicit type, interpreter mapping, Restate executor branch, and
tests at both boundaries.

XState drops live child references when a snapshot is reconstructed. Before a
transition, the core reinjects inert stubs for known persisted child IDs. This
lets `sendTo` and `forwardTo` resolve actor-ref targets without trying to revive
an in-memory child actor.

## Handler and commit lifecycle

`createMachineObject` builds a registry of the root and reachable child
machines, validates options, and returns a Restate virtual object.

The main event lifecycle is:

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Object handler
    participant R as Restate state/journal
    participant X as Pure XState core
    participant E as Effect executor

    C->>H: send(event)
    H->>R: validate and load state
    H->>R: ctx.run("event", compute)
    R->>X: resumeStep(machine, state, event)
    X-->>R: Step
    R-->>H: recorded Step
    H->>R: set nextState
    H->>E: execute effects in order
    H->>R: settle subscriptions
    H->>E: report terminal child state
    H->>E: optionally schedule final cleanup
    H-->>C: complete
```

`create` follows the same path using `initialStep`, after clearing runtime and
root/child identity metadata. `initChild` is the internal equivalent: it clears
runtime state, stores the child's machine ID and parent identity, then computes
that child machine's initial step.

The commit order is significant:

1. store the next snapshot;
2. execute effects in their emitted order;
3. settle waiters from the returned snapshot;
4. report terminal child status to the parent; and
5. schedule final-state cleanup if configured.

Object exclusivity serializes state mutation. Promise actors execute through a
shared ingress-private handler with lazy state enabled, allowing independent
invokes to overlap without giving them mutation access.

## Persisted representation

Raw XState snapshots are not persisted. They contain methods, actor data, sets,
and live `StateNode` references. The integration stores only:

```ts
interface StoredState {
  value: unknown;
  context: unknown;
  status: SnapshotStatus;
  output?: unknown;
  error?: unknown;
  historyValue: Record<string, string[]>;
}
```

History is the non-obvious part. XState represents history using live state-node
objects. `toStored` converts each node to its stable state-node ID;
`fromStored` looks those IDs up through `machine.getStateNodeById` before calling
`machine.resolveState`. This preserves shallow and deep history through JSON
serialization and process loss.

`ReturnedSnapshot` is a separate boundary type. It adds sorted tags but omits
internal history and live XState structures.

## Effect execution

`executeEffects` loads the scheduled-delivery and child maps once, walks the
effect array in order, performs Restate operations, and writes changed maps
back. The exhaustive `switch` ends in an `assertNever`, so TypeScript makes an
unhandled new effect kind a compile-time error.

Effects are deliberately descriptions, not closures. This keeps them
serializable and makes unit tests simple: a test can assert an exact effect
array without mocking Restate.

Target resolution is also data-driven:

```ts
type Target =
  { type: "self" } | { type: "child"; childId: string } | { type: "parent" };
```

The effectful layer resolves this target to a Restate object key from the
current handler identity and durable child map. A target that no longer exists
is dropped rather than sent to the wrong object.

## Promise actor execution

The integration's `fromPromise` returns real XState promise actor logic so that
XState emits its normal spawn action. It also attaches:

- a sentinel identifying Restate-aware actor logic; and
- the real creator function as configuration.

The placeholder XState promise must never be started in the inert transition
scope. The pure layer emits `runPromise`, and the Restate layer dispatches the
ingress-private `executeActor` handler. `runActor` resolves named actor sources
from machine implementations and then branches:

- Restate-aware actor: call its creator with `{ input, ctx }`; convert only
  `TerminalError` to an XState error event; rethrow other errors for retry.
- Vanilla actor: start it with XState `createActor`/`toPromise`; convert any
  rejection to a serializable XState error event.

Both paths normalize errors to plain `{ name, message }` data before that error
is persisted or crosses an object boundary.

The actor handler sends its done/error result back to the same keyed object. It
does not mutate the parent snapshot directly.

## Child-machine execution

At object-definition time, `buildRegistry` recursively visits:

- the root machine;
- machines in each machine's `implementations.actors`; and
- machine objects referenced directly by `invoke.src`.

It indexes them by machine ID and rejects ambiguous duplicate IDs.

Starting a machine child:

1. derives `${parentKey}::${childId}`;
2. persists `{ key, machineId }` in the parent's child map;
3. sends `initChild` to the derived object key; and
4. records the child's `parentKey` and `invokeId` with its own state.

Persisting the child record before later effects is important: a subsequent
effect in the same step can already route a message to that child.

On a terminal child snapshot, `reportTerminal` sends either
`xstate.done.actor.<invokeId>` or `xstate.error.actor.<invokeId>` to the parent.
A durable `reported` flag prevents duplicate terminal reports. Stopping a child
removes its parent record and sends the child an internal cleanup call.

## Delayed delivery and cancellation

A delayed send cannot be physically withdrawn from Restate's queue. The
integration therefore uses logical cancellation:

```text
scheduled[sendId] = { uuid, targetKey, event }
```

It schedules an internal `deliverScheduled({ sendId, uuid })` call. On delivery,
the handler reloads the record and proceeds only if both IDs still match. It
deletes the record before routing the event.

`cancel(sendId)` deletes the record. Scheduling a new event under the same
explicit ID replaces its UUID, making older deliveries stale. For unnamed
delayed sends, `ctx.rand.uuidv4()` supplies both a collision-free key and a
delivery token.

This pattern makes cancellation deterministic without requiring an unsupported
queue-removal primitive.

## Waiting and subscriptions

`waitFor` is a shared handler so it can remain suspended without blocking the
object's exclusive event handlers. It:

1. validates the object and condition;
2. creates a Restate awakeable;
3. calls the exclusive `subscribe` handler to evaluate or store it;
4. optionally sends the request event; and
5. awaits the result, optionally with a timeout.

`subscribe` first checks the current snapshot. It immediately resolves a
satisfied condition or rejects one that can no longer succeed. Otherwise it
stores the awakeable ID under the condition.

Every committed step calls `settleSubscriptions`. It evaluates each distinct
condition once, settles all awakeables registered for a decided condition, and
removes that condition from durable state.

An awakeable rejection arrives as a Restate error with code 500. `waitFor`
translates that specific case to terminal status 412 so callers can distinguish
a condition that became impossible from a transient service failure.

The current timeout path does not unregister its awakeable ID from the
subscription map. A later decided snapshot removes the condition and attempts
to settle every registered ID; reset also clears the map. This is an area to
revisit if applications create many timeouts against conditions that can remain
pending forever.

## Replay and determinism

Restate may replay a handler after suspension or recovery. The integration
wraps transition computation in:

```ts
ctx.run("create", () => initialStep(...));
ctx.run("event", () => resumeStep(...));
```

The journal records the resulting `Step`, so replay uses the recorded value
instead of rerunning synchronous machine code for that journal entry. Restate
also journals state operations, sends, random UUID generation, awakeables, and
delays.

This is a safety boundary, not a reason to hide effects inside guards or
assignments. Keeping machine evaluation pure avoids surprising behavior during
fresh execution, test probes, migrations, and version upgrades.

The parent-aware inert XState scope and action decoding currently depend on
XState internal shapes. In particular, the integration recognizes XState's
internal action type strings and fabricates inert actor references for routing.
That is why XState is pinned exactly to `5.32.4`.

For an XState upgrade:

1. inspect emitted action types and parameter shapes;
2. verify initial and transition scope behavior;
3. verify invoke/spawn behavior, including spawn inside `assign`;
4. verify actor-ref routing after snapshot rehydration;
5. run snapshot/history round-trip probes;
6. run all unit tests; and
7. run the E2E suite in both normal and forced-replay modes.

## Source map

| Module                                                 | Responsibility                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| [`src/index.ts`](src/index.ts)                         | Public exports                                                   |
| [`src/xstate/types.ts`](src/xstate/types.ts)           | Persisted, returned, step, target, and effect types              |
| [`src/xstate/interpret.ts`](src/xstate/interpret.ts)   | Pure initial/resume steps and XState-action translation          |
| [`src/xstate/scope.ts`](src/xstate/scope.ts)           | Inert and parent-aware XState execution scope                    |
| [`src/xstate/snapshot.ts`](src/xstate/snapshot.ts)     | Snapshot serialization, history rehydration, public projection   |
| [`src/xstate/registry.ts`](src/xstate/registry.ts)     | Reachable child-machine discovery and ID validation              |
| [`src/xstate/conditions.ts`](src/xstate/conditions.ts) | Pure waiter-condition validation and evaluation                  |
| [`src/xstate/actors.ts`](src/xstate/actors.ts)         | Actor-source resolution, sentinel detection, error/event helpers |
| [`src/restate/object.ts`](src/restate/object.ts)       | Virtual-object definition and handler lifecycle                  |
| [`src/restate/effects.ts`](src/restate/effects.ts)     | Abstract-effect execution, waiter settlement, terminal reporting |
| [`src/restate/state.ts`](src/restate/state.ts)         | Named accessors for all durable KV state                         |
| [`src/restate/promise.ts`](src/restate/promise.ts)     | Public Restate-aware `fromPromise` adapter                       |
| [`src/restate/run-actor.ts`](src/restate/run-actor.ts) | Out-of-band promise execution and error semantics                |
| [`src/restate/types.ts`](src/restate/types.ts)         | Restate handler, request, option, and child-record types         |

## Contributor test strategy

The repository uses four confidence layers:

1. **Pure behavior tests** cover snapshots, conditions, registry discovery,
   action translation, routing, and exact `Step`/`Effect` values.
2. **Adapter unit tests** use narrow fake contexts to cover state-independent
   Restate dispatch, cancellation tokens, child maps, actor errors, and terminal
   reporting.
3. **E2E tests** run real virtual objects against Restate testcontainers.
4. **Forced-replay E2E tests** repeat every E2E scenario with
   `alwaysReplay: true`.

When implementing a feature, keep the same dependency direction:

- add or refine a discriminated pure type;
- compute it without Restate dependencies;
- execute it in the Restate shell;
- exhaustively handle the new union member;
- test the pure decision table;
- test the adapter call/state changes; and
- add E2E coverage for the durable behavior.

High-value invariants to preserve include:

- JSON round-trip does not change future transitions;
- deep history survives persistence;
- two unnamed delayed sends cannot collide;
- cancellation makes stale deliveries harmless;
- child start/stop/re-entry does not retain old state;
- a child terminal event is reported once;
- concurrent invokes cannot overwrite each other's context updates;
- subscription is established before an optional triggering event;
- transient Restate-aware actor errors retry, while terminal ones reach
  `onError`; and
- every durable scenario behaves the same under forced replay.

# Appendix A: API reference

## Exports

| Export                  | Kind     | Purpose                                                        |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `createMachineObject`   | Function | Convert a root XState machine into a Restate object definition |
| `fromPromise`           | Function | Define a Restate-aware XState promise actor                    |
| `RestatePromiseCreator` | Type     | Creator signature receiving `{ input, ctx }`                   |
| `MachineObjectOptions`  | Type     | Restate object options plus `finalStateTTL`                    |
| `MachineVirtualObject`  | Type     | Typed handler surface for SDK clients                          |
| `WaitForRequest`        | Type     | Condition, optional timeout, and optional typed event          |
| `SubscribeRequest`      | Type     | Condition plus an existing awakeable ID                        |
| `StoredState`           | Type     | Internal serializable snapshot representation                  |
| `ReturnedSnapshot`      | Type     | Public serializable snapshot projection                        |
| `Condition`             | Type     | `done` or `hasTag:<tag>`                                       |

## Public handlers

| Handler     | Request             | Result             | Notes                                             |
| ----------- | ------------------- | ------------------ | ------------------------------------------------- |
| `create`    | `InputFrom<M>`      | `void`             | Creates or resets the root instance               |
| `send`      | `EventFrom<M>`      | `void`             | Commits one settled macrostep                     |
| `snapshot`  | `{}`                | `ReturnedSnapshot` | Requires an existing, non-disposed instance       |
| `waitFor`   | `WaitForRequest<M>` | `ReturnedSnapshot` | Shared long-poll; event is sent after subscribing |
| `subscribe` | `SubscribeRequest`  | `void`             | Low-level awakeable registration                  |

The object also contains ingress-private handlers named `executeActor`,
`deliverScheduled`, `initChild`, and `cleanupState`. They are implementation
details and should not be called by application clients.

# Appendix B: Durable state keys

All KV access is centralized in [`src/restate/state.ts`](src/restate/state.ts).

| Key             | Value                           | Purpose                                                       |
| --------------- | ------------------------------- | ------------------------------------------------------------- |
| `state`         | `StoredState`                   | Current serialized XState snapshot                            |
| `disposed`      | `boolean`                       | Marks an instance cleaned after final-state TTL or child stop |
| `subscriptions` | condition → awakeable IDs       | Pending `waitFor`/`subscribe` registrations                   |
| `scheduled`     | send ID → delivery record       | Cancellation and stale-delivery guard                         |
| `children`      | child ID → `{ key, machineId }` | Durable child routing and lifecycle                           |
| `reported`      | `boolean`                       | Prevents duplicate terminal reports from a child              |
| `machineId`     | `string`                        | Selects child machine logic from the registry                 |
| `parentKey`     | `string`                        | Routes `sendParent` and terminal reports                      |
| `invokeId`      | `string`                        | Builds the parent's XState actor result event                 |

# Appendix C: Error reference

| Status/code | Meaning                                                | Typical fix                                                           |
| ----------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 400         | Invalid wait condition                                 | Use `done` or `hasTag:<tag>`                                          |
| 404         | No machine at this object key                          | Call `create` before `send`, `snapshot`, or `waitFor`                 |
| 410         | Instance was disposed                                  | Use a new key or explicitly call `create` to start fresh              |
| 412         | Wait condition became impossible                       | Handle completed/error outcome instead of retrying the same condition |
| 500         | Unknown persisted child machine ID or internal failure | Check unique stable machine IDs and deployment compatibility          |

Configuration errors such as a negative, infinite, or `NaN`
`finalStateTTL` throw synchronously while creating the object definition.
