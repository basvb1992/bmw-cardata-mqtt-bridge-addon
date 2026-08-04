# BMW CarData MQTT Bridge (Home Assistant add-on)

Runs the BMW CarData → MQTT bridge **inside Home Assistant** as a Supervisor-managed
add-on.

| Concern | Standalone script + `.env` | This add-on |
|---|---|---|
| `client_id` / GCID storage | Plaintext in `.env` on whatever machine runs it | Masked (`password` schema) add-on option, stored by Supervisor on the HA host |
| MQTT broker credentials | Manually entered in `.env` | Auto-injected by Supervisor (`services: [mqtt:want]`), with manual override available — never hardcoded |
| HA API access (login notification) | Manually-created long-lived access token | Short-lived `SUPERVISOR_TOKEN`, auto-issued and rotated by Supervisor |
| Uptime | Only while some external machine happens to be on and the script running | Runs continuously, managed by Supervisor, restarts with HA |

## Configuration

| Option | Required | Description |
|---|---|---|
| `client_id` | Yes | Your BMW CarData API client ID (create one via BMW's CarData developer portal — search "BMW CarData API client registration"). Masked in the UI. |
| `gcid` | Yes | Your BMW GCID (account identifier). Masked in the UI. |
| `vin` | Yes | Vehicle VIN(s), comma-separated for multiple vehicles. |
| `login_email` | No | Only needed if BMW's MQTT username isn't just your GCID. |
| `notify_service` | No | The Home Assistant `notify.*` service (without the `notify.` prefix, e.g. `mobile_app_yourphone`) used to send the one-time BMW login link. Easiest to set from the **Web UI** (see below) instead of typing it here — without it the login link only shows up in the Log. |
| `discovery_prefix` | No | MQTT Discovery prefix, default `homeassistant`. |
| `local_prefix` | No | Local MQTT topic prefix for published telemetry, default `bmw/`. |
| `mqtt_discovery` | No | Enable Home Assistant MQTT Discovery, default `true`. |
| `split_topics` | No | Publish each telemetry key to its own sub-topic, default `false`. |
| `mqtt_retain` | No | Retain published MQTT messages, default `false`. |
| `include_keys` | No | Comma-separated telemetry key whitelist (see below). Empty = include everything. Easiest to manage from the **Web UI** (see below). |
| `exclude_keys` | No | Comma-separated telemetry key blacklist (see below). Always wins over `include_keys`. |
| `mqtt_host` / `mqtt_port` / `mqtt_username` / `mqtt_password` / `mqtt_ssl` | No | Manual MQTT broker override (see below). Leave `mqtt_host` empty to use Supervisor auto-discovery. |

## Web UI: picking parameters and the notification device

BMW CarData can stream up to ~250 telemetry parameters, and most people don't know their
exact dotted key names up front — so instead of hand-typing `include_keys`, this add-on
ships a small configuration Web UI (Home Assistant Ingress, so no extra login or exposed
port — it opens right inside the HA frontend).

To open it: once the add-on is started, go to its **Info** tab and click **OPEN WEB UI**
(this button appears automatically because `config.yaml` sets `ingress: true`).

What it does:
- **Login notification device** — a dropdown of your instance's actual `notify.*`
  services (fetched live from Home Assistant), instead of typing a service name by hand.
- **Telemetry parameters** — a searchable, checkbox list of every parameter the bridge
  has seen so far, grouped by category (e.g. `vehicle.drivetrain`, `vehicle.cabin`).
  Parameters appear here **live** as your car sends them — there's no fixed "first run"
  discovery window, so if something you expect is missing, drive around a bit and check
  back; the page polls for new parameters automatically without needing a reload.
- **Save & restart add-on** — writes your selections back to the add-on's own options
  (via the Supervisor API) and restarts the container so they take effect immediately.

The manual `include_keys` / `exclude_keys` options in the Configuration tab still work
exactly as before — they're useful for power users, scripting, or ALM-style config — the
Web UI is just a friendlier way to manage the same `include_keys` setting under the hood.

## "MQTT_HOST" error even though your broker is running

`services: [mqtt:want]` only auto-wires the broker connection if the broker add-on has
actively **registered** itself as the "mqtt" service with Supervisor — the official
**Mosquitto broker** add-on does this, but only on (re)start, and only while it's actually
running. If you still get a missing `MQTT_HOST` error with your broker showing as started:

1. Restart the **Mosquitto broker** add-on first, then restart **this** add-on —
   Supervisor only injects `MQTT_HOST`/etc. at container start, so the bridge needs to
   (re)start *after* the broker has re-registered.
2. Confirm Settings → Devices & Services shows an **MQTT** integration — if that's
   missing too, the broker isn't registering properly with Supervisor/Core.
3. If it still doesn't pick up automatically, bypass auto-discovery entirely by filling in
   `mqtt_host` (e.g. `core-mosquitto` or your broker's hostname/IP), `mqtt_port` (default
   `1883`), and `mqtt_username`/`mqtt_password`/`mqtt_ssl` if required, in the
   Configuration tab. Any non-empty `mqtt_host` always takes priority over auto-discovery.

## Filtering telemetry (`include_keys` / `exclude_keys`) — advanced/manual option

By default BMW streams every telemetry key your CarData client is authorized for, and the
bridge publishes/discovers all of them. If you only care about a subset (e.g. just battery
and doors), you can filter which keys get published to MQTT — this also reduces the number
of entities Home Assistant discovers. Most people should use the **Web UI** above instead;
this section is for scripting/automation scenarios where editing YAML options directly is
preferred.

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
4. Open the **Web UI** (Info tab → **OPEN WEB UI**) to pick your notification device and telemetry parameters — or set `notify_service` manually in the Configuration tab if you prefer.
5. On first run you'll get a push notification (via your configured `notify_service`, if set — otherwise check the Log) with a one-time BMW login link — tap it and log in with your BMW account to authorize CarData streaming.
6. Once authorized, telemetry starts flowing to your local MQTT broker, and (if `mqtt_discovery` is enabled) entities appear automatically in Home Assistant.

## Notes

- OAuth tokens are persisted to the add-on's own `/data` volume, which survives add-on restarts and updates.
- `homeassistant_api: true` and `services: [mqtt:want]` in `config.yaml` are what make the auto-injection of `SUPERVISOR_TOKEN` and `MQTT_HOST`/`MQTT_PORT`/`MQTT_USERNAME`/`MQTT_PASSWORD` happen — no manual token or broker config needed.
- `ingress: true` / `ingress_port: 8099` is what makes the **OPEN WEB UI** button appear; there is no exposed container port, so the Web UI is only reachable through that authenticated HA frontend button, never directly from the network.
- Discovered telemetry parameter metadata (name/unit/last sample) is persisted to the add-on's own `/data/discovered-keys.json`, alongside the OAuth token state file, so the Web UI's checkbox list survives add-on restarts too.
- Default `arch` in `config.yaml` is `aarch64` + `amd64` (the two most common HAOS hosts). Add `armv7`/`armhf`/`i386` there if your host needs one of those.
