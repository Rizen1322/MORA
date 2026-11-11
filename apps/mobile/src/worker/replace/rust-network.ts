// iOS fetch already uses URLSession in JavaScriptCore; the desktop helper cannot run here.
export const networkFetch: typeof fetch = (input, init) => fetch(input, init);
export function rustNetworkEnabled(): boolean { return false; }
export function nativeDownload(..._args: unknown[]): null { return null; }
