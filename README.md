# Car Charger Planner

A self-hosted web app that decides **when to charge your EV at home**, optimizing for
**dynamic energy prices** (EPEX via EnergyZero) and **self-consumed solar**
(Forecast.Solar), while respecting **when you're actually home** and a **morning
readiness target** (e.g. "80% by 07:00 on weekdays").

It talks to **Home Assistant** over HA's REST API and pushes the charger on/off
decision itself whenever the plan is (re)computed — no HA automation required.

Install it as a **Home Assistant add-on** and it runs inside HA as a sidebar panel with
no connection setup at all, or run it standalone with Docker. See
[Install as a Home Assistant add-on](#install-as-a-home-assistant-add-on).

## Why this exists

I have a dynamic energy contract, solar panels, and an EV, in the Netherlands. The
actual problem is small and specific:

- Charge as much as possible from **cheap grid hours and my own solar**, not whatever
  the wallbox's stock "smart charging" mode decides.
- Guarantee the car is at a **target % by the time I actually need it** the next
  morning — a pure cost-minimizer that ignores deadlines isn't safe to trust unattended.
- Only schedule charging during hours I'm **actually home** — my week isn't the same
  every day (some days at the office, some days home from early afternoon), so "home"
  needs to be a schedule, not a toggle.
- Optionally top up opportunistically when the price is simply very cheap, even without
  a deadline forcing it.

That's the whole problem. Everything in this app is built to solve exactly that, and
nothing more.

## Why not just use evcc?

[evcc](https://evcc.io) is a mature, widely-used open-source EV charge controller and
the right default choice for most people — it supports a large matrix of wallboxes,
inverters, meters, and vehicles out of the box, with no coding required. Before writing
this, that's the obvious alternative to rule out first.

For this use case, it was a worse fit for a few specific reasons:

- **Home Assistant was already the integration hub.** My charger, power meter, and car
  SoC are all HA entities already (via existing HA integrations, e.g.
  [custom-components/zaptec](https://github.com/custom-components/zaptec)). evcc wants
  to own the charger/meter/vehicle integration layer itself; bridging that back through
  HA just to reuse entities I already had was more indirection than value.
- **"Home vs. away" isn't in evcc's model.** evcc plans around price/solar and a target
  SoC/time, but it has no first-class concept of a weekly availability pattern with
  per-day overrides. That's not a minor gap for a household where "home" changes by day
  of the week — it's the actual constraint that makes or breaks a plan, and working
  around its absence would mean building most of this app on top of evcc anyway.
- **Single car, single charger, single home.** evcc's config surface (loadpoints,
  multiple vehicles, multiple meters, tariff adapters, MQTT/EEBus/OCPP wiring) is built
  to be generic across setups. None of that generality was needed here, and a large
  config surface is itself a maintenance cost — every option is something that can be
  misconfigured or need updating when I don't need it.

The short version: evcc solves the general problem well. This app solves one narrow
problem — a single EV, a single home, a weekly presence schedule, and a hard morning
deadline — with a data model and scheduler built around exactly those constraints, and
nothing that isn't. If your setup is more generic (multiple EVs, multiple wallboxes,
no fixed weekly schedule), use evcc instead.

## Design choices

- **Narrow scope over generality.** One car, one charger, one home, one Home Assistant
  instance. No multi-vehicle or multi-loadpoint support — that's a deliberate
  non-goal, not a missing feature.
- **The app is the controller, not just an advisor.** It pushes on/off decisions to HA
  directly (`switch.turn_on`/`turn_off` on a configured entity) whenever the plan is
  recomputed, rather than only displaying a recommendation someone has to act on.
  See [How the plan is computed](#how-the-plan-is-computed) and
  [Home Assistant integration](#home-assistant-integration).
- **Home/away is a first-class weekly schedule, not a toggle.** A weekly template
  (per-weekday home windows + a morning deadline/target) plus per-date overrides for
  days that diverge — because a real week isn't "always home" or "always away".
- **Multiple deadlines, not just "the next one".** The scheduler looks across every
  upcoming deadline in the visible horizon and satisfies them in order, so a cheap
  afternoon two days out gets used ahead of an expensive night if that's genuinely
  optimal — see [engine.ts](src/lib/engine.ts).
- **Solar valued at its real opportunity cost.** Forecast solar is treated as "free"
  minus the feed-in tariff you'd otherwise earn by exporting it — not simply free.
- **Read-only signals stay read-only.** Car SoC and a HomeWizard power reading can be
  pulled from HA for display/estimation, but the only thing the app ever writes back to
  HA is the charger on/off command.
- **A simulation mode that can't touch real hardware.** The dashboard can fast-forward
  "now" to test the planner at any time of day, but pushes to the real charger are
  hard-disabled whenever a simulated time is set — see
  [Simulation mode](#simulation-mode).
- **Boring, self-hostable stack.** Next.js + SQLite in one container, no external
  database, message queue, or cloud dependency beyond the public price/solar/geocoding
  APIs it calls.

## Features

- **Rolling timeline** — a few days of history + today + tomorrow, showing prices
  (colour-coded), solar forecast, home/away availability, morning deadlines, and the
  planned/actual charging blocks on one shared time axis.
- **Weekly availability template** — e.g. Mon home, Tue/Thu at the office, Wed home
  from 15:00 — plus per-day **overrides** for upcoming days that diverge.
- **Cost + solar aware scheduler** — meets each morning target at the lowest cost using
  home hours only, across all upcoming deadlines at once. Flags when a target can't be
  met before the deadline.
- **Opportunistic cheap-price charging** — optionally top up below a configured
  effective cost/kWh even without a deadline forcing it, capped at a max SoC.
- **Charger-connected override** — if HA reports a car physically plugged in, the
  current hour counts as home even if the schedule says away.
- **Direct Home Assistant control** — the app pushes charger on/off to HA via its REST
  API whenever the plan changes.
- **Installs as a Home Assistant add-on** — sidebar panel via Ingress, authenticated
  through the Supervisor with no URL or token to configure.
- **Simulation mode** — fast-forward "now" to test the planner at any time of day
  without touching real hardware.

## Tech

Next.js (App Router, TypeScript) · Prisma + SQLite · Tailwind v4 · Vitest. Data refresh
and plan recompute run in-process on an interval via the Next.js instrumentation hook —
no separate scheduler service required (though one can be split out, see
[Architecture](#architecture)).

## Run locally

```bash
npm install
npx prisma db push      # create the SQLite schema (dev.db)
npm run db:seed         # optional: example weekly pattern + defaults
npm run dev             # http://localhost:3000
```

### Configuration from .env

Settings live in the database, which means a fresh one — a new git worktree, a rebuilt
container, a wiped volume — starts blank and the app silently controls nothing until the
entity IDs are re-entered. To make that reproducible, every Home Assistant field can be
seeded from the environment (see [.env.example](.env.example) for the full list):

```
HA_BASE_URL, HA_ACCESS_TOKEN, HA_CHARGER_SWITCH_ENTITY_ID, HA_CHARGER_STATUS_ENTITY_ID,
HA_CHARGER_CONNECTED_ENTITY_ID, HA_POWER_SENSOR_ENTITY_ID, HA_CAR_SOC_ENTITY_ID,
HA_CHARGER_ON_SERVICE, HA_CHARGER_OFF_SERVICE
```

On every boot, [`seedSettingsFromEnv()`](src/lib/bootstrap.ts) copies each value into the
Settings row **only while that field still holds its default**. So the database stays the
source of truth and anything edited in the UI is never overwritten — `.env` is just the
starting point. The boot log names the fields it seeded, never their values.

Keep your real `.env` out of git (it already is, via `.gitignore`): it holds a live
long-lived access token. Revoke it in HA under profile → Security if it ever leaks.

## Install as a Home Assistant add-on

Requires **Home Assistant OS** or **Supervised** (the Supervisor is what runs add-ons;
HA Container/Core users should use Docker below).

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add
   `https://github.com/Geertvdc/car-charger-planner`.
2. Install **Car Charger Planner**, start it, and enable **Show in sidebar**.

That's the whole setup — no URL, no token. The add-on reaches Home Assistant through the
Supervisor (`homeassistant_api: true`), so it can read your entities and call services
using credentials the Supervisor injects. The entity fields on the **Settings** page
suggest the entities your HA actually has, and its database lives on the add-on's `/data`
volume, so it's covered by Home Assistant backups.

The UI is served through **Ingress**, which means it appears in the HA sidebar and is
protected by HA's own login — nothing is exposed on a host port. See
[Ingress support](#ingress-support) for how that works.

Add-on files live in [`car_charger_planner/`](car_charger_planner/), with
[`repository.yaml`](repository.yaml) making the repo an add-on store. Images are built
for `amd64` and `aarch64` and pushed to GHCR by
[`.github/workflows/addon-build.yml`](.github/workflows/addon-build.yml); bumping
`version` in `car_charger_planner/config.yaml` is what publishes a release.

## Run with Docker

```bash
docker compose up --build
```

- App on `http://<host>:3000`, SQLite persisted in the `charger-data` volume at `/data`.
- The container runs `prisma db push` on start, then the server.
- Set `HA_BASE_URL` / `HA_ACCESS_TOKEN` (compose env) or the equivalent fields in
  **Settings** so it can reach Home Assistant. Create the token in HA under your profile
  → Security → Long-Lived Access Tokens.

## Configure

1. **Settings** — location (type a place name, e.g. "Uden, Netherlands" — it's geocoded
   to coordinates + timezone; manual lat/lon override available), price make-up to
   match your dynamic contract, solar-usable factor, and Home Assistant connection (see
   below).
2. **Car & solar** — battery kWh, charger kW, efficiency; one PV string per roof plane.
3. **Weekly schedule** — home windows (simple home/away) + morning target % per
   weekday.
4. **Upcoming days** — diverge from the template on specific dates (or mark "away").
5. **Dashboard** — hit **Refresh data & plan**.

## Simulation mode

The **🧪 Simulation** bar on the dashboard overrides "now" so you can test the planner at
any time of day without waiting for the real clock. Set an exact date/time, step by
±15 min / ±1 h, and watch the plan, timeline, and charge decision update. The planner
and timeline treat the simulated instant as now — but **pushes to the real charger are
disabled while simulating** (`syncChargerState` no-ops whenever `Settings.simulatedNow`
is set), so testing the plan can never accidentally flip your real hardware. Click
**Back to live** to return to the real clock and resume control. Only today/tomorrow
have price & solar data, so keep the simulated time within that window.

## Home Assistant integration

The app connects to HA as an outbound REST client and pushes control directly.

**Authentication** resolves in this order, first complete pair wins:

1. **HA base URL + token** in **Settings** — an explicit override.
2. `HA_BASE_URL` + `HA_ACCESS_TOKEN` environment variables — for Docker.
3. **The Supervisor token**, injected automatically when running as an add-on. Requests
   go to `http://supervisor/core/api`, and no configuration is needed.

So an add-on install needs nothing, a Docker install needs a long-lived access token
(HA profile → Security), and an add-on can still be pointed at a different HA instance by
filling in the Settings fields. The Settings page reports which of the three is in use.

Then set, in **Settings**:

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

Set **Charger connected entity ID** to an entity reporting whether a car is physically
plugged in. Either shape works: a `binary_sensor` (`on`/`off`), or a charger-mode enum
sensor such as Zaptec's `sensor.<charger>_charger_mode` (`disconnected` /
`connected_requesting` / `connected_charging` / `connected_finished`).

While it reads connected, the planner treats **every away hour from now until your
schedule next says home** as home, even if a weekly rule or an override says away — a
plugged-in car is unambiguous evidence you're there. It opens the whole run rather than
just the current hour because charging has to be planned across a *stretch* of eligible
hours: given one hour at a time the engine can't compare an away evening's prices and
pick the cheapest, or see that a deadline is reachable at all. A later away block (a trip
next week) is untouched. This is purely a runtime override for the scheduling decision;
it doesn't modify your saved schedule.

Do **not** point this at `binary_sensor.<charger>_charger` on the Zaptec integration: it
is `device_class: connectivity`, meaning the charger is online, and reads `on`
permanently — which would cancel your away schedule outright. An `unknown` or
`unavailable` reading leaves the last known value in place, so a momentary Home Assistant
blip can't drop the override mid-session. Checked in the background roughly every 10 minutes (and on every manual
**Refresh data & plan**), not on every interactive save, so it never adds a live HA
round-trip to actions like dragging the target slider.

### Ingress support

Home Assistant serves add-ons under a per-install path like
`/api/hassio_ingress/<token>`, strips that prefix before forwarding, and passes the
original in an `X-Ingress-Path` header. Next.js bakes root-absolute `/_next/...` asset
URLs into its output at build time and `basePath` can't be set per request, so two
pieces close the gap:

- **The app** reads `X-Ingress-Path` ([`src/lib/base-path.ts`](src/lib/base-path.ts)) and
  prefixes what it controls — link hrefs and client-side `fetch` URLs — via a context
  provider. Behind Ingress, navigation falls back to full page loads, because the
  app-router client would otherwise navigate to the prefixed path while the server
  answers for the unprefixed one.
- **A small reverse proxy** ([`src/ingress/`](src/ingress/)) fronts `next start` and
  rewrites what the app can't: `/_next/` URLs in HTML, CSS, JS chunks and flight
  payloads, plus `Link:` preload and `Location:` redirect headers.

The header is untrusted input, so it's validated down to a plain path before being
concatenated into URLs or substituted into response bodies. Without the header the proxy
is a transparent pass-through, which is why the same image serves both the add-on and
plain Docker.

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

If a `cheapPriceThreshold` is configured, any remaining headroom up to a max SoC is
additionally filled opportunistically wherever the effective cost/kWh drops at or below
that threshold, even without a deadline requiring it.

## Architecture

```
src/
  app/                 Next.js App Router — pages (dashboard, settings, schedule,
                        upcoming, config) + server actions (app/actions.ts) + API routes
                        under app/api/ (manual SoC entry, refresh, simulation,
                        day overrides)
  components/          Client-side UI (timeline, stat tiles, simulation bar, nav)
  lib/
    engine.ts           Pure scheduling algorithm: hours + deadlines + config -> PlanResult
    plan.ts              Wires engine.ts to the DB — loads state, calls the engine,
                          persists PlanState/ChargeSlot, syncs the decision to HA
    refresh.ts           Pulls fresh data: EPEX prices, solar forecast, HA power/SoC/
                          charger-connected sensors
    scheduler.ts         In-process interval loop: refresh every 30 min, advance/
                          recompute the plan every 10 min
    ha-client.ts          Low-level HA REST client (get entity state, call a service)
    ha-control.ts         syncChargerState() — diffs desired vs. last-pushed state,
                           calls HA only on change, records PlanState.haSync*
    energyzero.ts         EPEX day-ahead price fetch (EnergyZero API)
    forecastsolar.ts      PV production forecast (Forecast.Solar API), per PV string
    geocode.ts             Place name -> lat/lon/timezone (Open-Meteo)
    availability.ts         Weekly template + day overrides -> home/away per hour
    pricing.ts, time.ts, now.ts   All-in price calc, timezone-aware date helpers,
                                   simulated-vs-real "now"
  ingress/               Reverse proxy fronting `next start` so the app works behind
                          Home Assistant Ingress (rewrite.ts holds the pure URL-rewriting
                          logic; index.ts is the container entrypoint)
  worker/index.ts        Optional standalone entrypoint that just calls
                          startScheduler() — for running the scheduler in a separate
                          container instead of in-process (set DISABLE_SCHEDULER=1 on
                          the web container if you split it out this way)
  instrumentation.ts      Next.js hook: runs once on server boot, ensures the
                          singleton Settings/CarConfig/PlanState rows exist, then
                          starts the in-process scheduler (unless DISABLE_SCHEDULER=1)
prisma/schema.prisma    Data model — see inline comments for every field
car_charger_planner/    Home Assistant add-on manifest (config.yaml, build.yaml, docs,
                         icon/logo); repository.yaml at the repo root makes this repo
                         installable as an add-on store
```

**Data flow, once running:** the scheduler (`scheduler.ts`) refreshes prices/solar/HA
sensors on an interval (`refresh.ts`) → `plan.ts` calls the pure engine (`engine.ts`)
with the current settings, weekly/override schedule, and fetched data → the resulting
plan is persisted (`PlanState`, `ChargeSlot`) → `ha-control.ts` pushes the on/off
decision to Home Assistant if it changed. The same `recomputePlan()` path also runs
synchronously after any settings/schedule change made in the UI, so edits take effect
immediately rather than waiting for the next tick.

The engine itself (`engine.ts`) is deliberately pure — no DB, no HA, no dates outside
its input — which is what makes it unit-testable without any of the surrounding
plumbing; see [engine.test.ts](src/lib/engine.test.ts).

**Single-instance app.** Settings/CarConfig/PlanState are singleton rows (`id = 1`) —
this app is built for one household, not multi-tenant use.

## Tests

```bash
npm test      # engine, availability, refresh, and HA client/control unit tests
```

## Notes / roadmap

- Charger control is on/off; modulating amps/target-power could be added to the engine
  and the HA push.
- Historical prices accumulate as the app runs (EnergyZero serves today + tomorrow).
- HomeWizard power-meter data is read via HA and shown on the dashboard but not yet
  wired into the planning engine — the engine still schedules from the Forecast.Solar
  prediction, not live power readings.

## License

[MIT](LICENSE)
