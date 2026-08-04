/**
 * Small Ingress-only Web UI for the BMW CarData MQTT Bridge add-on.
 *
 * Lets the user tick which of the (up to ~250) BMW telemetry parameters get
 * published to MQTT, and pick the notify.* device for the login link, instead
 * of hand-typing comma-separated key lists / service names. Served exclusively
 * via Home Assistant Supervisor Ingress (config.yaml: `ingress: true`) - there
 * is no exposed container port, so this is only reachable through the HA
 * frontend by an already-authenticated user, never from the network directly.
 *
 * Reads live discovered parameters from bridge.js's in-memory state (passed in
 * via `getDiscovered`), and persists the user's choices by calling the
 * Supervisor's own-add-on API (POST /addons/self/options + /addons/self/restart)
 * through the internal proxy at http://supervisor/, authenticated with the
 * same SUPERVISOR_TOKEN used for Home Assistant Core API calls.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const WWW_DIR = path.join(__dirname, 'www');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const MAX_BODY_BYTES = 200 * 1024; // generous headroom for ~250 key names
const NOTIFY_SERVICE_RE = /^[a-zA-Z0-9_]+$/;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(WWW_DIR, rel);
  // Prevent path traversal outside the www/ folder.
  if (!filePath.startsWith(WWW_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Calls the Home Assistant Supervisor / Core API through the internal proxy,
// authenticated with the add-on's own SUPERVISOR_TOKEN. Used for both
// `/core/api/...` (Core REST API) and `/addons/self/...` (Supervisor self-
// management API) paths - both work with just `homeassistant_api: true`.
function supervisorRequest(supervisorToken, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
    const headers = { Authorization: `Bearer ${supervisorToken}` };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ hostname: 'supervisor', path: urlPath, method, headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch (e) {
          /* not JSON, leave null */
        }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * @param {object} opts
 * @param {number} opts.port - port to listen on (must match config.yaml ingress_port)
 * @param {object} opts.config - the bridge's parsed config (needs supervisorToken, notifyService, includeKeys)
 * @param {() => Array<{key:string, unit?:string, sample?:any, lastSeen:string}>} opts.getDiscovered
 * @param {() => string[]} [opts.getConfigProblems] - returns human-readable missing-config messages (empty = OK)
 */
function startServer({ port, config, getDiscovered, getConfigProblems }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (req.method === 'GET' && p === '/api/state') {
        return sendJson(res, 200, {
          keys: getDiscovered(),
          includeKeys: config.includeKeys.join(','),
          notifyService: config.notifyService || '',
          configProblems: getConfigProblems ? getConfigProblems() : [],
        });
      }

      if (req.method === 'GET' && p === '/api/notify-services') {
        const { status, json } = await supervisorRequest(config.supervisorToken, 'GET', '/core/api/services');
        if (status !== 200 || !Array.isArray(json)) {
          return sendJson(res, 502, { error: 'Could not fetch services from Home Assistant.' });
        }
        const notifyDomain = json.find(d => d.domain === 'notify');
        const services = notifyDomain ? Object.keys(notifyDomain.services || {}) : [];
        return sendJson(res, 200, { services });
      }

      if (req.method === 'POST' && p === '/api/save') {
        const raw = await readBody(req);
        let data;
        try {
          data = JSON.parse(raw || '{}');
        } catch (e) {
          return sendJson(res, 400, { error: 'Invalid JSON body.' });
        }

        const allSelected = !!data.allSelected;
        const selectedKeys = Array.isArray(data.selectedKeys)
          ? data.selectedKeys.filter(k => typeof k === 'string').slice(0, 1000)
          : null;
        if (!allSelected && !selectedKeys) {
          return sendJson(res, 400, { error: 'selectedKeys must be an array (or set allSelected: true).' });
        }

        const notifyService = typeof data.notifyService === 'string' ? data.notifyService.trim() : '';
        if (notifyService && !NOTIFY_SERVICE_RE.test(notifyService)) {
          return sendJson(res, 400, { error: 'notifyService contains invalid characters.' });
        }

        const options = { include_keys: allSelected ? '' : selectedKeys.join(',') };
        options.notify_service = notifyService; // allow clearing it back to empty too

        const optResult = await supervisorRequest(config.supervisorToken, 'POST', '/addons/self/options', {
          options,
        });
        if (optResult.status < 200 || optResult.status >= 300) {
          return sendJson(res, 502, {
            error: 'Failed to save options via Supervisor API.',
            detail: optResult.raw,
          });
        }
        return sendJson(res, 200, { saved: true });
      }

      if (req.method === 'POST' && p === '/api/restart') {
        const result = await supervisorRequest(config.supervisorToken, 'POST', '/addons/self/restart');
        if (result.status < 200 || result.status >= 300) {
          return sendJson(res, 502, { error: 'Failed to restart add-on via Supervisor API.' });
        }
        return sendJson(res, 200, { restarting: true });
      }

      if (req.method === 'GET') {
        return serveStatic(res, p);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  server.listen(port, () => {
    console.log(new Date().toISOString(), `Web UI listening on port ${port} (Supervisor Ingress)`);
  });

  return server;
}

module.exports = { startServer };
