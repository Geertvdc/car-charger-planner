# Changelog

## 0.3.2

- Fixed a deadline/target charging slot commanding the charger on even with no car
  connected — the connected check only ran for solar-surplus decisions, so a plan slot
  could log a charge that never physically happened (shown on the timeline as a hollow
  amber outline for hours you weren't home).
- The timeline now plots measured solar production, not just the forecast. The forecast
  area and the live reading from your solar entity are overlaid on the same graph, with
  the hover tooltip showing both.

## 0.3.1

- Fixed the charger being left on when it resumed a charging session on its own (a
  connectivity blip reconnecting mid-session, the charger's own resume-on-plug-in
  behaviour). The controller only tracked the state it last commanded, so once it
  believed it had already turned the charger off it never noticed the charger was
  charging outside the plan again. It now cross-checks the connected-entity's reported
  state and re-sends the off command when the two disagree.

## 0.3.0

- **Solar surplus charging.** The add-on now follows your grid meter every 30 seconds
  and diverts power you would otherwise export into the car by adjusting the charging
  current. A morning target always wins — while the plan needs the car charged it runs
  at full power and the grid tops up whatever the sun doesn't cover. Off by default;
  enable it under Settings → Solar surplus charging.
- **Export is priced properly.** Energy tax is a consumption tax and is never refunded
  on what you feed back, so exporting a kWh pays far less than importing one costs — on
  a Dutch dynamic contract the gap is a flat ~€0.13/kWh no matter what the market does.
  The planner now works out both prices for every 15-minute slot and treats solar it can
  keep at home as worth that much more. The Settings page shows the difference using
  your own contract numbers.
- Because that gap always favours self-consumption, the planner schedules ahead too:
  once your morning target is covered, remaining room up to the car's max SoC is filled
  from hours the solar forecast expects to cover on its own.
- **Timeline** shows solar-surplus charging as its own colour, and draws your net grid
  power with the exporting part filled in — so the blocks it schedules line up visually
  with the times you are actually feeding back.
- New setup needed for surplus charging: a grid meter entity (positive when importing),
  the charger's own power sensor, and the charger's current-limit entity. Your charger's
  phases, voltage and min/max current move to Car & solar. The current is written to Home
  Assistant at most once every 5 minutes, since charger cloud APIs throttle frequent
  changes.
- Note that on 3 phases at 6 A the smallest charge a car accepts is about 4.1 kW, so
  surplus charging only engages once you are exporting at least that much. Check your PV
  string sizes on Car & solar too — an undersized array means the forecast never predicts
  enough surplus to plan around.

## 0.2.1

- The "Charger right now" tile no longer shows "Charging" for a planned home-window
  slot when connection tracking says the car isn't actually plugged in.
- The background check for "is a car plugged in" now runs every ~1 minute instead of
  every ~5, so the away-schedule override reacts to a plug-in event much faster.

## 0.2.0

- Prices and the charging engine now run on 15-minute slots, matching the day-ahead
  market's quarter-hour granularity, with a graceful fallback to hourly data
  replicated across each slot for as long as EnergyZero's quarter-hour endpoint stays
  empty.
- The dashboard timeline shows real 15-minute resolution and marks slots that are only
  "home" because the charger's plugged in, separately from your actual schedule.
- The "Charger right now" tile reflects what the charger itself reports, not just
  whether this app's own plan scheduled a session.

## 0.1.0

First release as a Home Assistant add-on.

- Runs the planner inside Home Assistant with the UI as a sidebar panel (Ingress).
- Authenticates to Home Assistant through the Supervisor — no URL or long-lived access
  token to configure.
- Entity fields on the Settings page suggest the entities your Home Assistant actually
  has.
- Stores its database on the add-on's `/data` volume, so it is covered by HA backups.
- Removes the old inbound `/api/ha/*` poll endpoints and their token; the app drives the
  charger directly.
