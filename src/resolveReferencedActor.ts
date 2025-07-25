import { AnyStateMachine, InvokeConfig } from "xstate";

export function resolveReferencedActor(machine: AnyStateMachine, src: string) {
  const match = src.match(/^xstate\.invoke\.(\d+)\.(.*)/)!;
  if (!match) {
    return machine.implementations.actors[src];
  }
  const [, indexStr, nodeId] = match;
  const node = machine.getStateNodeById(nodeId);
  console.log(indexStr, nodeId, node.config.invoke);
  const invokeConfig = node.config.invoke!;
  return (
    Array.isArray(invokeConfig)
      ? invokeConfig[indexStr as any]
      : (invokeConfig as InvokeConfig<
          any,
          any,
          any,
          any,
          any,
          any,
          any, // TEmitted
          any // TMeta
        >)
  ).src;
}
