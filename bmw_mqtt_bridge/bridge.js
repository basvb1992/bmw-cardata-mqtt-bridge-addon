/**
 * BMW CarData -> MQTT bridge, packaged as a local Home Assistant add-on.
 *
 * Unlike the standalone bmw-mqtt-bridge.js in the repo root (meant to run from
 * a dev machine's .env), this version runs *inside* Home Assistant as a
 * Supervisor-managed add-on container, and gets everything it needs from
 * Supervisor instead of manually-managed secrets:
 *
 *  - BMW_CLIENT_ID / BMW_GCID / BMW_VIN / etc. come from the add-on's Options
 *    (Settings > Add-ons > BMW CarData MQTT Bridge > Configuration). Fields
 *    marked "password" in config.yaml's schema are masked in the UI and
 *    stored by Supervisor on the HA host - never in this repo, never in .env.
 *  - The local MQTT broker connection (host/port/user/password) is
 *    auto-injected by Supervisor via `services: [mqtt:want]` in config.yaml -
 *    no broker address ever needs to be entered.
 *  - The one-time BMW login link is sent via Home Assistant's notify service
 *    using the Supervisor-issued SUPERVISOR_TOKEN (from `homeassistant_api:
 *    true`), calling Core's API through the Supervisor proxy at
 *    http://supervisor/core/api - no long-lived HASS_TOKEN needed.
 *
 * BMW OAuth2 tokens are persisted to /data/bmw-bridge-state.json, which is the
 * add-on's persistent data folder (survives add-on restarts/updates).
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const mqtt = require('mqtt');
const { startServer } = require('./server');

const OPTIONS_FILE = '/data/options.json';
const STATE_FILE = '/data/bmw-bridge-state.json';
const DISCOVERED_FILE = '/data/discovered-keys.json';
const WEB_UI_PORT = 8099; // must match config.yaml's ingress_port

function loadOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${OPTIONS_FILE}: ${e.message}`);
    return {};
  }
}

const options = loadOptions();

const config = {
  clientId: options.client_id || '',
  gcid: options.gcid || '',
  vins: String(options.vin || '').split(',').map(v => v.trim()).filter(Boolean),
  loginEmail: options.login_email || '',
  bmwHost: 'customer.streaming-cardata.bmwgroup.com',
  bmwPort: 9000,
  tokenHost: 'customer.bmwgroup.com',
  scope: 'authenticate_user openid cardata:streaming:read',
  // Manual override (mqtt_host set) takes priority over Supervisor's `services:
  // [mqtt:want]` auto-discovery, which is used only as a fallback below. This
  // covers brokers/add-ons that don't register the "mqtt" service with Supervisor.
  localHost: options.mqtt_host || process.env.MQTT_HOST || '',
  localPort: parseInt(options.mqtt_port || process.env.MQTT_PORT || '1883', 10),
  localUser: options.mqtt_username || process.env.MQTT_USERNAME || '',
  localPassword: options.mqtt_password || process.env.MQTT_PASSWORD || '',
  localSsl: options.mqtt_host ? !!options.mqtt_ssl : process.env.MQTT_SSL === 'true',
  localPrefix: options.local_prefix || 'bmw/',
  splitTopics: !!options.split_topics,
  retain: !!options.mqtt_retain,
  discovery: options.mqtt_discovery !== false,
  discoveryPrefix: options.discovery_prefix || 'homeassistant',
  notifyService: options.notify_service || 'mobile_app_bas_prive',
  // Comma-separated key patterns (dotted paths, e.g. "vehicle.drivetrain.batteryManagement.socBms").
  // A trailing "*" matches by prefix, e.g. "vehicle.drivetrain.*". Empty include_keys means
  // "everything is included"; exclude_keys always wins over include_keys.
  includeKeys: String(options.include_keys || '').split(',').map(k => k.trim()).filter(Boolean),
  excludeKeys: String(options.exclude_keys || '').split(',').map(k => k.trim()).filter(Boolean),
  // Auto-injected by Supervisor because config.yaml declares `homeassistant_api: true`.
  supervisorToken: process.env.SUPERVISOR_TOKEN || '',
};

// Returns a list of human-readable problem strings (empty = fully configured).
// Does NOT exit the process - the Web UI server must keep running even when
// config is incomplete, otherwise Ingress has nothing to proxy to and the
// add-on's page just spins forever in the browser.
function getConfigProblems() {
  const missing = [];
  if (!config.clientId) missing.push('client_id (add-on option)');
  if (!config.gcid) missing.push('gcid (add-on option)');
  if (!config.vins.length) missing.push('vin (add-on option)');
  if (!config.localHost) {
    missing.push(
      'MQTT_HOST (no MQTT broker service found via Supervisor auto-discovery, and ' +
        'mqtt_host add-on option is empty - either restart the Mosquitto broker add-on ' +
        'so it re-registers with Supervisor, or fill in mqtt_host/mqtt_port/mqtt_username/' +
        'mqtt_password manually in this add-on\'s Configuration tab)'
    );
  }
  if (!config.supervisorToken) missing.push('SUPERVISOR_TOKEN (homeassistant_api not granted?)');
  return missing;
}

function assertConfig() {
  const missing = getConfigProblems();
  if (missing.length) {
    console.error('Missing required configuration: ' + missing.join(', '));
    return false;
  }
  if (!config.notifyService) {
    log(
      'Note: notify_service is not set - the BMW login link will only appear in this Log, ' +
        'not as a push notification. Set it via this add-on\'s Web UI (or the Configuration tab).'
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Telemetry key discovery (feeds the Web UI's checkbox list)
// ---------------------------------------------------------------------------

function loadDiscoveredKeys() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'))));
  } catch (e) {
    return new Map();
  }
}

// key -> { unit, sample, lastSeen }. Recorded for EVERY key BMW ever sends,
// regardless of include_keys/exclude_keys filtering, so the Web UI can show
// (and let the user re-enable) parameters that are currently excluded.
const discoveredKeyInfo = loadDiscoveredKeys();
let discoveredKeyInfoDirty = false;
