# Car Charger Planner

Self-hosted web app that plans when to charge your EV at home in the Netherlands,
optimizing for **dynamic energy prices** (EPEX via EnergyZero) and **self-consumed
solar** (Forecast.Solar), while respecting **when you're actually home** and a
**morning readiness target** (car X% full by a deadline).

The app is the brain; **Home Assistant is output-only** — it polls the app and flips
your charger switch. Nothing is read back from HA.

![dashboard](docs/dashboard.png)

## Features

- **Rolling timeline** — a few days of history + today + tomorrow, showing prices
  (colour-coded), solar forecast, home/away availability, morning deadlines, and the
  planned/actual charging blocks on one shared time axis.
- **Weekly availability template** — e.g. Mon home, Tue/Thu at the office, Wed home
  from 15:00 — plus per-day **overrides** for upcoming days that diverge.
- **Cost + solar aware scheduler** — meets each morning target at the lowest cost using
  guaranteed home hours; "maybe home" hours are used only opportunistically. Flags when
  a target can't be met before the deadline.
- **Home Assistant endpoints** — `/api/ha/switch` (plain `on`/`off`) and `/api/ha/state`
  (JSON with the upcoming schedule), guarded by a bearer token.

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
  HA endpoints. Leave empty for an open LAN.

## Configure

1. **Settings** — location (type a place name, e.g. "Uden, Netherlands" — it's geocoded to
   coordinates + timezone; manual lat/lon override available), price make-up to match your
   dynamic contract, solar-usable factor, HA token.
2. **Car & solar** — battery kWh, charger kW, efficiency; one PV string per roof plane.
3. **Weekly schedule** — home windows (definite / maybe) + morning target % per weekday.
4. **Upcoming days** — diverge from the template on specific dates (or mark "away").
5. **Dashboard** — set current charge %, hit **Refresh data & plan**.

## Simulation mode

The **🧪 Simulation** bar on the dashboard overrides "now" so you can test the planner at
any time of day without waiting for the real clock. Set an exact date/time, step by
±15 min / ±1 h, and watch the plan, timeline, and charge decision update. The planner,
timeline, and **Home Assistant endpoints** all treat the simulated instant as now — hit
**Back to live** before relying on HA for real control. Only today/tomorrow have price &
solar data, so keep the simulated time within that window.

## Home Assistant integration

The **Settings** page renders a copy-paste snippet. In short:

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
forecast solar valued at the feed-in tariff), *definite-home* preferred, *maybe-home*
only to cover a shortfall. Charge banked for an earlier deadline counts toward later ones
(no driving between deadlines is modelled — correct current SoC on the dashboard). If home
hours can't meet a target, the plan is flagged infeasible with the kWh shortfall.

Because charging is only planned in home windows, the cheapest grid/solar hours are used
**only when you're actually home then** — if you're away every day during the cheap midday
solar, the planner falls back to the cheapest hours it *can* reach (often overnight).

## Tests

```bash
npm test      # engine unit tests (cheapest-hours, solar preference, feasibility)
```

## Notes / roadmap

- Current SoC is entered manually (HA is output-only); a car/charger API could replace it.
- Charger control is on/off; modulating amps/target-power could be added to the engine
  and the HA output.
- Historical prices accumulate as the app runs (EnergyZero serves today + tomorrow).
