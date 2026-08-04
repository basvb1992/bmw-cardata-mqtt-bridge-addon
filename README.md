# BMW CarData MQTT Bridge — Home Assistant Add-on Repository

A community-built [Home Assistant](https://www.home-assistant.io/) add-on that streams **BMW CarData** vehicle telemetry (via BMW's official CarData streaming API) into your local **MQTT** broker, with optional Home Assistant **MQTT Discovery** so sensors show up automatically.

> **Unofficial / community project.** Not affiliated with, endorsed by, or supported by BMW Group or Home Assistant. Use at your own risk. You are responsible for complying with BMW's CarData API terms of use.

## What it does

- Authenticates to BMW CarData using the OAuth2 device-code flow (you approve a one-time login link, sent to you via a Home Assistant `notify.*` service).
- Subscribes to your vehicle(s)' telemetry stream from BMW's MQTT broker.
- Republishes that telemetry to your **local** MQTT broker (e.g. Mosquitto), optionally split per-key and with MQTT Discovery config topics so entities appear automatically in Home Assistant.
- Runs entirely inside Home Assistant as a Supervisor-managed add-on — no external scripts, `.env` files, or long-lived access tokens to manage on a separate machine.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories**.
2. Add this URL: `https://github.com/basvb1992/bmw-cardata-mqtt-bridge-addon`
3. Close the dialog — **BMW CarData MQTT Bridge** now appears in the store. Click it → **Install**.
4. See [bmw_mqtt_bridge/README.md](bmw_mqtt_bridge/README.md) for configuration.

## Requirements

- A BMW CarData API client (client ID) — created via BMW's CarData developer portal, tied to your BMW account.
- A local MQTT broker add-on (e.g. **Mosquitto broker**) installed and running.
- A vehicle enrolled in BMW CarData streaming.

## Contributing

Issues and PRs welcome. Please don't include real client IDs, GCIDs, VINs, tokens, or personal notification targets in any issue, PR, or log excerpt you share.

## License

[MIT](LICENSE)
