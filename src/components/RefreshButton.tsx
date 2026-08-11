"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAppUrl } from "./BasePathProvider";

export default function RefreshButton() {
  const router = useRouter();
  const appUrl = useAppUrl();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(appUrl("/api/refresh"), { method: "POST" });
      const json = await res.json();
      setMsg(`prices ${json.prices?.count ?? 0} · solar ${json.solar?.count ?? 0}`);
      router.refresh();
    } catch {
      setMsg("refresh failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-[var(--color-muted)]">{msg}</span>}
      <button className="btn btn-primary" onClick={refresh} disabled={loading}>
        {loading ? "Refreshing…" : "↻ Refresh data & plan"}
      </button>
    </div>
  );
}
