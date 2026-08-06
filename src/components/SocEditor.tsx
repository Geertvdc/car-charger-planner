"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SocEditor({ initialSoc }: { initialSoc: number }) {
  const router = useRouter();
  const [soc, setSoc] = useState(initialSoc);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await fetch("/api/car/soc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soc }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        max={100}
        className="input w-20"
        value={soc}
        onChange={(e) => setSoc(Number(e.target.value))}
      />
      <span className="text-lg font-semibold">%</span>
      <button className="btn" onClick={save} disabled={saving || soc === initialSoc}>
        {saving ? "…" : "Set"}
      </button>
    </div>
  );
}
