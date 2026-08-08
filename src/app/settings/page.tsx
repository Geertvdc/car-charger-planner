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
          <p className="mb-2 mt-4 text-xs text-[var(--color-muted)]">
            Cheap-price charging: on sunny/low-price hours it can be worth charging the car even with
            no target to reach yet, rather than exporting solar for little or nothing. When an hour&apos;s
            effective cost/kWh drops at or below this threshold, the planner charges opportunistically
            (capped at the car&apos;s Max SoC). Leave blank to disable.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label="Cheap-price threshold (EUR/kWh)"
              name="cheapPriceThresholdPerKwh"
              defaultValue={s.cheapPriceThresholdPerKwh ?? ""}
              step="0.001"
            />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Home Assistant — outbound control (app → HA)
          </h2>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            The app calls your HA instance directly to control the charger. Create a{" "}
            <strong>Long-Lived Access Token</strong> in HA (profile → Security) and paste it below.
            This is separate from the inbound token further down, which only guards the legacy
            poll endpoints.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="HA base URL"
              name="haBaseUrl"
              defaultValue={s.haBaseUrl}
              type="text"
            />
            <Field
              label="HA long-lived access token"
              name="haAccessToken"
              defaultValue={s.haAccessToken}
              type="password"
            />
            <Field
              label="Charger switch entity ID"
              name="haChargerSwitchEntityId"
              defaultValue={s.haChargerSwitchEntityId}
              type="text"
            />
            <Field
              label="Charger status entity ID (optional, read-only)"
              name="haChargerStatusEntityId"
              defaultValue={s.haChargerStatusEntityId}
              type="text"
            />
            <Field
              label="Charger connected entity ID (optional, read-only)"
              name="haChargerConnectedEntityId"
              defaultValue={s.haChargerConnectedEntityId}
              type="text"
            />
          </div>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            When the connected entity reads <code>on</code> (e.g. a Zaptec{" "}
            <code>binary_sensor..._charger</code>), the current hour is treated as home even if
            your schedule says away — a plugged-in car means you&apos;re clearly there. Checked in
            the background every ~10 min, not on every save.
          </p>
          <p className="mb-2 mt-4 text-xs text-[var(--color-muted)]">
            HA service to call for each action, as <code>domain.service</code>. Defaults match a
            plain switch entity — override if your charger integration controls charging
            differently (e.g. a custom <code>zaptec.start_charging</code> service).
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Service to call when starting charging"
              name="haChargerOnService"
              defaultValue={s.haChargerOnService}
              type="text"
            />
            <Field
              label="Service to call when stopping charging"
              name="haChargerOffService"
              defaultValue={s.haChargerOffService}
              type="text"
            />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Home Assistant — power meter (optional, display only)
          </h2>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Reads your HomeWizard power sensor via HA on the regular data refresh and shows the
            latest reading on the dashboard. Not used in the planning engine yet.
          </p>
          <Field
            label="Power sensor entity ID"
            name="haPowerSensorEntityId"
            defaultValue={s.haPowerSensorEntityId}
            type="text"
          />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Home Assistant — car SoC (optional, read-only)
          </h2>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Reads a car battery % sensor via HA (e.g. the official EU Data Act portal
            integration for VW Group cars) on the regular data refresh. Expect real-world
            latency of 15–60 min from that source, not real-time. A reading only replaces the
            current SoC once the entity&apos;s own timestamp actually advances, so a stale repeated
            poll never overwrites a more recent manual entry below.
          </p>
          <Field
            label="Car SoC entity ID"
            name="haCarSocEntityId"
            defaultValue={s.haCarSocEntityId}
            type="text"
          />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Home Assistant — inbound token (legacy poll endpoints)
          </h2>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Only needed if you use the legacy <code>/api/ha/*</code> poll endpoints below instead
            of (or alongside) direct control.
          </p>
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
  const yaml = `# configuration.yaml — optional, only if you'd rather poll than grant write access.
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
        By default the app pushes the charger on/off decision straight to HA using the outbound
        settings above, whenever the plan is (re)computed — no HA automation required. The
        endpoints below are a legacy/manual fallback (send the inbound token as a{" "}
        <code>Bearer</code> header or <code>?token=</code>):
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
