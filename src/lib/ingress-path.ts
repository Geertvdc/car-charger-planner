/**
 * Home Assistant's Ingress proxy serves the add-on under a per-install path such as
 * `/api/hassio_ingress/<token>`, strips that prefix before forwarding, and passes the
 * original prefix in `X-Ingress-Path`. Server-side routing therefore needs no changes,
 * but anything the app hands to the *browser* — link hrefs, fetch URLs, asset URLs —
 * must carry the prefix back, or it resolves against the Home Assistant root instead
 * of the add-on.
 *
 * Deliberately free of Next.js imports: the standalone ingress proxy (src/ingress/)
 * runs as a plain Node process outside any request context and shares this module.
 */
export const INGRESS_PATH_HEADER = "x-ingress-path";

/**
 * Normalize an ingress prefix into something safe to concatenate into URLs and to
 * substitute into response bodies. The header is attacker-controllable by anything that
 * can reach the add-on port directly, so the value is restricted to a plain path
 * (no scheme, no traversal, no quotes/angle brackets that could break out of markup).
 * Anything unexpected degrades to "" — i.e. behave as if not behind Ingress.
 */
export function normalizeBasePath(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "" || value === "/") return "";
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(value)) return "";
  if (value.includes("..") || value.includes("//")) return "";
  return value.replace(/\/+$/, "");
}
