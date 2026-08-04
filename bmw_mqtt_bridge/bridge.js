/**
 * BMW CarData -> MQTT bridge, packaged as a Home Assistant add-on.
 *
 * Runs *inside* Home Assistant as a Supervisor-managed add-on container, and
 * gets everything it needs from Supervisor instead of manually-managed secrets:
 *
 *  - client_id / gcid / vin / etc. come from the add-on's Options
 *    (Settings > Add-ons > BMW CarData MQTT Bridge > Configuration). Fields
 *    marked "password" in config.yaml's schema are masked in the UI and
 *    stored by Supervisor on the HA host - never in this repo, never in .env.
 *  - The local MQTT broker connection (host/port/user/password) is
 *    auto-injected by Supervisor via `services: [mqtt:want]` in config.yaml -
 *    no broker address ever needs to be entered.
 *  - The one-time BMW login link is sent via Home Assistant's notify service
 *    using the Supervisor-issued SUPERVISOR_TOKEN (from `homeassistant_api:
 *    true`), calling Core's API through the Supervisor proxy at
 *    http://supervisor/core/api - no long-lived access token needed.
 *
 * BMW OAuth2 tokens are persisted to /data/bmw-bridge-state.json, which is the
 * add-on's persistent data folder (survives add-on restarts/updates).
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const mqtt = require('mqtt');

const OPTIONS_FILE = '/data/options.json';
const STATE_FILE = '/data/bmw-bridge-state.json';

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
  // Auto-injected by Supervisor because config.yaml declares `services: [mqtt:want]`.
  localHost: process.env.MQTT_HOST || '',
  localPort: parseInt(process.env.MQTT_PORT || '1883', 10),
  localUser: process.env.MQTT_USERNAME || '',
  localPassword: process.env.MQTT_PASSWORD || '',
  localSsl: process.env.MQTT_SSL === 'true',
  localPrefix: options.local_prefix || 'bmw/',
  splitTopics: !!options.split_topics,
  retain: !!options.mqtt_retain,
  discovery: options.mqtt_discovery !== false,
  discoveryPrefix: options.discovery_prefix || 'homeassistant',
  notifyService: options.notify_service || '',
  // Auto-injected by Supervisor because config.yaml declares `homeassistant_api: true`.
  supervisorToken: process.env.SUPERVISOR_TOKEN || '',
};

function assertConfig() {
  const missing = [];
  if (!config.clientId) missing.push('client_id (add-on option)');
  if (!config.gcid) missing.push('gcid (add-on option)');
  if (!config.vins.length) missing.push('vin (add-on option)');
  if (!config.notifyService) missing.push('notify_service (add-on option, e.g. "mobile_app_yourphone")');
  if (!config.localHost) {
    missing.push(
      'MQTT_HOST (no MQTT broker service found - install/start the Mosquitto broker ' +
        'add-on so Supervisor can auto-wire this add-on to it)'
    );
  }
  if (!config.supervisorToken) missing.push('SUPERVISOR_TOKEN (homeassistant_api not granted?)');
  if (missing.length) {
    console.error('Missing required configuration: ' + missing.join(', '));
    process.exit(1);
  }
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
      await haNotify('BMW CarData', 'Login successful, bridge is starting.');
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

function friendlyName(key) {
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
      name: `BMW ${vin}`,
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
  localClient.publish(baseTopic, JSON.stringify(payload), opts);

  if ((config.splitTopics || config.discovery) && payload && typeof payload.data === 'object') {
    for (const [key, value] of Object.entries(payload.data)) {
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
  localClient = mqtt.connect(url, {
    username: config.localUser || undefined,
    password: config.localPassword || undefined,
    clientId: 'bmw-mqtt-bridge-addon',
  });
  localClient.on('connect', () => log('Connected to local broker', url));
  localClient.on('error', err => log('Local broker error:', err.message));
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
    log('Connected to BMW CarData MQTT broker');
    for (const vin of config.vins) {
      const topic = `${config.gcid}/${vin}`;
      bmwClient.subscribe(topic, err => {
        if (err) log(`Subscribe failed for ${topic}:`, err.message);
        else log('Subscribed to', topic);
      });
    }
  });

  bmwClient.on('message', (topic, message) => {
    const vin = topic.split('/').pop();
    try {
      const payload = JSON.parse(message.toString());
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
  assertConfig();
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
