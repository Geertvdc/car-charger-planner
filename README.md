# Car Charger Planner

Self-hosted web app that plans when to charge your EV at home in the Netherlands,
optimizing for **dynamic energy prices** (EPEX via EnergyZero) and **self-consumed
solar** (Forecast.Solar), while respecting **when you're actually home** and a
**morning readiness target** (car X% full by a deadline).

The app is the brain and the active controller: it talks to your **Home Assistant**
instance directly over HA's REST API, pushing the charger on/off decision itself
whenever the plan is (re)computed — no HA automation required. (A legacy poll-based
mode still exists if you'd rather not grant the app write access to HA.)

![dashboard](docs/dashboard.png)

## Features

- **Rolling timeline** — a few days of history + today + tomorrow, showing prices
  (colour-coded), solar forecast, home/away availability, morning deadlines, and the
  planned/actual charging blocks on one shared time axis.
- **Weekly availability template** — e.g. Mon home, Tue/Thu at the office, Wed home
  from 15:00 — plus per-day **overrides** for upcoming days that diverge.
- **Cost + solar aware scheduler** — meets each morning target at the lowest cost using
  home hours only. Flags when a target can't be met before the deadline.
- **Charger-connected override** — if HA reports a car physically plugged in, the
  current hour counts as home even if the schedule says away.
- **Direct Home Assistant control** — the app pushes charger on/off to HA via its REST
  API (`switch.turn_on`/`turn_off` on a configured entity) whenever the plan changes.
  Legacy poll endpoints (`/api/ha/switch`, `/api/ha/state`) remain available as a
  read-only/manual-fallback surface, guarded by a bearer token.

## Tech

Next.js (App Router, TS) · Prisma + SQLite · Tailwind v4 · Vitest. Data refresh + plan
recompute run in-process on an interval (Next instrumentation hook).

## Run locally

```bash
npm install
npx prisma db push      # create the SQLite schema (dev.db)
npm run db:seed         # optional: example weekly pattern + defaults
npm run dev             # http://localhost:3000
```

## Run with Docker

```bash
HA_API_TOKEN=your-secret docker compose up --build
```

- App on `http://<host>:3000`, SQLite persisted in the `charger-data` volume.
- The container runs `prisma db push` on start, then the standalone server.
- Set `HA_API_TOKEN` (compose env) or the token in **Settings** to require auth on the
  legacy HA poll endpoints. Leave empty for an open LAN.
- For direct HA control, set `HA_BASE_URL` / `HA_ACCESS_TOKEN` (compose env) or the
  equivalent fields in **Settings**.

## Configure

1. **Settings** — location (type a place name, e.g. "Uden, Netherlands" — it's geocoded to
   coordinates + timezone; manual lat/lon override available), price make-up to match your
   dynamic contract, solar-usable factor, and Home Assistant connection (see below).
2. **Car & solar** — battery kWh, charger kW, efficiency; one PV string per roof plane.
3. **Weekly schedule** — home windows (simple home/away) + morning target % per weekday.
4. **Upcoming days** — diverge from the template on specific dates (or mark "away").
5. **Dashboard** — hit **Refresh data & plan**.

## Simulation mode

The **🧪 Simulation** bar on the dashboard overrides "now" so you can test the planner at
any time of day without waiting for the real clock. Set an exact date/time, step by
±15 min / ±1 h, and watch the plan, timeline, and charge decision update. The planner and
timeline treat the simulated instant as now — but **pushes to the real charger are
disabled while simulating** (`syncChargerState` no-ops whenever `Settings.simulatedNow`
is set), so testing the plan can never accidentally flip your real hardware. Click
**Back to live** to return to the real clock and resume control. Only today/tomorrow have
price & solar data, so keep the simulated time within that window.

Note: the legacy poll-based mode is *not* covered by this guard — if HA is polling
`/api/ha/state`/`/api/ha/switch` itself, it will still receive the simulated decision.
Prefer direct push control (the default) if you use simulation regularly.

## Home Assistant integration

The app connects to HA as an outbound REST client and pushes control directly — set
these in **Settings**:

- **HA base URL** — e.g. `http://homeassistant.local:8123`
- **HA long-lived access token** — create one in HA under your profile → Security
- **Charger switch entity ID** — the entity ID passed as the service call target, e.g.
  `switch.zaptec_go_2`
- **On/off service** — the HA service called for each action, as `domain.service`.
  Defaults to `switch.turn_on` / `switch.turn_off`; override if your charger's
  integration controls charging differently (e.g. a custom `zaptec.start_charging` /
  `zaptec.stop_charging` service instead of a plain switch). Check your charger's actual
  HA entities/services before relying on the default.
- **Charger status entity ID** (optional) — a read-only sensor for display

For the [custom-components/zaptec](https://github.com/custom-components/zaptec)
integration specifically: point the switch entity ID at the charger's **"Charging"**
switch — the defaults (`switch.turn_on`/`turn_off`) are the recommended interface there
(the `zaptec.stop_charging`/`resume_charging` services are deprecated). One caveat from
their docs: resuming only works if charging was stopped *by a stop command* — not if it
stopped because current was set to 0A, the car hit its target SoC, or the car's own
schedule paused it.

This requires HA to be reachable from wherever the app runs, and the token to have
access to the charger entity. Every time the plan is recomputed (on the ~10 min
scheduler tick, or any settings/schedule change), the app compares the desired on/off
state to the last state it successfully pushed and calls HA only on a change — so it
won't spam `turn_on`/`turn_off` on every tick. If a push fails (HA unreachable, bad
token, wrong entity), the error is logged and retried automatically on the next tick.

### Power meter (optional, read-only)

Set **Power sensor entity ID** to a HomeWizard power entity (e.g. a P1 meter's active
power sensor) exposed via HA. It's read on the regular ~30 min data refresh (or when you
hit **Refresh data & plan**), stored as a `PowerReading`, and shown on the dashboard.
This is display-only — the planning engine still schedules from the Forecast.Solar
prediction, not live readings.

