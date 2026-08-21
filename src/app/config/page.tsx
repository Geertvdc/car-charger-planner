import { prisma } from "@/lib/db";
import { saveCar } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const car = await prisma.carConfig.findUniqueOrThrow({ where: { id: 1 } });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold tracking-tight">Car</h1>

      <form action={saveCar} className="panel space-y-4 p-5">
        <h2 className="text-sm font-semibold text-[var(--color-accent)]">Car &amp; charger</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Battery (kWh)" name="batteryKwh" defaultValue={car.batteryKwh} step="0.1" />
          <Field label="Charger power (kW)" name="chargerPowerKw" defaultValue={car.chargerPowerKw} step="0.1" />
          <Field label="Charge efficiency (0–1)" name="efficiency" defaultValue={car.efficiency} step="0.01" />
          <Field label="Min SoC (%)" name="minSoc" defaultValue={car.minSoc} step="1" />
          <Field label="Max SoC (%)" name="maxSoc" defaultValue={car.maxSoc} step="1" />
        </div>

        <h3 className="pt-1 text-sm font-semibold text-[var(--color-accent)]">
          Electrical limits
        </h3>
        <p className="text-xs text-[var(--color-muted)]">
          Used to turn watts of solar surplus into a charger current: A = W ÷ (phases × voltage).
          The minimum is the IEC 61851 floor of 6 A — below it a car simply won&apos;t draw, so on{" "}
          {car.phases} phase{car.phases === 1 ? "" : "s"} the smallest possible charge is{" "}
          <strong>
            {((car.minCurrentA * car.phases * car.voltage) / 1000).toFixed(1)} kW
          </strong>{" "}
          and the largest is{" "}
          <strong>{((car.maxCurrentA * car.phases * car.voltage) / 1000).toFixed(1)} kW</strong>.
          Surplus charging can&apos;t engage until you are exporting at least the minimum.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Phases" name="phases" defaultValue={car.phases} step="1" />
          <Field label="Voltage (V)" name="voltage" defaultValue={car.voltage} step="1" />
          <Field label="Min current (A)" name="minCurrentA" defaultValue={car.minCurrentA} step="1" />
          <Field label="Max current (A)" name="maxCurrentA" defaultValue={car.maxCurrentA} step="1" />
        </div>
        <button className="btn btn-primary" type="submit">
          Save car
        </button>
      </form>
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
