/** node:url */
export function fileURLToPath(u: string | URL): string {
  return decodeURIComponent(new URL(String(u)).pathname);
}
export function pathToFileURL(p: string): URL {
  return new URL(`file://${encodeURI(p)}`);
}
const Url = globalThis.URL;
const Params = globalThis.URLSearchParams;
export { Url as URL, Params as URLSearchParams };
export default { fileURLToPath, pathToFileURL, URL: Url, URLSearchParams: Params };
