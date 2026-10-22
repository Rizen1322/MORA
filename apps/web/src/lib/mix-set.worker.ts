import { orderMixSet, type MixSetItem } from '../../../../packages/core/src/rec/mix-set.ts';
self.onmessage = (event: MessageEvent<{ items: MixSetItem[]; mode: 'smooth' | 'build' }>) => {
  try { self.postMessage({ entryIds: orderMixSet(event.data.items, event.data.mode).map(t => t.entryId) }); }
  catch (error) { self.postMessage({ error: (error as Error).message }); }
};
