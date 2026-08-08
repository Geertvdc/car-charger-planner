import { prisma } from "@/lib/db";
import { resolveDay } from "@/lib/availability";
import { addDaysISO, todayISO } from "@/lib/time";
import {
  addOverrideWindow,
  deleteOverride,
  deleteWindow,
  saveOverride,
} from "@/app/actions";
import { DateTime } from "luxon";

export const dynamic = "force-dynamic";

const HORIZON = 8;

export default async function UpcomingPage() {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const tz = settings.timezone;
  const today = todayISO(tz);
  const dates = Array.from({ length: HORIZON }, (_, i) => addDaysISO(today, i));

  const rows = await Promise.all(
    dates.map(async (date) => {
      const effective = await resolveDay(date);
      const override = await prisma.dayOverride.findUnique({
        where: { date },
        include: { windows: { orderBy: { startTime: "asc" } } },
      });
      const label = DateTime.fromISO(date).toFormat("cccc dd LLL");
      return { date, label, effective, override };
    })
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Upcoming days</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Diverge from the weekly template for specific dates. An override replaces that day&apos;s home
          windows; deadline &amp; target fall back to the template if left blank.
        </p>
      </div>

      <div className="space-y-3">
        {rows.map(({ date, label, effective, override }) => (
          <div key={date} className="panel space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">{label}</h2>
                {date === today && (
                  <span className="rounded-md bg-[rgba(94,200,255,0.14)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-home)]">
                    TODAY
                  </span>
                )}
                {override && (
                  <span className="rounded-md bg-[rgba(255,201,77,0.14)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-accent)]">
                    OVERRIDE
                  </span>
                )}
              </div>
              <span className="font-mono text-xs text-[var(--color-muted)]">
                effective: {effective.targetSoc}% by {effective.deadlineTime} ·{" "}
                {effective.windows.length === 0
                  ? "away"
                  : effective.windows.map((w) => `${w.startTime}-${w.endTime}`).join(", ")}
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <form action={saveOverride} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="date" value={date} />
                <label className="block">
                  <span className="label">Ready by</span>
                  <input
                    className="input w-28"
                    type="time"
                    name="deadlineTime"
                    defaultValue={override?.deadlineTime ?? ""}
                  />
                </label>
                <label className="block">
                  <span className="label">Target %</span>
                  <input
                    className="input w-20"
                    type="number"
                    name="targetSoc"
                    min={0}
                    max={100}
                    defaultValue={override?.targetSoc ?? ""}
                  />
                </label>
                <label className="block grow">
                  <span className="label">Note</span>
                  <input className="input" type="text" name="note" defaultValue={override?.note ?? ""} />
                </label>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" name="away" defaultChecked={override?.away ?? false} />
                  <span>Away all day</span>
                </label>
                <button className="btn" type="submit">
                  Save override
                </button>
              </form>
              {override && (
                <form action={deleteOverride}>
                  <input type="hidden" name="id" value={override.id} />
                  <button className="btn" type="submit">
                    Reset to template
                  </button>
                </form>
              )}
            </div>

            {override && (
              <>
                <div className="space-y-1.5">
                  <div className="label">Override home windows</div>
                  {override.windows.length === 0 && (
                    <p className="text-xs text-[var(--color-muted)]">
                      No windows on the override — treated as away all day.
                    </p>
                  )}
                  {override.windows.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
                    >
                      <span>
                        {w.startTime}–{w.endTime}
                      </span>
                      <span className="text-xs text-[var(--color-muted)]">home</span>
                      <form action={deleteWindow} className="ml-auto">
                        <input type="hidden" name="id" value={w.id} />
                        <button className="text-xs text-[var(--color-muted)] hover:text-[var(--color-expensive)]" type="submit">
                          ✕
                        </button>
                      </form>
                    </div>
                  ))}
                </div>

                <form action={addOverrideWindow} className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3">
                  <input type="hidden" name="date" value={date} />
                  <label className="block">
                    <span className="label">From</span>
                    <input className="input w-24" type="time" name="startTime" defaultValue="00:00" />
                  </label>
                  <label className="block">
                    <span className="label">Until</span>
                    <input className="input w-24" type="time" name="endTime" defaultValue="23:59" />
                  </label>
                  <button className="btn" type="submit">
                    + Add
                  </button>
                </form>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