### Car SoC (optional, read-only)

Set **Car SoC entity ID** to a battery-percentage sensor exposed via HA — for VW Group
cars (Cupra, VW, Škoda, SEAT, Audi), the official [EU Data Act
portal](https://eu-data-act.drivesomethinggreater.com/) integration is the recommended
source: sanctioned and stable, but **read-only** with real-world latency of **15–60
min** (data arrives in ~15 min snapshots, but often needs driving/charging activity to
trigger a fresh upload) and no location/ignition data. You need to add that integration
to your own HA instance — this app only reads whatever entity you point it at.

It's read on the regular data refresh, same cadence as prices/solar/power. A reading
only becomes the "current SoC" once the entity's own `last_changed` timestamp actually
advances — a repeated stale poll never overwrites a more recent value, which is what
lets a manual entry (`POST /api/car/soc`) keep working as an override: submit a value
and it stays authoritative until the car itself reports something newer.

### Charger-connected override (optional)

Set **Charger connected entity ID** to a `binary_sensor` that reports whether a car is
physically plugged into the charger (e.g. `binary_sensor.zaptec_go_2_charger`). When it
reads `on`, the planner treats the current hour as home even if your weekly schedule or
an override says away — a plugged-in car is unambiguous evidence you're there. This is
purely a runtime override for the scheduling decision; it doesn't modify your saved
schedule. Checked in the background roughly every 10 minutes (and on every manual
**Refresh data & plan**), not on every interactive save, so it never adds a live HA
round-trip to actions like dragging the target slider.

### Legacy poll-based mode (optional)

If you'd rather not grant the app write access to HA, you can instead have HA poll it
and flip the switch itself. The **Settings** page renders a copy-paste snippet. In short:

```yaml
rest:
  - resource: http://PLANNER_HOST:3000/api/ha/state
    headers:
      Authorization: "Bearer YOUR_TOKEN"
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
          entity_id: switch.my_ev_charger
```

## How the plan is computed

The planner looks across **all upcoming deadlines in the visible horizon** (today +
tomorrow + the following morning), not just the next one. Deadlines are satisfied in
order; each draws on the cheapest still-available home hours in the whole span from now
to that deadline — so a cheap afternoon the day before is used ahead of an expensive
night. Home hours are ranked by **effective cost per kWh** (grid price for the grid part;
forecast solar valued at the feed-in tariff). Charge banked for an earlier deadline counts
toward later ones (no driving between deadlines is modelled — correct current SoC on the
dashboard). If home hours can't meet a target, the plan is flagged infeasible with the
kWh shortfall.

Because charging is only planned in home windows, the cheapest grid/solar hours are used
**only when you're actually home then** — if you're away every day during the cheap midday
solar, the planner falls back to the cheapest hours it *can* reach (often overnight). If
the charger reports a car physically connected (see below), the current hour counts as
home regardless of the schedule — you're clearly there.

## Tests

```bash
npm test      # engine unit tests (cheapest-hours, solar preference, feasibility)
```

## Notes / roadmap

- Current SoC can now be read from a car sensor via HA (see below) as well as entered
  manually — a manual entry still always wins until the car itself reports a newer
  reading.
- HomeWizard power-meter data is read via HA and shown on the dashboard (see below);
  not yet wired into the planning engine — the engine still schedules from the
  Forecast.Solar prediction, not live power readings.
- Charger control is on/off; modulating amps/target-power could be added to the engine
  and the HA push.
- Historical prices accumulate as the app runs (EnergyZero serves today + tomorrow).
