import { headers } from "next/headers";
import { INGRESS_PATH_HEADER, normalizeBasePath } from "./ingress-path";

/** The current request's Ingress prefix, or "" when served directly. */
export async function getBasePath(): Promise<string> {
  const h = await headers();
  return normalizeBasePath(h.get(INGRESS_PATH_HEADER));
}
