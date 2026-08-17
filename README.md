# Car Charger Planner

A self-hosted web app that decides **when to charge your EV at home**, optimizing for
**dynamic energy prices** (EPEX via EnergyZero) and **self-consumed solar**
(Forecast.Solar), while respecting **when you're actually home** and a **morning
readiness target** (e.g. "80% by 07:00 on weekdays").

It talks to **Home Assistant** over HA's REST API and drives the charger itself — both
the on/off decision whenever the plan is (re)computed, and the **charging current**,
modulated to follow measured solar surplus so power you'd otherwise export at a poor
feed-in rate goes into the car instead. No HA automation required.

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
- **Never export solar I could have stored.** Exporting pays the market price plus my
  supplier's couple of cents; importing pays that *plus energy tax plus VAT*. Every kWh
  I keep at home is worth ~€0.13 more than the same kWh fed back, so whenever the meter
  says I'm exporting, that power should be going into the car.

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
  recomputed, and sets the charging current to track live solar surplus, rather than
  only displaying a recommendation someone has to act on.
  See [How the plan is computed](#how-the-plan-is-computed) and
  [Home Assistant integration](#home-assistant-integration).
- **One writer to the hardware.** The plan records what it *wants* on `PlanState`; a
  single controller (`controller.ts`) reconciles that with the live meter and is the
  only thing that ever calls HA. A planner and a surplus loop both grabbing at the same
  charger switch would be far worse than a slightly stale current limit.
- **Forecast plans, measurement controls.** The engine schedules from the Forecast.Solar
  prediction, which is the only thing available for tomorrow. But the decision to charge
  from surplus *right now* is made from the measured grid reading — a forecast is not
  allowed to switch the charger on by itself.
- **Home/away is a first-class weekly schedule, not a toggle.** A weekly template
  (per-weekday home windows + a morning deadline/target) plus per-date overrides for
  days that diverge — because a real week isn't "always home" or "always away".
- **Multiple deadlines, not just "the next one".** The scheduler looks across every
  upcoming deadline in the visible horizon and satisfies them in order, so a cheap
  afternoon two days out gets used ahead of an expensive night if that's genuinely
  optimal — see [engine.ts](src/lib/engine.ts).
- **Import and export are priced separately.** Energy tax is a consumption tax and is
  never refunded on export, so the two are not the same number. The app computes both
  per 15-minute slot and values self-consumed solar at the export price you gave up —
  which is what makes surplus the cheapest energy in the plan, always.
- **Read-only signals stay read-only.** Car SoC, PV production and the grid meter are
  pulled from HA purely as inputs; the only things the app writes back are the charger
  on/off command and its current limit.
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
- **Solar surplus charging** — follows the measured grid meter every 30 s and modulates
  the charger current so power you'd otherwise export goes into the car instead. A
  deadline always wins; surplus fills whatever is left up to the max SoC.
- **Correct export pricing** — a separate feed-in price per slot (no energy tax, not
  clamped at zero), so the ~€0.13/kWh gap between importing and exporting is visible to
  the planner rather than assumed away.
- **Charger-connected override** — if HA reports a car physically plugged in, the
  current hour counts as home even if the schedule says away.
- **Direct Home Assistant control** — the app pushes charger on/off to HA via its REST
  API whenever the plan changes, and sets the charging current to track live surplus.
- **Installs as a Home Assistant add-on** — sidebar panel via Ingress, authenticated
  through the Supervisor with no URL or token to configure.
- **Simulation mode** — fast-forward "now" to test the planner at any time of day
  without touching real hardware.

## Tech

Next.js (App Router, TypeScript) · Prisma + SQLite · Tailwind v4 · Vitest. Data refresh,
plan recompute and the 30 s surplus control loop run in-process on intervals via the
Next.js instrumentation hook — no separate scheduler service required (though one can be
split out, see [Architecture](#architecture)).

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
HA_CHARGER_CONNECTED_ENTITY_ID, HA_POWER_SENSOR_ENTITY_ID, HA_CHARGER_POWER_ENTITY_ID,
HA_SOLAR_POWER_ENTITY_ID, HA_CAR_SOC_ENTITY_ID, HA_CHARGER_ON_SERVICE,
HA_CHARGER_OFF_SERVICE, HA_CHARGER_CURRENT_ENTITY_ID, HA_CHARGER_CURRENT_SERVICE,
HA_CHARGER_CURRENT_VALUE_KEY
```

On every boot, [`seedSettingsFromEnv()`](src/lib/bootstrap.ts) copies each value into the
Settings row **only while that field still holds its default**. So the database stays the
source of truth and anything edited in the UI is never overwritten — `.env` is just the
starting point. The boot log names the fields it seeded, never their values.

Keep your real `.env` out of git (it already is, via `.gitignore`): it holds a live
long-lived access token. Revoke it in HA under profile → Security if it ever leaks.

### Only one instance drives the charger

Copying that `.env` into a second checkout would otherwise give two instances working
credentials for the same charger switch, and they would fight over it — one turning it on
as the other turns it off, at up to one write per minute each.

So **switching the real charger is gated on `NODE_ENV=production`**. Docker and the add-on
both set it and behave normally; `npm run dev` computes and displays the plan but sends
nothing to Home Assistant, and the Settings page says so rather than looking configured and
silently doing nothing. Override with `ALLOW_CHARGER_CONTROL=1` (force on, to test control
from a dev copy) or `DISABLE_CHARGER_CONTROL=1` (force off, e.g. a read-only replica —
this one wins if both are set).

The gate sits in `syncChargerState()` ([ha-control.ts](src/lib/ha-control.ts)), the single
point that talks to hardware. `DISABLE_SCHEDULER=1` is *not* a substitute: it only stops the
background timers, while `recomputePlan()` — and therefore a charger push — also runs from
every settings save, timeline edit and manual refresh.

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
   to coordinates + timezone; manual lat/lon override available), import price make-up
   and export price to match your dynamic contract, solar-usable factor, solar surplus
   charging, and Home Assistant connection (see below).
2. **Car & solar** — battery kWh, charger kW, efficiency, and the charger's electrical
   limits (phases, voltage, min/max current); one PV string per roof plane. Get the PV
   kWp right — an undersized array means no surplus slots ever get planned.
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
- **Charger current entity ID** (optional) — the current limit to modulate for solar
  surplus charging; see [Solar surplus charging](#solar-surplus-charging-optional)

For the [custom-components/zaptec](https://github.com/custom-components/zaptec)
integration specifically: point the switch entity ID at the charger's **"Charging"**
switch — the defaults (`switch.turn_on`/`turn_off`) are the recommended interface there
(the `zaptec.stop_charging`/`resume_charging` services are deprecated). One caveat from
their docs: resuming only works if charging was stopped *by a stop command* — not if it
stopped because current was set to 0A, the car hit its target SoC, or the car's own
schedule paused it.

This requires HA to be reachable from wherever the app runs, and the token to have
access to the charger entity. On every controller tick the app compares the desired
on/off state to the last state it successfully pushed and calls HA only on a change — so
it won't spam `turn_on`/`turn_off`. On/off pushes are additionally rate-limited to one
per minute, and current pushes to one per 5 minutes (see
[Solar surplus charging](#solar-surplus-charging-optional)). If a push fails (HA
unreachable, bad token, wrong entity), the error is logged and retried automatically on
the next tick, since the last-pushed marker is only updated on success.

### Solar surplus charging (optional)

Diverts power you'd otherwise export into the car by modulating the charger current,
following the **measured** grid meter rather than a forecast. Enable it under
**Settings → Solar surplus charging** and set three entities:

- **Grid meter entity ID** — must read **positive when importing**, negative when
  exporting (e.g. a HomeWizard P1 meter's active power sensor).
- **Charger power entity ID** — what the car is drawing, in watts. **Required.** The
  grid reading already includes the car, so the controller adds it back out to find the
  household's true surplus. Without it the loop would read its own draw as household
  demand and throttle itself to nothing.
- **Charger current entity ID** — the current limit to write, e.g.
  `number.<charger>_charger_max_current` on a Zaptec. The value is sent as
  `{entity_id, <value key>: amps}` via a configurable service (default
  `number.set_value`), so an integration with a different payload shape works too.

Optionally set a **Solar production entity ID** — shown on the timeline, not used by
the control loop.

Then set the charger's electrical envelope under **Car & solar → Electrical limits**
(phases, voltage, min/max current). This is what converts watts into amps:
`A = W ÷ (phases × voltage)`.

**How it behaves.** A sample is taken every 30 s. Each decision uses the **median** of
the samples in the trailing 5 minutes, so a kettle or an oven can't drag the charge rate
around. A new session waits for surplus to hold for a **start delay** (default 2 min); a
running one rides out dips at the minimum current and only stops after a **stop delay**
(default 10 min), because importing a few hundred watts briefly beats tearing the
session down every time a cloud passes. A **reserve** setting keeps a chosen number of
watts exporting as a buffer. Surplus charging runs only while the cable is connected and
SoC is below the car's max SoC, and a deadline always overrides it — the plan runs at
full power and the grid tops up whatever the sun doesn't cover.

**The current is written to HA at most once every 5 minutes**, with a 1 A deadband.
Vendor cloud APIs (Zaptec's included) throttle callers that change current frequently,
and each change makes the charger renegotiate with the car. The one exception is a ramp
to full power for a deadline, which skips the cooldown so a target slot can't sit at
6 A because a surplus push happened seconds earlier.

> **Mind the minimum.** On **3 phases at 6 A** the smallest charge a car will accept is
> about **4.1 kW**, so surplus charging simply won't engage on a weak solar day. Single
> phase drops that to ~1.4 kW. Zaptec's `zaptec.limit_current` service can force single
> phase via `available_current_phase1/2/3`, but it acts on the whole *installation*
> (every charger on it), so it isn't wired up here.

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
blip can't drop the override mid-session. Checked in the background roughly every minute (and on every manual
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
forecast solar valued at the export price you'd have earned). Charge banked for an
earlier deadline counts
toward later ones (no driving between deadlines is modelled — correct current SoC on the
dashboard). If home hours can't meet a target, the plan is flagged infeasible with the
kWh shortfall.

Because charging is only planned in home windows, the cheapest grid/solar hours are used
**only when you're actually home then** — if you're away every day during the cheap midday
solar, the planner falls back to the cheapest hours it *can* reach (often overnight). If
the charger reports a car physically connected (see below), the current hour counts as
home regardless of the schedule — you're clearly there.

Once deadlines are satisfied, two further passes fill any remaining headroom up to the
car's max SoC, in this order:

1. **Solar surplus.** Slots whose forecast PV on its own clears the charger's minimum
   current are scheduled at whatever current the sun can carry — not full power. These
   cost only the export revenue you gave up, which is *always* less than any grid hour
   (see below), so this pass runs first and is not gated on the cheap-price threshold.
   Only slots the deadline pass left untouched are candidates: a slot already charging
   at full power is self-consuming all of its PV anyway.
2. **Cheap price.** If a `cheapPriceThreshold` is configured, whatever headroom is left
   is filled wherever the effective cost/kWh drops at or below that threshold.

### Why surplus always wins

Importing costs `(EPEX + supplier fee + energy tax) × VAT`. Exporting pays
`(EPEX + supplier fee) × VAT` — the energy tax is a consumption tax and is never
refunded. The difference is the energy tax plus its VAT and is **independent of the
market price**, so with Dutch 2026 defaults every self-consumed kWh is worth a flat
**€0.13** more than the same kWh exported:

| raw EPEX | import | export | premium |
| --- | --- | --- | --- |
| €0.180 | €0.3736 | €0.2420 | €0.1316 |
| €0.080 | €0.2526 | €0.1210 | €0.1316 |
| €0.000 | €0.1558 | €0.0242 | €0.1316 |
| −€0.050 | €0.0953 | **−€0.0363** | €0.1316 |

The export price is deliberately **not** clamped at zero: when the market price goes
negative you *pay* to export, which is exactly when soaking surplus into the car is
worth the most. Set your own numbers under **Settings → Export (feed-in) price**; the
page shows a worked example using whatever you save.

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
                          (deadline pass, then solar-surplus, then cheap-price)
    surplus.ts           Pure live control law: power samples + plan intent -> a charge
                          command (median filtering, start/stop hysteresis)
    plan.ts              Wires engine.ts to the DB — loads state, calls the engine,
                          persists PlanState/ChargeSlot, records the plan's *intent*
    controller.ts        The only thing that drives hardware: reconciles plan intent
                          with the live meter via surplus.ts, persists the decision,
                          pushes it to HA
    refresh.ts           Pulls fresh data: EPEX prices, solar forecast, HA grid/charger/
                          PV power, SoC, charger-connected sensors
    scheduler.ts         In-process interval loop: refresh every 30 min, recompute the
                          plan every 1 min, sample power + run the controller every 30 s
    ha-client.ts          Low-level HA REST client (get entity state, call a service)
    ha-control.ts         applyChargeCommand() — diffs desired vs. last-pushed state,
                           calls HA only on change; on/off throttled to 1/min, current
                           to 1 per 5 min; records PlanState.haSync*/ampsSync*
    energyzero.ts         EPEX day-ahead price fetch (EnergyZero API)
    forecastsolar.ts      PV production forecast (Forecast.Solar API), per PV string
    geocode.ts             Place name -> lat/lon/timezone (Open-Meteo)
    availability.ts         Weekly template + day overrides -> home/away per hour
    pricing.ts, time.ts, now.ts   Import + export price calc, timezone-aware date
                                   helpers, simulated-vs-real "now"
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

**Data flow, once running:** two loops at different speeds meet at the controller.

*Planning (slow).* The scheduler refreshes prices/solar/HA sensors every 30 min
(`refresh.ts`) → `plan.ts` calls the pure engine (`engine.ts`) with the current
settings, weekly/override schedule, and fetched data → the plan is persisted
(`PlanState`, `ChargeSlot`) as **intent**, not as a command. This also runs
synchronously after any settings/schedule change made in the UI, so edits take effect
immediately rather than waiting for the next tick.

*Control (fast).* Every 30 s the scheduler takes one aligned power sample — grid,
charger and PV read together — and calls `controller.ts`, which asks `surplus.ts` what
the charger should be doing, persists the answer, and hands it to `ha-control.ts`.
Plan intent wins whenever a deadline needs the car charged; otherwise the measured
surplus decides.

Both pure modules (`engine.ts`, `surplus.ts`) take no DB, no HA and no clock beyond
their input, which is what makes them unit-testable without any of the surrounding
plumbing; see [engine.test.ts](src/lib/engine.test.ts) and
[surplus.test.ts](src/lib/surplus.test.ts).

**Single-instance app.** Settings/CarConfig/PlanState are singleton rows (`id = 1`) —
this app is built for one household, not multi-tenant use.

## Tests

```bash
npm test      # engine, surplus control, pricing, availability, refresh, HA client/control
```

## Notes / roadmap

- Historical prices accumulate as the app runs (EnergyZero serves today + tomorrow).
- **Get your PV string sizes right.** The planner's solar forecast comes from
  Forecast.Solar and is only as good as the kWp/tilt/azimuth you enter under
  **Car & solar**. An undersized array means forecast surplus never clears the charger's
  minimum current and no surplus slots get planned at all. (The live control loop is
  immune — it uses measured power — but the plan and timeline will be wrong.)
- **No 1/3-phase switching.** On 3 phases the 6 A floor puts the minimum charge at
  ~4.1 kW, so surplus charging can't use a weak solar day. Dropping to single phase
  would extend that down to ~1.4 kW; on Zaptec it means the installation-level
  `zaptec.limit_current` service, which affects every charger on the installation.
- The surplus loop assumes one controllable load. If something else in the house also
  chases surplus (a heat pump, a home battery), the two will compete for the same watts.

## License

[MIT](LICENSE)
