# Changelog

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
