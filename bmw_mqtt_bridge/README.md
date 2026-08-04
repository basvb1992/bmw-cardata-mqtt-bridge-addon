# BMW CarData MQTT Bridge (Home Assistant add-on)

Runs the BMW CarData → MQTT bridge **inside Home Assistant** as a Supervisor-managed
add-on.

| Concern | Standalone script + `.env` | This add-on |
|---|---|---|
| `client_id` / GCID storage | Plaintext in `.env` on whatever machine runs it | Masked (`password` schema) add-on option, stored by Supervisor on the HA host |
| MQTT broker credentials | Manually entered in `.env` | Auto-injected by Supervisor (`services: [mqtt:want]`) — never entered anywhere |
| HA API access (login notification) | Manually-created long-lived access token | Short-lived `SUPERVISOR_TOKEN`, auto-issued and rotated by Supervisor |
| Uptime | Only while some external machine happens to be on and the script running | Runs continuously, managed by Supervisor, restarts with HA |

## Configuration

| Option | Required | Description |
|---|---|---|
| `client_id` | Yes | Your BMW CarData API client ID (create one via BMW's CarData developer portal — search "BMW CarData API client registration"). Masked in the UI. |
| `gcid` | Yes | Your BMW GCID (account identifier). Masked in the UI. |
| `vin` | Yes | Vehicle VIN(s), comma-separated for multiple vehicles. |
| `login_email` | No | Only needed if BMW's MQTT username isn't just your GCID. |
| `notify_service` | Yes | The Home Assistant `notify.*` service (without the `notify.` prefix, e.g. `mobile_app_yourphone`) used to send the one-time BMW login link. |
| `discovery_prefix` | No | MQTT Discovery prefix, default `homeassistant`. |
| `local_prefix` | No | Local MQTT topic prefix for published telemetry, default `bmw/`. |
| `mqtt_discovery` | No | Enable Home Assistant MQTT Discovery, default `true`. |
| `split_topics` | No | Publish each telemetry key to its own sub-topic, default `false`. |
| `mqtt_retain` | No | Retain published MQTT messages, default `false`. |
| `include_keys` | No | Comma-separated telemetry key whitelist (see below). Empty = include everything. |
| `exclude_keys` | No | Comma-separated telemetry key blacklist (see below). Always wins over `include_keys`. |

## Filtering telemetry (`include_keys` / `exclude_keys`)

By default BMW streams every telemetry key your CarData client is authorized for, and the
bridge publishes/discovers all of them. If you only care about a subset (e.g. just battery
and doors), you can filter which keys get published to MQTT — this also reduces the number
of entities Home Assistant discovers.

Both options take a **comma-separated list of dotted key patterns**, matched against the
telemetry key names BMW sends (e.g. `vehicle.drivetrain.batteryManagement.socBms`). A
trailing `*` matches by prefix.

- `include_keys` — whitelist. If set, **only** matching keys are published; everything
  else is dropped. Leave empty to include everything.
- `exclude_keys` — blacklist. Matching keys are always dropped, even if they also match
  `include_keys`. Applied after `include_keys`.

Examples:
- `include_keys: "vehicle.drivetrain.*,vehicle.doorsGeneralState"` → only drivetrain
  telemetry plus the doors state.
- `exclude_keys: "vehicle.cabin.*"` → publish everything except cabin sensors.

## Setup

1. Make sure the **Mosquitto broker** add-on (or another local MQTT broker) is installed and started — required for `services: [mqtt:want]` to auto-wire the broker connection.
2. Fill in the Configuration tab (see table above) and **Save**.
3. **Start** the add-on and open the **Log** tab.
4. On first run you'll get a push notification (via your configured `notify_service`) with a one-time BMW login link — tap it and log in with your BMW account to authorize CarData streaming.
5. Once authorized, telemetry starts flowing to your local MQTT broker, and (if `mqtt_discovery` is enabled) entities appear automatically in Home Assistant.

## Notes

- OAuth tokens are persisted to the add-on's own `/data` volume, which survives add-on restarts and updates.
- `homeassistant_api: true` and `services: [mqtt:want]` in `config.yaml` are what make the auto-injection of `SUPERVISOR_TOKEN` and `MQTT_HOST`/`MQTT_PORT`/`MQTT_USERNAME`/`MQTT_PASSWORD` happen — no manual token or broker config needed.
- Default `arch` in `config.yaml` is `aarch64` + `amd64` (the two most common HAOS hosts). Add `armv7`/`armhf`/`i386` there if your host needs one of those.
