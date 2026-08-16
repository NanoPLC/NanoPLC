import type { SimulatorSnapshot } from "@nanoplc/ir-schema";

export interface SimLivePayload {
  running: boolean;
  vars: Record<string, boolean | number>;
}

type SimLiveListener = (payload: SimLivePayload) => void;

const listeners = new Set<SimLiveListener>();
let last: SimLivePayload = { running: false, vars: {} };

export function publishSimLive(payload: SimLivePayload): void {
  last = payload;
  for (const listener of listeners) {
    listener(payload);
  }
}

export function publishSimSnapshot(running: boolean, snap?: SimulatorSnapshot): void {
  publishSimLive({ running, vars: snap?.vars ?? {} });
}

export function subscribeSimLive(listener: SimLiveListener): { dispose: () => void } {
  listeners.add(listener);
  listener(last);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}
