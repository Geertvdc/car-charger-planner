import { prisma } from "@/lib/db";
import { geocodeLocation, saveSettings } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold tracking-tight">Settings</h1>

      <form action={geocodeLocation} className="panel space-y-3 p-5">
        <h2 className="text-sm font-semibold text-[var(--color-accent)]">Location</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Type a place name — it&apos;s geocoded (Open-Meteo) to coordinates + timezone for the solar
          forecast. Currently:{" "}
          <span className="text-[var(--color-text)]">
            {s.locationName || "not set"} ({s.latitude.toFixed(3)}, {s.longitude.toFixed(3)},{" "}
            {s.timezone})
          </span>
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block grow">
            <span className="label">Place name</span>
            <input
              className="input"
              name="locationName"
              type="text"
              placeholder="e.g. Uden, Netherlands"
              defaultValue={s.locationName}
            />
          </label>
          <button className="btn btn-primary" type="submit">
            Set location
          </button>
        </div>
      </form>

      <form action={saveSettings} className="panel space-y-5 p-5">
        <input type="hidden" name="locationName" defaultValue={s.locationName} />
        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Coordinates (manual override)
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Latitude" name="latitude" defaultValue={s.latitude} step="0.0001" />
            <Field label="Longitude" name="longitude" defaultValue={s.longitude} step="0.0001" />
            <Field label="Timezone (IANA)" name="timezone" defaultValue={s.timezone} type="text" />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Price make-up (EUR/kWh)
          </h2>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            All-in price = (raw EPEX + energy tax + supplier fee) × (1 + VAT). Adjust to match your
            dynamic contract (Tibber, Frank, Zonneplan, …).
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="Energy tax" name="energyTaxPerKwh" defaultValue={s.energyTaxPerKwh} step="0.0001" />
            <Field label="Supplier fee" name="supplierFeePerKwh" defaultValue={s.supplierFeePerKwh} step="0.0001" />
            <Field label="VAT rate" name="vatRate" defaultValue={s.vatRate} step="0.01" />
            <Field label="Feed-in tariff" name="feedInTariffPerKwh" defaultValue={s.feedInTariffPerKwh} step="0.0001" />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">Planning</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label="Solar usable factor (0–1)"
              name="houseLoadFactor"
              defaultValue={s.houseLoadFactor}
              step="0.05"
            />
            <Field label="History days shown" name="historyDays" defaultValue={s.historyDays} step="1" />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">Home Assistant</h2>
          <Field
            label="API token (sent by HA as Bearer to /api/ha/*)"
            name="haToken"
            defaultValue={s.haToken}
            type="text"
          />
        </section>

        <button className="btn btn-primary" type="submit">
          Save settings
        </button>
      </form>

      <HaDocs token={s.haToken} />
    </div>
  );
}

function HaDocs({ token }: { token: string }) {
  const t = token.trim() || "YOUR_TOKEN";
  const yaml = `# configuration.yaml — Home Assistant polls the planner and mirrors on/off.
rest:
  - resource: http://PLANNER_HOST:3000/api/ha/state
    headers:
      Authorization: "Bearer ${t}"
    scan_interval: 300
    sensor:
      - name: "Car Charger Planner"
        value_template: "{{ value_json.state }}"     # on | off
        json_attributes: [until, targetSoc, reason, feasible, schedule]

automation:
  - alias: "EV charger follows planner"
    trigger:
      - platform: state
        entity_id: sensor.car_charger_planner
    action:
      - service: "switch.turn_{{ states('sensor.car_charger_planner') }}"
        target:
          entity_id: switch.my_ev_charger   # your charger switch`;

  return (
    <div className="panel space-y-3 p-5">
      <h2 className="text-sm font-semibold text-[var(--color-accent)]">
        Home Assistant integration
      </h2>
      <p className="text-xs text-[var(--color-muted)]">
        The planner is output-only: HA polls it and flips your charger switch. Endpoints (send the
        token above as a <code>Bearer</code> header or <code>?token=</code>):
      </p>
      <ul className="space-y-1 text-xs text-[var(--color-muted)]">
        <li>
          <code className="text-[var(--color-text)]">GET /api/ha/switch</code> → plain{" "}
          <code>on</code>/<code>off</code>
        </li>
        <li>
          <code className="text-[var(--color-text)]">GET /api/ha/state</code> → JSON with{" "}
          <code>state</code>, <code>until</code>, <code>targetSoc</code>, <code>reason</code>,{" "}
          <code>schedule</code>
        </li>
      </ul>
      <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs leading-relaxed text-[var(--color-text)]">
        {yaml}
      </pre>
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
      <input className="input" name={name} defaultValue={defaultValue} step={step} type={type} />
    </label>
  );
}
