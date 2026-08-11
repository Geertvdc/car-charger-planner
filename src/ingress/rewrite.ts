/**
 * Response rewriting for Home Assistant Ingress.
 *
 * The app itself prefixes everything it controls (see src/lib/base-path.ts), but
 * Next.js bakes `/_next/...` asset URLs into its HTML, CSS, JS chunks and flight
 * payloads at build time, and `basePath` cannot be set from a per-request header.
 * Those URLs are root-absolute, so under Ingress the browser would ask Home Assistant
 * for them instead of the add-on. Rewriting them on the way out is what closes the gap.
 */

const ASSET_PREFIX = "/_next/";

/** Content types whose bodies can contain baked-in `/_next/` URLs. */
const REWRITABLE_TYPES = [
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "text/x-component", // React flight payloads (preload hints for chunks)
];

export function shouldRewriteBody(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return REWRITABLE_TYPES.includes(type);
}

/**
 * Point every `/_next/` URL at the add-on's Ingress prefix. Skips occurrences that
 * already carry the prefix so a double pass can't produce `/prefix/prefix/_next/`.
 */
export function rewriteBody(body: string, basePath: string): string {
  if (!basePath) return body;
  const alreadyPrefixed = `${basePath}${ASSET_PREFIX}`;
  const parts = body.split(alreadyPrefixed);
  return parts.map((part) => part.split(ASSET_PREFIX).join(alreadyPrefixed)).join(alreadyPrefixed);
}

/**
 * Next.js advertises its stylesheet and fonts up front via `Link: </_next/...>;
 * rel=preload` response headers. Those are root-absolute like the ones in the body,
 * so without rewriting the browser preloads them from the Home Assistant root and
 * takes a 404 on every page load before falling back to the real URL.
 */
export function rewriteLinkHeader(
  value: string | string[] | undefined,
  basePath: string
): string | string[] | undefined {
  if (!value || !basePath) return value;
  return Array.isArray(value)
    ? value.map((entry) => rewriteBody(entry, basePath))
    : rewriteBody(value, basePath);
}

/**
 * Prefix a redirect target that points back into this app. Absolute URLs (another
 * host) and already-prefixed paths are left alone.
 */
export function rewriteLocation(location: string | undefined, basePath: string): string | undefined {
  if (!location || !basePath) return location;
  if (!location.startsWith("/") || location.startsWith("//")) return location;
  if (location === basePath || location.startsWith(`${basePath}/`)) return location;
  return `${basePath}${location}`;
}
