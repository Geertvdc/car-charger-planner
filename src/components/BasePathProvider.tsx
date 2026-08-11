"use client";

import { createContext, useContext } from "react";

/**
 * The Ingress prefix for the current request, handed down from the server layout so
 * client components can build URLs that resolve against the add-on rather than the
 * Home Assistant root. Empty string when the app is served directly.
 */
const BasePathContext = createContext("");

export function BasePathProvider({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return <BasePathContext.Provider value={value}>{children}</BasePathContext.Provider>;
}

export function useBasePath(): string {
  return useContext(BasePathContext);
}

/** Prefix an app-absolute path (e.g. "/api/refresh") for use in fetch() or an href. */
export function useAppUrl(): (path: string) => string {
  const basePath = useBasePath();
  return (path: string) => `${basePath}${path}`;
}
