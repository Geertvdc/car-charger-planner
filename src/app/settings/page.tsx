import { prisma } from "@/lib/db";
import { geocodeLocation, saveSettings } from "@/app/actions";
import { probeHaConnection, type HaEntitySummary, type HaProbe } from "@/lib/ha-client";

export const dynamic = "force-dynamic";

const ENTITY_LIST_ID = "ha-entities";

export default async function SettingsPage() {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const ha = await probeHaConnection();
  const entities = ha.entities;

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
            Home Assistant — connection
          </h2>
          <HaConnectionNotice probe={ha} />
          <HaLiveReadings
            probe={ha}
            configured={[
              ["Charger switch", s.haChargerSwitchEntityId],
              ["Charger status", s.haChargerStatusEntityId],
              ["Charger connected", s.haChargerConnectedEntityId],
              ["Power meter", s.haPowerSensorEntityId],
              ["Car SoC", s.haCarSocEntityId],
            ]}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="HA base URL (leave blank when running as an add-on)"
              name="haBaseUrl"
              defaultValue={s.haBaseUrl}
              type="text"
            />
            <Field
              label="HA long-lived access token (leave blank when running as an add-on)"
              name="haAccessToken"
              defaultValue={s.haAccessToken}
              type="password"
            />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-accent)]">
            Home Assistant — charger control
          </h2>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            The app calls HA directly to start and stop charging whenever the plan is recomputed —
            no HA automation required.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Charger switch entity ID"
              name="haChargerSwitchEntityId"
              defaultValue={s.haChargerSwitchEntityId}
              type="text"
              list={ENTITY_LIST_ID}
            />
            <Field
              label="Charger status entity ID (optional, read-only)"
              name="haChargerStatusEntityId"
              defaultValue={s.haChargerStatusEntityId}
              type="text"
              list={ENTITY_LIST_ID}
            />
            <Field
              label="Charger connected entity ID (optional, read-only)"
              name="haChargerConnectedEntityId"
              defaultValue={s.haChargerConnectedEntityId}
              type="text"
              list={ENTITY_LIST_ID}
            />
          </div>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            While the connected entity reports a cable is plugged in, every away hour from now
            until your schedule next says home is treated as home, so the car can charge — a
            plugged-in car means you&apos;re clearly there. Accepts a{" "}
            <code>binary_sensor</code> (<code>on</code>/<code>off</code>) or a charger-mode enum
            sensor such as Zaptec&apos;s <code>sensor..._charger_mode</code>. Avoid{" "}
            <code>binary_sensor..._charger</code>: it is <code>device_class: connectivity</code>{" "}
            (the charger is online) and reads <code>on</code> permanently, which would cancel
            your away schedule entirely. Checked in the background every ~10 min.
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
            list={ENTITY_LIST_ID}
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
            list={ENTITY_LIST_ID}
          />
        </section>

        <button className="btn btn-primary" type="submit">
          Save settings
        </button>
      </form>

      <EntityDatalist entities={entities} />
    </div>
  );
}

/**
 * Suggestions for every entity ID field. Rendered once and shared via `list=` —
 * a datalist only suggests, so a hand-typed entity ID still works when HA is
 * unreachable and the list comes back empty.
 */
function EntityDatalist({ entities }: { entities: HaEntitySummary[] }) {
  if (entities.length === 0) return null;
  return (
    <datalist id={ENTITY_LIST_ID}>
      {entities.map((e) => (
        <option key={e.entityId} value={e.entityId}>
          {e.friendlyName}
        </option>
      ))}
    </datalist>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  settings: "the URL and token saved below",
  env: "the HA_BASE_URL / HA_ACCESS_TOKEN environment variables",
  mixed: "a mix of the saved settings and the environment variables",
  supervisor: "the Home Assistant Supervisor (add-on mode)",
};

function HaConnectionNotice({ probe }: { probe: HaProbe }) {
  if (!probe.config) {
    return (
      <p className="mb-2 text-xs text-[#ffb4a2]">
        <strong>Not connected to Home Assistant.</strong> Nothing is configured. Install this as an
        add-on to connect automatically, or fill in the base URL and a{" "}
        <strong>Long-Lived Access Token</strong> (HA profile → Security) below.
      </p>
    );
  }
  if (!probe.ok) {
    return (
      <p className="mb-2 text-xs text-[#ffb4a2]">
        <strong>Home Assistant is not reachable.</strong> Using{" "}
        {SOURCE_LABEL[probe.config.source]} (<code>{probe.config.baseUrl}</code>). {probe.error}
      </p>
    );
  }
  return (
    <p className="mb-2 text-xs text-[var(--color-muted)]">
      <span className="text-[var(--color-accent)]">Connected.</span> Using{" "}
      {SOURCE_LABEL[probe.config.source]} (<code>{probe.config.baseUrl}</code>), reading{" "}
      {probe.entities.length} entities.
    </p>
  );
}

/** Age of an ISO timestamp as a compact "3 h" / "2 d", or null if unparseable. */
function ageLabel(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / (60 * 24))} d ago`;
}

/**
 * What Home Assistant reports *right now* for each configured entity. This is the
 * difference between "the connection is broken" and "the connection is fine but the
 * source entity itself hasn't updated in days" — which look identical from the
 * dashboard, since a reading is only stored once the entity's own timestamp advances.
 */
function HaLiveReadings({
  probe,
  configured,
}: {
  probe: HaProbe;
  configured: [string, string][];
}) {
  if (!probe.ok) return null;
  const rows = configured.filter(([, entityId]) => entityId.trim() !== "");
  if (rows.length === 0) return null;
  const byId = new Map(probe.entities.map((e) => [e.entityId, e]));

  return (
    <div className="mb-3 overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">
        Live values from Home Assistant
      </div>
      <table className="w-full text-xs text-[var(--color-muted)]">
        <tbody>
          {rows.map(([label, entityId]) => {
            const entity = byId.get(entityId.trim());
            const age = entity ? ageLabel(entity.lastChanged) : null;
            return (
              <tr key={label}>
                <td className="py-0.5 pr-3 whitespace-nowrap">{label}</td>
                <td className="py-0.5 pr-3">
                  <code>{entityId}</code>
                </td>
                <td className="py-0.5 pr-3 whitespace-nowrap">
                  {entity ? (
                    <span className="text-[var(--color-text)]">{entity.state}</span>
                  ) : (
                    <span className="text-[#ffb4a2]">no such entity in HA</span>
                  )}
                </td>
                <td className="py-0.5 whitespace-nowrap">{age ? `changed ${age}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  step,
  type = "number",
  list,
}: {
  label: string;
  name: string;
  defaultValue: string | number;
  step?: string;
  type?: string;
  list?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="input"
        name={name}
        defaultValue={defaultValue}
        step={step}
        type={type}
        list={list}
      />
    </label>
  );
}
