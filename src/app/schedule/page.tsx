import { prisma } from "@/lib/db";
import { addWeeklyWindow, deleteWindow, saveWeeklyDay } from "@/app/actions";

export const dynamic = "force-dynamic";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default async function SchedulePage() {
  const days = await prisma.weeklyDay.findMany({
    include: { windows: { orderBy: { startTime: "asc" } } },
    orderBy: { dayOfWeek: "asc" },
  });
  const byDow = new Map(days.map((d) => [d.dayOfWeek, d]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Weekly schedule</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Your default week: when you&apos;re home (charging is only planned in home windows) and how
          full the car must be by each morning. Use <span className="text-[var(--color-accent)]">Upcoming days</span> to
          diverge on specific dates.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {DAYS.map((label, dow) => {
          const day = byDow.get(dow);
          return (
            <div key={dow} className="panel space-y-3 p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{label}</h2>
              </div>

              <form action={saveWeeklyDay} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="dayOfWeek" value={dow} />
                <label className="block">
                  <span className="label">Ready by</span>
                  <input
                    className="input w-28"
                    type="time"
                    name="deadlineTime"
                    defaultValue={day?.deadlineTime ?? "07:00"}
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
                    defaultValue={day?.targetSoc ?? 80}
                  />
                </label>
                <button className="btn" type="submit">
                  Save
                </button>
              </form>

              <div className="space-y-1.5">
                <div className="label">Home windows</div>
                {(day?.windows.length ?? 0) === 0 && (
                  <p className="text-xs text-[var(--color-muted)]">Away all day — no charging planned.</p>
                )}
                {day?.windows.map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-sm"
                  >
                    <span>
                      {w.startTime}–{w.endTime}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        w.status === "MAYBE"
                          ? "bg-[rgba(94,200,255,0.12)] text-[var(--color-muted)]"
                          : "bg-[rgba(94,200,255,0.28)] text-[var(--color-text)]"
                      }`}
                    >
                      {w.status === "MAYBE" ? "maybe home" : "home"}
                    </span>
                    <form action={deleteWindow} className="ml-auto">
                      <input type="hidden" name="id" value={w.id} />
                      <button className="text-xs text-[var(--color-muted)] hover:text-[var(--color-expensive)]" type="submit">
                        ✕
                      </button>
                    </form>
                  </div>
                ))}
              </div>

              <form action={addWeeklyWindow} className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3">
                <input type="hidden" name="dayOfWeek" value={dow} />
                <label className="block">
                  <span className="label">From</span>
                  <input className="input w-24" type="time" name="startTime" defaultValue="00:00" />
                </label>
                <label className="block">
                  <span className="label">Until</span>
                  <input className="input w-24" type="time" name="endTime" defaultValue="23:59" />
                </label>
                <label className="block">
                  <span className="label">Status</span>
                  <select className="select w-28" name="status" defaultValue="DEFINITE">
                    <option value="DEFINITE">Home</option>
                    <option value="MAYBE">Maybe home</option>
                  </select>
                </label>
                <button className="btn" type="submit">
                  + Add
                </button>
              </form>
            </div>
          );
        })}
      </div>
    </div>
  );
}
