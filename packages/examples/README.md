# examples

Runnable Restate services built on
[`@restatedev/xstate`](../xstate-transitions). Every example is an
XState **v6** pure-transition machine exposed as a durable Restate virtual
object, and all of them share one endpoint.

## Run

```sh
pnpm install
pnpm dev   # tsx watch ./src/index.ts — binds every example to one endpoint
docker run --net host --add-host=host.docker.internal:host-gateway restatedev/restate:latest
```

Register `http://localhost:9080` in the Restate UI (<http://localhost:9070>).
Ingress is at `http://localhost:8080`; each object is reachable at
`/{service}/{key}/{handler}` — `create`, `send`, `snapshot`, `waitFor`.

## The examples

Three are ports of upstream [XState examples](https://github.com/statelyai/xstate/tree/main/examples)
from v5 (`assign` / `actions` / named `delays`) to this integration's
pure-transition v6 style; the rest lean into `setup({ schemas })` typing.

| File          | Service    | Shows                                                                     |
| ------------- | ---------- | ------------------------------------------------------------------------- |
| `greeting.ts` | `greeting` | Smallest shape: typed `input`, one async actor, `final` `output`.         |
| `auction.ts`  | `auction`  | Typed event payload + a durable `after` timer that closes bidding.        |
| `library.ts`  | `library`  | Typed events, `always` guards, nested compound state, a 2-week timer.     |
| `orders.ts`   | `orders`   | Schemas-first typing, `fromHandler`/`ctx.run`, `onError`, tags/`waitFor`. |
| `example.ts`  | `payment`  | Payment confirmation: invoke → `always` branch → success/insufficient.    |

`src/index.ts` serves them all with `restate.serve({ services: [...] })`.

## Try it

```sh
# Greeting: create runs the initial transition; snapshot reads the result.
curl http://localhost:8080/greeting/greet-1/create --json '{"person":{"name":"Jenny"}}'
curl http://localhost:8080/greeting/greet-1/snapshot --json '{}'

# Order: schemas give a typed event surface; wait for the "ready" tag.
curl http://localhost:8080/orders/order-1/create --json '{"sku":"ABC-42","quantity":2}'
curl http://localhost:8080/orders/order-1/send   --json '{"type":"SUBMIT"}'
curl http://localhost:8080/orders/order-1/waitFor --json '{"condition":"hasTag:ready","timeout":30000}'

# Auction: bid, then read the winner after the bidding window closes.
curl http://localhost:8080/auction/car-1/create --json '{}'
curl http://localhost:8080/auction/car-1/send   --json '{"type":"CarBidEvent","bid":{"carId":"car-1","amount":4000,"bidder":{"id":"a","firstName":"Jane","lastName":"Doe"}}}'
```

Every example declares its `input`/`events` with [Zod](https://zod.dev) schemas,
so `create`/`send` are validated and their JSON Schemas appear in Restate
discovery. See the library [MANUAL](../xstate-transitions/MANUAL.md) for the full
authoring and runtime model, including how ingress validation is derived from a
machine's own `schemas`.
