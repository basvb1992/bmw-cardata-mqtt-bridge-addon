# Changelog

## 1.1.5

- Added hand-curated friendly display names for the ~44 currently-known BMW
  CarData telemetry keys (e.g. `vehicle.drivetrain.lastRemainingRange` now
  shows as "Total Remaining Range" instead of "Last Remaining Range"). Keys
  not yet in the lookup table still fall back to the previous auto-formatted
  name, so newly-discovered parameters keep working without code changes.

## 1.1.4

- Added a `vehicles` option: a repeatable list of `{vin, name}` rows
  (Supervisor renders this as add/remove rows in the Configuration tab), so
  multiple cars can be configured with friendly names (e.g. "X5") instead of
  a single comma-separated `vin` string. MQTT Discovery devices now show up
  in Home Assistant as "BMW <name>" when a name is set.
- The old `vin` option is kept (now optional) for upgraded installs, so
  nobody has to re-enter their VIN(s) after updating - `vehicles` is used
  automatically once at least one row is added.

## 1.1.3

- Added diagnostic logging around the local MQTT broker connection
  (target host/port/SSL, auth source, and connect/reconnect/close/offline
  events), to make silent `connack timeout` failures diagnosable from the
  add-on's Log tab alone.

## 1.1.2

- Fixed a truncated `bridge.js` from a previous release that broke the
  Web UI's always-on startup behavior; restored the `assertConfig()` /
  `startServer()` ordering fix so the Web UI now always starts and shows a
  warning banner listing missing configuration instead of spinning forever.

## 1.1.1

- Fixed an invalid default for `mqtt_port` (`0` failed the `port` schema's
  minimum-value validation, blocking config save for anyone relying on
  Supervisor's MQTT auto-discovery).

## 1.1.0

- Added an Ingress-based configuration Web UI (Info tab → **OPEN WEB UI**)
  for picking which of the ~250 BMW telemetry parameters to publish and
  which `notify.*` service receives the one-time BMW login link, instead of
  hand-typing `include_keys` / `notify_service`.
- `notify_service` is now optional (previously required).

## 1.0.2

- Added manual MQTT broker override options (`mqtt_host`, `mqtt_port`,
  `mqtt_username`, `mqtt_password`, `mqtt_ssl`) for brokers that don't
  register with Supervisor's `services: [mqtt:want]` auto-discovery.
- Fixed the `login_email` schema type, which was blocking config save.

## 1.0.1

- Version bump only (no functional changes).

## 1.0.0

- Initial release: BMW CarData OAuth2 device-code login, streaming
  telemetry bridged to a local MQTT broker (auto-discovered via
  `services: [mqtt:want]`), HA MQTT Discovery, and `include_keys` /
  `exclude_keys` telemetry filtering.
