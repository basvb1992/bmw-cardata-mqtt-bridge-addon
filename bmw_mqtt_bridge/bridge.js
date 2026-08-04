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

// "vehicles" (list of {vin, name}) is the current way to configure cars - Supervisor
// renders it as add/remove rows in the Configuration tab. Falls back to the older
// comma-separated "vin" text option (no friendly names) for installs upgraded from
// before this existed, so nobody has to re-enter their VIN after updating.
const vehiclesOption = Array.isArray(options.vehicles) ? options.vehicles : [];
const legacyVins = String(options.vin || '').split(',').map(v => v.trim()).filter(Boolean);
const vehicles = vehiclesOption.length
  ? vehiclesOption
  : legacyVins.map(vin => ({ vin, name: '' }));

const config = {
  clientId: options.client_id || '',
  gcid: options.gcid || '',
  vins: vehicles.map(v => v.vin).filter(Boolean),
  // vin -> friendly name (e.g. "X5"), only for vehicles where a name was given.
  vehicleNames: new Map(vehicles.filter(v => v.vin && v.name).map(v => [v.vin, v.name])),
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
  if (!config.vins.length) missing.push('vehicles (add at least one vehicle with its VIN, in the add-on\'s Configuration tab)');
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

function recordDiscoveredKey(key, value) {
  const isObj = value && typeof value === 'object';
  const unit = isObj && 'unit' in value ? value.unit : undefined;
  const sample = isObj && 'value' in value ? value.value : value;
  const existing = discoveredKeyInfo.get(key);
  discoveredKeyInfo.set(key, {
    unit: unit !== undefined ? unit : existing && existing.unit,
    sample,
    lastSeen: new Date().toISOString(),
  });
  discoveredKeyInfoDirty = true;
}

function flushDiscoveredKeys() {
  if (!discoveredKeyInfoDirty) return;
  discoveredKeyInfoDirty = false;
  try {
    fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(Object.fromEntries(discoveredKeyInfo), null, 2));
  } catch (e) {
    log('Could not persist discovered-keys.json:', e.message);
  }
}

setInterval(flushDiscoveredKeys, 15000);

