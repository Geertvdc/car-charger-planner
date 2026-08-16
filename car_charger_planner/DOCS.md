# Car Charger Planner

Plans EV charging around Dutch dynamic energy prices (EPEX via EnergyZero), a solar
production forecast (Forecast.Solar) and your weekly home/away schedule, then starts and
stops the charger through Home Assistant so the car hits its target state of charge by
your morning deadline — as cheaply as possible.

## Installation

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories** and add
   `https://github.com/Geertvdc/car-charger-planner`.
2. Install **Car Charger Planner** from the new repository section.
3. Start the add-on. **Show in sidebar** puts the panel in the left-hand menu.

No URL or access token is required: the add-on talks to Home Assistant through the
Supervisor, using the permission granted by `homeassistant_api` in its configuration.

## First-run setup

Open the panel and work through these once:

| Page | What to set |
| --- | --- |
| **Settings** → Location | Your town — geocoded to coordinates and timezone for the solar forecast. |
| **Settings** → Price make-up | Energy tax, supplier fee and VAT, so prices match your contract (Tibber, Frank, Zonneplan, …). |
| **Settings** → Charger control | The charger's switch entity. The entity fields suggest live entities read from your Home Assistant. |
| **Car & solar** | Battery size, charger power, min/max SoC, and one entry per PV string (kWp, tilt, azimuth). |
| **Weekly schedule** | Per weekday: the deadline time, target SoC, and the hours the car is home. |

Optional entity hookups, all read-only:

- **Charger status** — charging power or state, shown on the dashboard.
- **Charger connected** — an entity reporting whether a cable is plugged in: a
  `binary_sensor` (`on`/`off`) or a charger-mode enum sensor such as Zaptec's
  `sensor.<charger>_charger_mode`. While it reads connected, every away hour from now
  until the schedule next says home counts as home, so the car can charge. Don't use
  `binary_sensor.<charger>_charger` — that one is `device_class: connectivity` (charger
  online) and reads `on` permanently.
- **Car SoC** — a battery-percentage sensor, so the current charge is read automatically
  instead of entered by hand. Expect 15–60 minutes of latency from most car integrations.
- **Power meter** — a P1/HomeWizard power sensor, displayed on the dashboard.

## How it decides

Prices and the solar forecast refresh every 30 minutes; the plan advances every minute.
Each hour is scored on its effective cost — grid price, less the value of solar that
would otherwise be exported — and the cheapest hours that can reach the target before the
deadline are switched on. Solar is discounted by the *usable factor* on the Settings page,
since part of your production is house load rather than car charging.

Set a **cheap-price threshold** to also charge opportunistically: whenever an hour's
effective cost falls at or below it, the car charges even with no target left to reach,
up to the configured maximum SoC. This is what turns a sunny midday into stored range
rather than cheap export.

The dashboard timeline shows the whole picture — prices, forecast solar, availability,
and which hours are scheduled to charge and why. Deadlines and home/away can be adjusted
straight from it for individual days.

## Data and backups

Everything lives in a SQLite database on the add-on's `/data` volume, so it survives
restarts and updates, and is included in Home Assistant backups.

## Troubleshooting

**The panel says it isn't connected to Home Assistant.** Check the add-on log. The
Supervisor connection needs `homeassistant_api: true`, which is set by default — if the
add-on was configured by hand, reinstall it.

**The charger doesn't switch.** Confirm the charger switch entity is correct on the
Settings page. If your charger integration doesn't expose a plain `switch`, override the
service calls at the bottom of that section using `domain.service` notation (for example
`zaptec.start_charging`). Real writes are rate-limited to one per minute so rapid replans
can't chatter a relay; the dashboard shows the last sync and any error.

**Tomorrow's plan is empty.** Day-ahead prices publish in the early afternoon. Until they
land, hours past today can't be planned and the timeline says so.
