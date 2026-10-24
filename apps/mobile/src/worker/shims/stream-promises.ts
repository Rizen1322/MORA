/** node:stream/promises */
import { pipeline as pipelineCb, finished as finishedCb } from 'readable-stream';

export function pipeline(...streams: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    (pipelineCb as (...a: unknown[]) => void)(...streams, (e: Error | null) => (e ? reject(e) : resolve()));
  });
}
export function finished(s: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    (finishedCb as (...a: unknown[]) => void)(s, (e: Error | null) => (e ? reject(e) : resolve()));
  });
}
export default { pipeline, finished };