function getDiscoveredKeyList() {
  return Array.from(discoveredKeyInfo.entries()).map(([key, info]) => ({ key, ...info }));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateVerifier() {
  return base64url(crypto.randomBytes(32));
}

function generateChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

// ---------------------------------------------------------------------------
// BMW OAuth2 (device authorization grant)
// ---------------------------------------------------------------------------

function postForm(hostname, urlPath, formObj) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(formObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (e) {
            reject(new Error(`Non-JSON response (status ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// Calls Home Assistant's Core API through the Supervisor proxy, authenticated
// with the auto-injected, Supervisor-managed SUPERVISOR_TOKEN (no long-lived
// token to create/store/rotate ourselves).
async function haNotify(title, message, data) {
  const body = JSON.stringify(data ? { title, message, data } : { title, message });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'supervisor',
        path: `/core/api/services/notify/${config.notifyService}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.supervisorToken}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let resData = '';
        res.on('data', c => (resData += c));
        res.on('end', () => resolve({ status: res.statusCode, data: resData }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function startDeviceCodeFlow() {
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);

  const { json: device } = await postForm(config.tokenHost, '/gcdm/oauth/device/code', {
    client_id: config.clientId,
    response_type: 'device_code',
    scope: config.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  if (!device.device_code) {
    throw new Error('Device code request failed: ' + JSON.stringify(device));
  }

  const loginUrl = device.verification_uri_complete || `${device.verification_uri}?user_code=${device.user_code}`;
  const expiresMin = Math.floor((device.expires_in || 600) / 60);
  if (config.notifyService) {
    log('BMW login required. Sending link via HA notify.' + config.notifyService);
    await haNotify(
      'BMW CarData: login required',
      `Tap this notification to open the BMW login page (valid ${expiresMin} min).\n` +
        `If prompted for a code, enter: ${device.user_code}`,
      {
        url: loginUrl,
        clickAction: loginUrl,
        actions: [{ action: 'URI', title: 'Copy code', uri: `clipboard://${device.user_code}` }],
      }
    );
    log('Verification link sent. Waiting for you to complete login...');
  } else {
    log('BMW login required. Set notify_service (Web UI or Configuration tab) to get this as a push notification.');
  }
  log(loginUrl);
  log('If prompted for a code on the BMW page, enter:', device.user_code);

  const intervalMs = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 600) * 1000;
  let currentInterval = intervalMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, currentInterval));
    const { json: tok } = await postForm(config.tokenHost, '/gcdm/oauth/token', {
      client_id: config.clientId,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      code_verifier: verifier,
    });

    if (tok.access_token) {
      const state = {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        id_token: tok.id_token,
        expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
      };
      saveState(state);
      log('BMW login successful. Tokens saved to', STATE_FILE);
      if (config.notifyService) {
        await haNotify('BMW CarData', 'Login successful, bridge is starting.');
      }
      return state;
    }

    if (tok.error === 'authorization_pending') continue;
    if (tok.error === 'slow_down') {
      currentInterval += 5000;
      continue;
    }
    throw new Error('Device code flow failed: ' + JSON.stringify(tok));
  }

  throw new Error('BMW login timed out (device code expired before login was completed)');
}

async function refreshTokens(state) {
  const { json: tok } = await postForm(config.tokenHost, '/gcdm/oauth/token', {
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: state.refresh_token,
  });
  if (!tok.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(tok));
  }
  const newState = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || state.refresh_token,
    id_token: tok.id_token || state.id_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  saveState(newState);
  log('BMW tokens refreshed, expires', new Date(newState.expires_at).toISOString());
  return newState;
}

async function ensureAuthenticated() {
  let state = loadState();
  if (!state || !state.refresh_token) {
    return startDeviceCodeFlow();
  }
  try {
    return await refreshTokens(state);
  } catch (e) {
    log('Stored refresh token no longer valid, restarting login flow:', e.message);
    return startDeviceCodeFlow();
  }
}

// ---------------------------------------------------------------------------
// MQTT bridge
// ---------------------------------------------------------------------------

let bmwClient = null;
let localClient = null;
let refreshTimer = null;
const discoveredKeys = new Map(); // vin -> Set<key>

function buildBmwUsername() {
  if (config.loginEmail) return `${config.gcid}/${config.loginEmail}`;
  return config.gcid;
}

function sanitizeId(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Matches `key` against a pattern; a trailing "*" means "starts with".
function matchesPattern(key, pattern) {
  if (pattern.endsWith('*')) {
    return key.startsWith(pattern.slice(0, -1));
  }
  return key === pattern;
}

// Whitelist (include_keys) is applied first if non-empty, then blacklist
// (exclude_keys) is applied on top and always wins.
function keyAllowed(key) {
  if (config.includeKeys.length && !config.includeKeys.some(p => matchesPattern(key, p))) {
    return false;
  }
  if (config.excludeKeys.some(p => matchesPattern(key, p))) {
    return false;
  }
  return true;
}

// Hand-curated display names for BMW CarData telematic keys (technicalDescriptors).
// BMW's own descriptions live in the Telematics Data Catalogue, which is only
// accessible from inside the (authenticated) customer portal - there is no public
// per-key reference to pull from - so these are best-effort, sensible names based on
// what each key represents. NOT exhaustive: BMW CarData exposes ~250 possible keys in
// total; any key not listed here just falls back to auto-formatting its last path
// segment (e.g. "isRemoteEngineRunning" -> "Is Remote Engine Running"). Add more
// entries here as you enable additional keys via include_keys / the Web UI.
const KEY_DISPLAY_NAMES = {
  // vehicle.body
  'vehicle.body.hood.isOpen': 'Hood Open',
  'vehicle.body.trunk.door.isOpen': 'Trunk Door Open',
  'vehicle.body.trunk.isOpen': 'Trunk Open',
  'vehicle.body.trunk.lower.door.isOpen': 'Trunk Lower Door Open',
  'vehicle.body.trunk.upper.door.isOpen': 'Trunk Upper Door Open',
  // vehicle.cabin
  'vehicle.cabin.door.row1.driver.isOpen': 'Front Driver Door Open',
  'vehicle.cabin.door.row1.passenger.isOpen': 'Front Passenger Door Open',
  'vehicle.cabin.door.row2.driver.isOpen': 'Rear Driver-Side Door Open',
  'vehicle.cabin.door.row2.passenger.isOpen': 'Rear Passenger-Side Door Open',
  'vehicle.cabin.door.status': 'Doors Status',
  'vehicle.cabin.infotainment.navigation.currentLocation.altitude': 'Altitude',
  'vehicle.cabin.infotainment.navigation.currentLocation.heading': 'Heading',
  'vehicle.cabin.infotainment.navigation.currentLocation.latitude': 'Latitude',
  'vehicle.cabin.infotainment.navigation.currentLocation.longitude': 'Longitude',
  'vehicle.cabin.sunroof.overallStatus': 'Sunroof Overall Status',
  'vehicle.cabin.sunroof.status': 'Sunroof Status',
  'vehicle.cabin.sunroof.tiltStatus': 'Sunroof Tilt Status',
  'vehicle.cabin.window.row1.driver.status': 'Front Driver Window Status',
  'vehicle.cabin.window.row1.passenger.status': 'Front Passenger Window Status',
  'vehicle.cabin.window.row2.driver.status': 'Rear Driver-Side Window Status',
  'vehicle.cabin.window.row2.passenger.status': 'Rear Passenger-Side Window Status',
  // vehicle.chassis
  'vehicle.chassis.axle.row1.wheel.left.tire.pressure': 'Front Left Tire Pressure',
  'vehicle.chassis.axle.row1.wheel.right.tire.pressure': 'Front Right Tire Pressure',
  'vehicle.chassis.axle.row2.wheel.left.tire.pressure': 'Rear Left Tire Pressure',
  'vehicle.chassis.axle.row2.wheel.right.tire.pressure': 'Rear Right Tire Pressure',
  // vehicle.drivetrain
  'vehicle.drivetrain.avgElectricRangeConsumption': 'Average Electric Consumption',
  'vehicle.drivetrain.electricEngine.charging.isSingleImmediateCharging': 'Immediate Charging Active',
  'vehicle.drivetrain.electricEngine.charging.profile.climatizationActive': 'Charging Profile Climatization Active',
  'vehicle.drivetrain.electricEngine.charging.profile.isRcpConfigComplete': 'Charging Profile Configured',
  'vehicle.drivetrain.electricEngine.charging.profile.timerType': 'Charging Timer Type',
  'vehicle.drivetrain.electricEngine.charging.status': 'Charging Status',
  'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange': 'Remaining Electric Range (Instrument Cluster)',
  'vehicle.drivetrain.fuelSystem.level': 'Fuel Level',
  'vehicle.drivetrain.fuelSystem.remainingFuel': 'Remaining Fuel',
  'vehicle.drivetrain.lastRemainingRange': 'Total Remaining Range',
  // vehicle.powertrain
  'vehicle.powertrain.electric.battery.stateOfCharge.target': 'Charging Target (State of Charge)',
  // vehicle.vehicle
  'vehicle.vehicle.avgSpeed': 'Average Speed',
  'vehicle.vehicle.preConditioning.activity': 'Preconditioning Activity',
  'vehicle.vehicle.preConditioning.error': 'Preconditioning Error',
  'vehicle.vehicle.preConditioning.isRemoteEngineRunning': 'Remote Engine Running',
  'vehicle.vehicle.preConditioning.isRemoteEngineStartAllowed': 'Remote Engine Start Allowed',
  'vehicle.vehicle.preConditioning.remainingTime': 'Preconditioning Remaining Time',
  'vehicle.vehicle.timeSetting': 'Time Setting',
  'vehicle.vehicle.travelledDistance': 'Odometer',
};

function friendlyName(key) {
  if (KEY_DISPLAY_NAMES[key]) return KEY_DISPLAY_NAMES[key];
  const last = key.split('.').pop();
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

function publishDiscovery(vin, key, value, stateTopic) {
  let vinKeys = discoveredKeys.get(vin);
  if (!vinKeys) {
    vinKeys = new Set();
    discoveredKeys.set(vin, vinKeys);
  }
  if (vinKeys.has(key)) return;
  vinKeys.add(key);

  const objectId = `bmw_${sanitizeId(vin)}_${sanitizeId(key)}`;
  const hasValueField = value && typeof value === 'object' && 'value' in value;
  const discoveryConfig = {
    name: friendlyName(key),
    unique_id: objectId,
    state_topic: stateTopic,
    value_template: hasValueField ? '{{ value_json.value }}' : '{{ value }}',
    device: {
      identifiers: [`bmw_${sanitizeId(vin)}`],
      // Uses the friendly name from the "vehicles" option (e.g. "BMW X5") if one
      // was given for this VIN, otherwise falls back to the raw VIN.
      name: config.vehicleNames.get(vin) ? `BMW ${config.vehicleNames.get(vin)}` : `BMW ${vin}`,
      manufacturer: 'BMW',
      model: 'CarData',
    },
  };
  if (hasValueField && value.unit) {
    discoveryConfig.unit_of_measurement = value.unit;
  }

  const configTopic = `${config.discoveryPrefix}/sensor/${objectId}/config`;
  localClient.publish(configTopic, JSON.stringify(discoveryConfig), { retain: true });
}

function publishLocal(vin, payload) {
  const baseTopic = `${config.localPrefix}${vin}`;
  const opts = { retain: config.retain };

  // Apply include_keys/exclude_keys filtering to payload.data before publishing
  // anything, so excluded parameters never reach MQTT (base topic included).
  let outgoing = payload;
  if (payload && typeof payload.data === 'object') {
    const filteredEntries = Object.entries(payload.data).filter(([key]) => keyAllowed(key));
    if (filteredEntries.length !== Object.keys(payload.data).length) {
      outgoing = { ...payload, data: Object.fromEntries(filteredEntries) };
    }
  }

  localClient.publish(baseTopic, JSON.stringify(outgoing), opts);

  if ((config.splitTopics || config.discovery) && outgoing && typeof outgoing.data === 'object') {
    for (const [key, value] of Object.entries(outgoing.data)) {
      const keyTopic = `${baseTopic}/${key}`;
      localClient.publish(keyTopic, JSON.stringify(value), opts);
      if (config.discovery) {
        publishDiscovery(vin, key, value, keyTopic);
      }
    }
  }
}

function connectLocalBroker() {
  const protocol = config.localSsl ? 'mqtts' : 'mqtt';
  const url = `${protocol}://${config.localHost}:${config.localPort}`;
  // Log exactly what we're about to try before the (possibly slow-to-fail)
  // connection attempt starts, so a "connack timeout" or similar silent
  // failure can still be diagnosed from these logs alone (auto-discovered
  // host/port/credentials are otherwise invisible - never logged elsewhere).
  log(
    `Connecting to local broker ${url}` +
      ` (auth: ${config.localUser ? `user "${config.localUser}"` : 'none/anonymous'},` +
      ` source: ${options.mqtt_host ? 'manual mqtt_host option' : 'Supervisor mqtt:want auto-discovery'})`
  );
  localClient = mqtt.connect(url, {
    username: config.localUser || undefined,
    password: config.localPassword || undefined,
    clientId: 'bmw-mqtt-bridge-addon',
    connectTimeout: 30000,
  });
  localClient.on('connect', () => log('Connected to local broker', url));
  localClient.on('error', err => log('Local broker error:', err.message));
  localClient.on('reconnect', () => log('Local broker: reconnecting...'));
  localClient.on('close', () => log('Local broker: connection closed'));
  localClient.on('offline', () => log('Local broker: offline (not connected)'));
}

function connectBmwBroker(state) {
  if (bmwClient) {
    bmwClient.end(true);
  }
  const url = `mqtts://${config.bmwHost}:${config.bmwPort}`;
  bmwClient = mqtt.connect(url, {
    username: buildBmwUsername(),
    password: state.id_token,
    clientId: `bmw-bridge-${config.gcid}`,
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 10000,
  });

  bmwClient.on('connect', () => {
    const msLeft = state.expires_at - Date.now();
    log(`Connected to BMW CarData MQTT broker (token expires in ${Math.round(msLeft / 1000)}s)`);
    for (const vin of config.vins) {
      const topic = `${config.gcid}/${vin}`;
      bmwClient.subscribe(topic, err => {
        if (err) log(`Subscribe failed for ${topic}:`, err.message);
        else log('Subscribed to', topic);
      });
    }
  });
  bmwClient.on('reconnect', () => log('BMW broker: reconnecting...'));
  bmwClient.on('close', () => log('BMW broker: connection closed'));
  bmwClient.on('offline', () => log('BMW broker: offline (not connected)'));
  bmwClient.on('disconnect', packet => log('BMW broker: server sent DISCONNECT', JSON.stringify(packet && packet.properties)));

  bmwClient.on('message', (topic, message) => {
    const vin = topic.split('/').pop();
    try {
      const payload = JSON.parse(message.toString());
      if (payload && typeof payload.data === 'object') {
        for (const [key, value] of Object.entries(payload.data)) {
          recordDiscoveredKey(key, value);
        }
      }
      publishLocal(vin, payload);
    } catch (e) {
      log('Failed to parse BMW message on', topic, e.message);
    }
  });

  bmwClient.on('error', err => log('BMW broker error:', err.message));
}

async function scheduleRefresh(state) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const refreshInMs = Math.max(state.expires_at - Date.now() - 5 * 60 * 1000, 30 * 1000);
  log(
    `Token refresh scheduled in ${Math.round(refreshInMs / 1000)}s` +
      ` (expires_at=${new Date(state.expires_at).toISOString()}, now=${new Date().toISOString()})`
  );
  refreshTimer = setTimeout(async () => {
    try {
      const newState = await refreshTokens(state);
      connectBmwBroker(newState); // id_token (MQTT password) changed, reconnect
      scheduleRefresh(newState);
    } catch (e) {
      log('Refresh failed, restarting auth flow:', e.message);
      const newState = await startDeviceCodeFlow();
      connectBmwBroker(newState);
      scheduleRefresh(newState);
    }
  }, refreshInMs);
}

async function main() {
  // Start the Web UI first and unconditionally, so the Ingress page always
  // loads (showing config problems, if any) instead of spinning forever
  // because nothing is listening on WEB_UI_PORT.
  startServer({ port: WEB_UI_PORT, config, getDiscovered: getDiscoveredKeyList, getConfigProblems });
  if (!assertConfig()) {
    log('Web UI is up, but BMW/MQTT connections are paused until the missing configuration above is filled in.');
    return;
  }
  const state = await ensureAuthenticated();
  connectLocalBroker();
  connectBmwBroker(state);
  scheduleRefresh(state);
}

process.on('SIGINT', () => {
  log('Shutting down...');
  if (bmwClient) bmwClient.end(true);
  if (localClient) localClient.end(true);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down...');
  if (bmwClient) bmwClient.end(true);
  if (localClient) localClient.end(true);
  process.exit(0);
});

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
