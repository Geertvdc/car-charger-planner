# Changelog

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
