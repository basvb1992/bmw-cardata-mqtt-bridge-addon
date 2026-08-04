(() => {
  'use strict';

  let discovered = []; // [{key, unit, sample, lastSeen}]
  let includeSet = null; // null = "everything included" (default state)

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function groupOf(key) {
    const parts = key.split('.');
    return parts.slice(0, Math.min(2, parts.length)).join('.');
  }

  function isChecked(key) {
    return includeSet === null || includeSet.has(key);
  }

  function ensureSet() {
    if (includeSet === null) {
      includeSet = new Set(discovered.map(i => i.key));
    }
  }

  function setChecked(key, checked) {
    ensureSet();
    if (checked) includeSet.add(key);
    else includeSet.delete(key);
  }

  function render() {
    const groupsEl = document.getElementById('groups');
    const filter = document.getElementById('search').value.trim().toLowerCase();
    const groups = new Map();
    for (const item of discovered) {
      if (filter && !item.key.toLowerCase().includes(filter)) continue;
      const g = groupOf(item.key);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }

    groupsEl.innerHTML = '';
    const sortedGroups = Array.from(groups.keys()).sort();
    let shown = 0;

    for (const g of sortedGroups) {
      const items = groups.get(g).sort((a, b) => a.key.localeCompare(b.key));
      shown += items.length;

      const groupDiv = document.createElement('div');
      groupDiv.className = 'group';

      const header = document.createElement('label');
      header.className = 'group-header';
      const groupChecked = items.every(i => isChecked(i.key));
      const groupCb = document.createElement('input');
      groupCb.type = 'checkbox';
      groupCb.checked = groupChecked;
      groupCb.addEventListener('change', () => {
        for (const item of items) setChecked(item.key, groupCb.checked);
        render();
      });
      header.appendChild(groupCb);
      const groupLabel = document.createElement('span');
      groupLabel.textContent = `${g} (${items.length})`;
      header.appendChild(groupLabel);
      groupDiv.appendChild(header);

      const keysDiv = document.createElement('div');
      keysDiv.className = 'group-keys';
      for (const item of items) {
        const row = document.createElement('label');
        row.className = 'key-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isChecked(item.key);
        cb.addEventListener('change', () => {
          setChecked(item.key, cb.checked);
          render();
        });
        row.appendChild(cb);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'key-name';
        nameSpan.textContent = item.key;
        row.appendChild(nameSpan);
        const sampleText = item.sample !== undefined && item.sample !== null ? String(item.sample) : '';
        if (sampleText) {
          const sampleSpan = document.createElement('span');
          sampleSpan.className = 'key-sample';
          sampleSpan.textContent = sampleText + (item.unit ? ' ' + item.unit : '');
          row.appendChild(sampleSpan);
        }
        keysDiv.appendChild(row);
      }
      groupDiv.appendChild(keysDiv);
      groupsEl.appendChild(groupDiv);
    }

    document.getElementById('count').textContent = discovered.length
      ? `${shown} / ${discovered.length} parameters`
      : 'No parameters discovered yet — waiting for BMW telemetry…';
  }

  function renderConfigWarning(problems) {
    const section = document.getElementById('configWarning');
    const list = document.getElementById('configProblems');
    if (!problems || !problems.length) {
      section.hidden = true;
      return;
    }
    list.innerHTML = problems.map(p => `<li>${p}</li>`).join('');
    section.hidden = false;
  }

  async function loadState() {
    const state = await fetchJson('api/state');
    discovered = state.keys || [];
    includeSet = state.includeKeys
      ? new Set(state.includeKeys.split(',').map(k => k.trim()).filter(Boolean))
      : null;
    renderConfigWarning(state.configProblems);
    render();

    const notifySel = document.getElementById('notifyService');
    try {
      const svc = await fetchJson('api/notify-services');
      notifySel.innerHTML =
        '<option value="">— none —</option>' +
        svc.services.map(s => `<option value="${s}">${s}</option>`).join('');
      notifySel.value = state.notifyService || '';
    } catch (e) {
      notifySel.innerHTML = '<option value="">Could not load services</option>';
    }
  }

  async function pollForNewKeys() {
    try {
      const state = await fetchJson('api/state');
      const existing = new Set(discovered.map(i => i.key));
      const hasNew = (state.keys || []).some(i => !existing.has(i.key));
      if (hasNew) {
        discovered = state.keys;
        render();
      }
    } catch (e) {
      /* ignore transient poll errors */
    }
  }

  async function save() {
    const statusEl = document.getElementById('status');
    const allSelected = includeSet === null || discovered.every(i => includeSet.has(i.key));
    const selectedKeys = allSelected ? [] : Array.from(includeSet);
    const notifyService = document.getElementById('notifyService').value;

    statusEl.textContent = 'Saving…';
    try {
      await fetchJson('api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedKeys, allSelected, notifyService }),
      });
      statusEl.textContent = 'Saved. Restarting add-on…';
      await fetchJson('api/restart', { method: 'POST' });
      statusEl.textContent = 'Restarting — reopen this page from the add-on Info tab in a few seconds.';
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }

  document.getElementById('search').addEventListener('input', render);
  document.getElementById('selectAll').addEventListener('click', () => {
    includeSet = null;
    render();
  });
  document.getElementById('selectNone').addEventListener('click', () => {
    includeSet = new Set();
    render();
  });
  document.getElementById('save').addEventListener('click', save);

  loadState().catch(e => {
    document.getElementById('status').textContent = 'Error loading state: ' + e.message;
  });

  setInterval(pollForNewKeys, 10000);
})();
