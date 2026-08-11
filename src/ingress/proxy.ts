import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { INGRESS_PATH_HEADER, normalizeBasePath } from "../lib/ingress-path";
import { rewriteBody, rewriteLinkHeader, rewriteLocation, shouldRewriteBody } from "./rewrite";

export interface ProxyOptions {
  /** Port this proxy listens on — the add-on's `ingress_port`. */
  listenPort: number;
  /** Port the Next.js server listens on, bound to loopback only. */
  upstreamPort: number;
  upstreamHost?: string;
}

/**
 * Reverse proxy in front of `next start`, translating between Home Assistant Ingress
 * and a plain Next.js server. Requests pass through untouched (including the
 * `X-Ingress-Path` header, which the app reads to build its own URLs); responses get
 * their baked-in `/_next/` asset URLs and redirect targets prefixed.
 *
 * With no `X-Ingress-Path` header this is a transparent pass-through, so the same
 * entrypoint serves direct access on a published port.
 */
export function startIngressProxy(options: ProxyOptions): http.Server {
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";

  const server = http.createServer((req, res) => {
    const basePath = normalizeBasePath(req.headers[INGRESS_PATH_HEADER] as string | undefined);

    const upstream = http.request(
      {
        host: upstreamHost,
        port: options.upstreamPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: `${upstreamHost}:${options.upstreamPort}`,
          // Rewriting needs plain text; ask Next not to compress. The hop to the
          // browser is local to Home Assistant, so nothing is lost.
          "accept-encoding": "identity",
        },
      },
      (upstreamRes) => forwardResponse(upstreamRes, res, basePath)
    );

    upstream.on("error", (err) => {
      // Next is still booting, or has died and the entrypoint is about to exit.
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Car Charger Planner is not ready yet (${err.message})`);
    });

    req.pipe(upstream);
  });

  server.listen(options.listenPort, "0.0.0.0", () => {
    console.log(`[ingress] proxying :${options.listenPort} -> :${options.upstreamPort}`);
  });
  return server;
}

function forwardResponse(
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  basePath: string
): void {
  const headers = { ...upstreamRes.headers };
  const location = rewriteLocation(headers.location, basePath);
  if (location) headers.location = location;
  const link = rewriteLinkHeader(headers.link, basePath);
  if (link) headers.link = link;

  const contentType = upstreamRes.headers["content-type"];
  if (!basePath || !shouldRewriteBody(contentType)) {
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(res);
    return;
  }

  // Rewriting changes the byte length, so the body has to be buffered whole and the
  // original framing headers replaced. Next streams pages with Transfer-Encoding:
  // chunked — leaving that alongside our Content-Length is a protocol error that
  // clients reject outright, so both go and only Content-Length comes back.
  const chunks: Buffer[] = [];
  upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
  upstreamRes.on("end", () => {
    const body = rewriteBody(Buffer.concat(chunks).toString("utf8"), basePath);
    const buffer = Buffer.from(body, "utf8");
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    res.writeHead(upstreamRes.statusCode ?? 502, {
      ...headers,
      "content-length": String(buffer.byteLength),
    });
    res.end(buffer);
  });
  upstreamRes.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
}
