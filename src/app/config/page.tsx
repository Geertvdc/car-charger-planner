import { prisma } from "@/lib/db";
import { addPv, deletePv, saveCar } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const [car, pv] = await Promise.all([
    prisma.carConfig.findUniqueOrThrow({ where: { id: 1 } }),
    prisma.pvString.findMany({ orderBy: { id: "asc" } }),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Car &amp; solar</h1>

      <form action={saveCar} className="panel space-y-4 p-5">
        <h2 className="text-sm font-semibold text-[var(--color-accent)]">Car &amp; charger</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Battery (kWh)" name="batteryKwh" defaultValue={car.batteryKwh} step="0.1" />
          <Field label="Charger power (kW)" name="chargerPowerKw" defaultValue={car.chargerPowerKw} step="0.1" />
          <Field label="Charge efficiency (0–1)" name="efficiency" defaultValue={car.efficiency} step="0.01" />
          <Field label="Min SoC (%)" name="minSoc" defaultValue={car.minSoc} step="1" />
          <Field label="Max SoC (%)" name="maxSoc" defaultValue={car.maxSoc} step="1" />
        </div>
        <button className="btn btn-primary" type="submit">
          Save car
        </button>
      </form>

      <div className="panel space-y-4 p-5">
        <h2 className="text-sm font-semibold text-[var(--color-accent)]">Solar strings</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Used for the Forecast.Solar production forecast. Azimuth: 0 = south, −90 = east, 90 = west.
        </p>

        {pv.length === 0 && (
          <p className="text-sm text-[var(--color-muted)]">No PV strings yet.</p>
        )}
        <div className="space-y-2">
          {pv.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            >
              <span className="font-medium">{p.name}</span>
              <span className="text-[var(--color-muted)]">{p.kwp} kWp</span>
              <span className="text-[var(--color-muted)]">tilt {p.tilt}°</span>
              <span className="text-[var(--color-muted)]">az {p.azimuth}°</span>
              <form action={deletePv} className="ml-auto">
                <input type="hidden" name="id" value={p.id} />
                <button className="btn" type="submit">
                  Remove
                </button>
              </form>
            </div>
          ))}
        </div>

        <form action={addPv} className="flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4">
          <Field label="Name" name="name" defaultValue="" type="text" />
          <Field label="kWp" name="kwp" defaultValue={3} step="0.1" />
          <Field label="Tilt°" name="tilt" defaultValue={35} step="1" />
          <Field label="Azimuth°" name="azimuth" defaultValue={0} step="1" />
          <button className="btn" type="submit">
            + Add string
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  step,
  type = "number",
}: {
  label: string;
  name: string;
  defaultValue: string | number;
  step?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input w-28" name={name} defaultValue={defaultValue} step={step} type={type} />
    </label>
  );
}
