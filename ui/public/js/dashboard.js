(function () {
  'use strict';

  // Same threshold the server uses before it reports a device offline
  var OFFLINE_MS = 2 * 60 * 1000;

  var devices = {};
  (window.DEVICES || []).forEach(function (d) { devices[d.id] = d; d.state = d.state || {}; });

  var PLUGIN_LABELS = { wled: 'WLED', tasmota: 'Tasmota', ewelink: 'eWeLink', shelly: 'Shelly', mqtt: 'MQTT', zigbee2mqtt: 'Zigbee2MQTT', daikin: 'Daikin' };

  var SWATCHES = [
    { label: 'Warm white', hue: 32, saturation: 45, hex: '#FFD9A6' },
    { label: 'White', hue: 0, saturation: 0, hex: '#FFFFFF' },
    { label: 'Amber', hue: 38, saturation: 90, hex: '#F5A524' },
    { label: 'Red', hue: 0, saturation: 90, hex: '#E5484D' },
    { label: 'Magenta', hue: 294, saturation: 80, hex: '#C23BD4' },
    { label: 'Blue', hue: 220, saturation: 85, hex: '#2F6FEB' },
    { label: 'Green', hue: 140, saturation: 75, hex: '#3CB371' },
  ];

  function has(d, cap) { return d.capabilities.indexOf(cap) !== -1; }
  function isOffline(d) { return !!d.lastSeen && Date.now() - d.lastSeen > OFFLINE_MS; }
  function isOn(d) { return has(d, 'power') && !!d.state.on; }

  function statusText(d) {
    var s = d.state;
    if (isOffline(d)) return 'Offline';
    if (has(d, 'power')) {
      if (!s.on) return 'Off';
      return typeof s.brightness === 'number' && has(d, 'brightness') ? 'On · ' + s.brightness + '%' : 'On';
    }
    if (typeof s.temperature === 'number') return s.temperature + '°C' + (typeof s.humidity === 'number' ? ' · ' + s.humidity + '%' : '');
    if (typeof s.humidity === 'number') return s.humidity + '% humidity';
    return '—';
  }

  function hexToHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var dd = max - min;
      s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
      if (max === r) h = ((g - b) / dd + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / dd + 2) / 6;
      else h = ((r - g) / dd + 4) / 6;
    }
    return { hue: Math.round(h * 360), saturation: Math.round(s * 100) };
  }

  function postSet(id, capability, value) {
    return api('POST', '/api/devices/' + encodeURIComponent(id) + '/set', { capability: capability, value: value })
      .catch(function (err) { showToast(err.message, 'error'); });
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  function tileEl(id) { return document.querySelector('.tile[data-device-id="' + CSS.escape(id) + '"]'); }

  function renderTile(id) {
    var d = devices[id], tile = tileEl(id);
    if (!d || !tile) return;
    var text = statusText(d);
    tile.dataset.on = String(isOn(d));
    tile.dataset.offline = String(isOffline(d));
    tile.querySelector('.tile-status').textContent = text;
    var main = tile.querySelector('.tile-main');
    main.setAttribute('aria-pressed', String(isOn(d)));
    main.setAttribute('aria-label', d.name + ', ' + text);
  }

  function renderSummary() {
    var list = Object.keys(devices).map(function (k) { return devices[k]; });
    var powered = list.filter(function (d) { return has(d, 'power'); });
    var on = powered.filter(isOn).length;
    var off = list.filter(isOffline).length;
    var el = document.getElementById('home-summary');
    if (el) el.textContent = on + ' of ' + powered.length + ' on · ' + (off ? off + ' offline' : 'all online');
    document.querySelectorAll('.rooms section').forEach(function (sec) {
      var n = 0;
      sec.querySelectorAll('.tile').forEach(function (t) { if (t.dataset.on === 'true') n++; });
      var c = sec.querySelector('[data-room-count]');
      if (c) c.textContent = n ? n + ' on' : 'All off';
    });
  }

  function update(id, patch) {
    var d = devices[id];
    if (!d) return;
    Object.assign(d.state, patch);
    renderTile(id);
    renderSummary();
    if (sheetId === id) renderSheet();
  }

  // ── Controls sheet ───────────────────────────────────────────────────────────

  var sheet = document.getElementById('device-sheet');
  var sheetId = null;

  function show(id, visible) { document.getElementById(id).hidden = !visible; }

  function renderSheet() {
    var d = devices[sheetId];
    if (!d) return;
    var s = d.state;
    document.getElementById('sheet-title').textContent = d.name;
    document.getElementById('sheet-sub').textContent = [d.room, statusText(d)].filter(Boolean).join(' · ');
    document.getElementById('sheet-meta').textContent = (PLUGIN_LABELS[d.plugin] || d.plugin) + (isOffline(d) ? ' · not responding' : ' · online');

    show('sheet-power-wrap', has(d, 'power'));
    var power = document.getElementById('sheet-power');
    power.setAttribute('aria-pressed', String(!!s.on));
    document.getElementById('sheet-power-label').textContent = s.on ? 'On' : 'Off';

    show('sheet-bright-wrap', has(d, 'brightness'));
    var bright = document.getElementById('sheet-bright');
    if (document.activeElement !== bright) bright.value = typeof s.brightness === 'number' ? s.brightness : 100;
    document.getElementById('sheet-bright-val').textContent = bright.value + '%';

    show('sheet-colour-wrap', has(d, 'color'));
    document.querySelectorAll('#sheet-swatches .swatch[data-i]').forEach(function (b) {
      var sw = SWATCHES[+b.dataset.i];
      var match = typeof s.hue === 'number' && Math.abs((s.saturation || 0) - sw.saturation) < 12 &&
        (sw.saturation < 10 || Math.min(Math.abs(s.hue - sw.hue), 360 - Math.abs(s.hue - sw.hue)) < 14);
      b.setAttribute('aria-pressed', String(!!match));
    });

    var presets = d.presets || [];
    show('sheet-presets-wrap', presets.length > 0);
    var wrap = document.getElementById('sheet-presets');
    wrap.textContent = '';
    presets.forEach(function (name) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.textContent = name;
      b.setAttribute('aria-pressed', String(s.activePresetName === name));
      b.addEventListener('click', function () { update(sheetId, { activePresetName: name }); postSet(sheetId, 'preset', name); });
      wrap.appendChild(b);
    });
  }

  function openSheet(id) {
    sheetId = id;
    renderSheet();
    if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
  }

  // Build colour swatches once
  var swWrap = document.getElementById('sheet-swatches');
  SWATCHES.forEach(function (sw, i) {
    var b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.i = i;
    b.setAttribute('aria-label', sw.label);
    var dot = document.createElement('span');
    dot.style.background = sw.hex;
    b.appendChild(dot);
    b.addEventListener('click', function () {
      update(sheetId, { hue: sw.hue, saturation: sw.saturation });
      postSet(sheetId, 'hue', sw.hue).then(function () { postSet(sheetId, 'saturation', sw.saturation); });
    });
    swWrap.appendChild(b);
  });
  var custom = document.createElement('label');
  custom.className = 'swatch swatch--custom';
  custom.title = 'Pick any colour';
  custom.innerHTML = '<span></span><input type="color" aria-label="Pick any colour">';
  custom.querySelector('input').addEventListener('change', function (e) {
    var hsl = hexToHsl(e.target.value);
    update(sheetId, hsl);
    postSet(sheetId, 'hue', hsl.hue).then(function () { postSet(sheetId, 'saturation', hsl.saturation); });
  });
  swWrap.appendChild(custom);

  document.getElementById('sheet-close').addEventListener('click', function () { sheet.close(); });
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); }); // backdrop
  sheet.addEventListener('close', function () { sheetId = null; });

  document.getElementById('sheet-power').addEventListener('click', function () {
    var d = devices[sheetId];
    var next = !d.state.on;
    update(sheetId, { on: next });
    postSet(sheetId, 'power', next);
  });

  var sendBright = debounce(function (id, v) { postSet(id, 'brightness', v); }, 150);
  document.getElementById('sheet-bright').addEventListener('input', function (e) {
    var v = parseInt(e.target.value, 10);
    update(sheetId, { brightness: v });
    sendBright(sheetId, v);
  });

  // ── Tiles & scenes ───────────────────────────────────────────────────────────

  document.querySelectorAll('.tile').forEach(function (tile) {
    var id = tile.dataset.deviceId;
    tile.querySelector('.tile-main').addEventListener('click', function () {
      var d = devices[id];
      if (!d || !has(d, 'power')) return;
      var next = !d.state.on;
      update(id, { on: next });
      postSet(id, 'power', next);
    });
    var adj = tile.querySelector('.tile-adjust');
    if (adj) adj.addEventListener('click', function () { openSheet(id); });
  });

  document.querySelectorAll('.scene-run').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      api('POST', '/api/scenes/' + encodeURIComponent(btn.dataset.sceneId) + '/trigger')
        .then(function () { showToast('Scene ran'); })
        .catch(function (e) { showToast(e.message, 'error'); })
        .finally(function () { btn.disabled = false; });
    });
  });

  // ── Live updates ─────────────────────────────────────────────────────────────

  var evt = new EventSource('/api/events');
  evt.onmessage = function (e) {
    var data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    if (data.type === 'health') {
      Object.keys(data.health || {}).forEach(function (id) {
        if (devices[id]) { devices[id].lastSeen = data.health[id]; renderTile(id); }
      });
      renderSummary();
      if (sheetId) renderSheet();
    } else if (data.type === 'state' && devices[data.deviceId]) {
      // Not proof of life (the stream replays state on connect) — health events carry lastSeen
      update(data.deviceId, data.state || {});
    }
  };
})();
