export default function StatTile({
  icon,
  accent,
  label,
  value,
  valueColor,
  caption,
}: {
  icon: string;
  accent: string;
  label: string;
  value: string;
  valueColor?: string;
  caption?: string;
}) {
  return (
    <div className="panel flex flex-col gap-2.5 p-4">
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[15px]"
          style={{
            background: `color-mix(in srgb, ${accent} 16%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
          }}
        >
          {icon}
        </span>
        <div className="text-xs font-medium text-[var(--color-muted)]">{label}</div>
      </div>
      <div className="text-xl font-bold leading-none" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {caption && <div className="text-xs leading-snug text-[var(--color-muted)]">{caption}</div>}
    </div>
  );
}
