(function () {
  'use strict';

  var STALE_MS = 30000; // 30s without a heartbeat → stale
  var health = window.INITIAL_HEALTH || {};

  // ── Hex ↔ HSL conversion ─────────────────────────────────────────────────────

  function hexToHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255;
    var g = parseInt(hex.slice(3, 5), 16) / 255;
    var b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; } else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { hue: Math.round(h * 360), saturation: Math.round(s * 100) };
  }

  // ── API call ─────────────────────────────────────────────────────────────────

  function postSet(deviceId, capability, value) {
    return fetch('/api/devices/' + encodeURIComponent(deviceId) + '/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: capability, value: value })
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Error'); });
      return res.json();
    }).catch(function (err) { showToast(err.message, 'error'); });
  }

  // ── Card helpers ──────────────────────────────────────────────────────────────

  function getCard(deviceId) {
    return document.querySelector('.device-card[data-device-id="' + CSS.escape(deviceId) + '"]');
  }

  function setCardPower(deviceId, isOn) {
    var card = getCard(deviceId);
    if (!card) return;
    card.dataset.on = isOn ? 'true' : 'false';
    var btn = card.querySelector('.power-btn');
    if (!btn) return;
    btn.classList.toggle('power-btn--on', isOn);
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    btn.title = isOn ? 'Turn off' : 'Turn on';
  }

  function setCardBrightness(deviceId, value) {
    var card = getCard(deviceId);
    if (!card) return;
    var slider = card.querySelector('.brightness-slider');
    if (slider) slider.value = value;
  }

  function setCardColor(deviceId, hue, saturation) {
    var card = getCard(deviceId);
    if (!card) return;
    var swatch = card.querySelector('.color-swatch');
    if (swatch) swatch.style.background = 'hsl(' + hue + ',' + saturation + '%,50%)';
  }

  function setCardPreset(deviceId, presetName) {
    var card = getCard(deviceId);
    if (!card) return;
    card.querySelectorAll('.preset-btn').forEach(function (btn) {
      btn.classList.toggle('preset-btn--active', btn.dataset.preset === presetName);
    });
  }

  // ── Health indicators ─────────────────────────────────────────────────────────

  function applyHealth(deviceId, lastSeen) {
    health[deviceId] = lastSeen;
    var now = Date.now();
    var dot = document.querySelector('.health-dot[data-device-id="' + CSS.escape(deviceId) + '"]');
    var label = document.querySelector('.health-label[data-device-id="' + CSS.escape(deviceId) + '"]');
    if (!dot) return;

    var stale = !lastSeen || (now - lastSeen) > STALE_MS;
    dot.classList.toggle('status-dot--offline', stale);
    if (label) label.textContent = stale ? 'No response' : 'Online';
  }

  function applyAllHealth(healthMap) {
    var onlineCount = 0;
    Object.keys(healthMap).forEach(function (id) {
      applyHealth(id, healthMap[id]);
      if (healthMap[id] && (Date.now() - healthMap[id]) <= STALE_MS) onlineCount++;
    });
    var countEl = document.querySelector('.stat-pill--success');
    if (countEl) countEl.lastChild.textContent = ' ' + onlineCount + ' online';
  }

  // ── SSE state update ──────────────────────────────────────────────────────────

  window.handleStateUpdate = function (data) {
    if (!data || !data.type) return;

    if (data.type === 'health') {
      applyAllHealth(data.health);
      return;
    }

    if (data.type !== 'state' || !data.deviceId) return;
    var id = data.deviceId;
    var state = data.state || {};

    // Update lastSeen for this device (state means it's alive)
    applyHealth(id, Date.now());

    if (typeof state.on === 'boolean') setCardPower(id, state.on);
    if (typeof state.brightness === 'number') setCardBrightness(id, state.brightness);
    if (typeof state.hue === 'number' && typeof state.saturation === 'number') {
      setCardColor(id, state.hue, state.saturation);
    }
    if ('activePresetName' in state) setCardPreset(id, state.activePresetName);
  };

  // ── Wire controls ─────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {

    // Initialise health dots from server-side data
    applyAllHealth(health);

    // Power buttons
    document.querySelectorAll('.power-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.deviceId;
        var card = getCard(id);
        var isOn = card ? card.dataset.on === 'true' : false;
        setCardPower(id, !isOn);
        postSet(id, 'power', !isOn);
      });
    });

    // Brightness sliders
    document.querySelectorAll('.brightness-slider').forEach(function (slider) {
      var debouncedPost = debounce(function (id, val) {
        postSet(id, 'brightness', val);
      }, 150);
      slider.addEventListener('input', function () {
        debouncedPost(slider.dataset.deviceId, parseInt(slider.value, 10));
      });
    });

    // Color swatches
    document.querySelectorAll('.color-swatch').forEach(function (swatch) {
      swatch.addEventListener('click', function () {
        var colorInput = document.querySelector('.color-input[data-device-id="' + CSS.escape(swatch.dataset.deviceId) + '"]');
        if (colorInput) colorInput.click();
      });
      swatch.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); swatch.click(); }
      });
    });

    // Color inputs
    document.querySelectorAll('.color-input').forEach(function (input) {
      input.addEventListener('change', function () {
        var id = input.dataset.deviceId;
        var hsl = hexToHsl(input.value);
        setCardColor(id, hsl.hue, hsl.saturation);
        postSet(id, 'hue', hsl.hue);
        postSet(id, 'saturation', hsl.saturation);
      });
    });

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setCardPreset(btn.dataset.deviceId, btn.dataset.preset);
        postSet(btn.dataset.deviceId, 'preset', btn.dataset.preset);
      });
    });

    // Scene strip buttons
    document.querySelectorAll('.scene-strip-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.sceneId;
        var orig = btn.innerHTML;
        btn.disabled = true;
        fetch('/api/scenes/' + id + '/trigger', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (d) { showToast(d.ok ? 'Scene triggered' : (d.error || 'Failed'), d.ok ? 'success' : 'error'); })
          .catch(function () { showToast('Failed', 'error'); })
          .finally(function () { btn.disabled = false; btn.innerHTML = orig; });
      });
    });

    // SSE
    var evtSource = new EventSource('/api/events');
    evtSource.onmessage = function (e) {
      try { handleStateUpdate(JSON.parse(e.data)); } catch (err) { console.error('SSE parse error:', err); }
    };
    evtSource.onerror = function () {
      console.warn('[Hazel] SSE disconnected — will auto-reconnect');
    };

  });

})();
