import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "../lib/ingress-path";
import { rewriteBody, rewriteLinkHeader, rewriteLocation, shouldRewriteBody } from "./rewrite";

const PREFIX = "/api/hassio_ingress/abc123";

describe("normalizeBasePath", () => {
  it("accepts a Home Assistant ingress path", () => {
    expect(normalizeBasePath(PREFIX)).toBe(PREFIX);
  });

  it("strips trailing slashes", () => {
    expect(normalizeBasePath(`${PREFIX}/`)).toBe(PREFIX);
  });

  it("treats missing, empty and root values as 'not behind ingress'", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath(null)).toBe("");
    expect(normalizeBasePath("  ")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
  });

  it("rejects values that could break out of an attribute or a rewritten body", () => {
    expect(normalizeBasePath('/a"><script>alert(1)</script>')).toBe("");
    expect(normalizeBasePath("/a'")).toBe("");
    expect(normalizeBasePath("/a b")).toBe("");
  });

  it("rejects absolute URLs and path traversal", () => {
    expect(normalizeBasePath("https://evil.example/x")).toBe("");
    expect(normalizeBasePath("//evil.example")).toBe("");
    expect(normalizeBasePath("/api/../../etc")).toBe("");
    expect(normalizeBasePath("relative/path")).toBe("");
  });
});

describe("shouldRewriteBody", () => {
  it("matches the content types that can carry baked-in asset URLs", () => {
    expect(shouldRewriteBody("text/html; charset=utf-8")).toBe(true);
    expect(shouldRewriteBody("TEXT/CSS")).toBe(true);
    expect(shouldRewriteBody("application/javascript")).toBe(true);
    expect(shouldRewriteBody("text/x-component")).toBe(true);
  });

  it("leaves everything else to stream through untouched", () => {
    expect(shouldRewriteBody("application/json")).toBe(false);
    expect(shouldRewriteBody("image/png")).toBe(false);
    expect(shouldRewriteBody("font/woff2")).toBe(false);
    expect(shouldRewriteBody(undefined)).toBe(false);
  });
});

describe("rewriteBody", () => {
  it("prefixes script, style and preload asset URLs in HTML", () => {
    const html = `<link rel="stylesheet" href="/_next/static/css/app.css"><script src="/_next/static/chunks/main.js"></script>`;
    expect(rewriteBody(html, PREFIX)).toBe(
      `<link rel="stylesheet" href="${PREFIX}/_next/static/css/app.css"><script src="${PREFIX}/_next/static/chunks/main.js"></script>`
    );
  });

  it("prefixes the webpack public path inside a JS chunk", () => {
    expect(rewriteBody(`__webpack_require__.p="/_next/";`, PREFIX)).toBe(
      `__webpack_require__.p="${PREFIX}/_next/";`
    );
  });

  it("prefixes font URLs inside CSS", () => {
    expect(rewriteBody("@font-face{src:url(/_next/static/media/a.woff2)}", PREFIX)).toBe(
      `@font-face{src:url(${PREFIX}/_next/static/media/a.woff2)}`
    );
  });

  it("is a no-op when not behind ingress", () => {
    const html = `<script src="/_next/static/chunks/main.js"></script>`;
    expect(rewriteBody(html, "")).toBe(html);
  });

  it("does not double-prefix an already-rewritten body", () => {
    const once = rewriteBody(`<script src="/_next/x.js"></script>`, PREFIX);
    expect(rewriteBody(once, PREFIX)).toBe(once);
  });

  it("leaves app routes and API paths alone (the app prefixes those itself)", () => {
    const html = `<a href="/settings">Settings</a><form action="/api/refresh">`;
    expect(rewriteBody(html, PREFIX)).toBe(html);
  });
});

describe("rewriteLinkHeader", () => {
  it("prefixes a preload hint", () => {
    expect(rewriteLinkHeader("</_next/static/css/app.css>; rel=preload; as=style", PREFIX)).toBe(
      `<${PREFIX}/_next/static/css/app.css>; rel=preload; as=style`
    );
  });

  it("handles the multi-value (array) form", () => {
    expect(
      rewriteLinkHeader(["</_next/a.css>; rel=preload", "</_next/b.woff2>; rel=preload"], PREFIX)
    ).toEqual([`<${PREFIX}/_next/a.css>; rel=preload`, `<${PREFIX}/_next/b.woff2>; rel=preload`]);
  });

  it("is a no-op without a prefix or a header", () => {
    expect(rewriteLinkHeader("</_next/a.css>", "")).toBe("</_next/a.css>");
    expect(rewriteLinkHeader(undefined, PREFIX)).toBeUndefined();
  });
});

describe("rewriteLocation", () => {
  it("prefixes an app-relative redirect", () => {
    expect(rewriteLocation("/settings", PREFIX)).toBe(`${PREFIX}/settings`);
  });

  it("leaves an already-prefixed redirect alone", () => {
    expect(rewriteLocation(`${PREFIX}/settings`, PREFIX)).toBe(`${PREFIX}/settings`);
  });

  it("leaves absolute and protocol-relative URLs alone", () => {
    expect(rewriteLocation("https://example.com/x", PREFIX)).toBe("https://example.com/x");
    expect(rewriteLocation("//example.com/x", PREFIX)).toBe("//example.com/x");
  });

  it("is a no-op without a prefix or a location", () => {
    expect(rewriteLocation("/settings", "")).toBe("/settings");
    expect(rewriteLocation(undefined, PREFIX)).toBeUndefined();
  });
});
