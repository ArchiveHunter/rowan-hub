(function () {
  var devices = window.DEVICES || [];

  // ── Capabilities excluded from automation actions (read-only sensors) ──────
  var EXCLUDED_CAPS = ['temperature', 'humidity', 'contact', 'motion'];

  function settableCaps(caps) {
    return caps.filter(function (c) { return EXCLUDED_CAPS.indexOf(c) === -1; });
  }

  function presetsFor(deviceId) {
    var d = devices.find(function (x) { return x.id === deviceId; });
    return d ? (d.presets || []) : [];
  }

  // ── Build the value input element for a given capability ──────────────────

  function buildValEl(cap, value, presets) {
    var el;
    if (cap === 'power') {
      el = document.createElement('select');
      el.className = 'form-input act-val';
      el.innerHTML = '<option value="true">On</option><option value="false">Off</option>';
      el.value = (value === false || value === 'false') ? 'false' : 'true';
    } else if (cap === 'brightness' || cap === 'colorTemp') {
      el = document.createElement('input');
      el.type = 'number'; el.min = '0'; el.max = '100';
      el.className = 'form-input act-val';
      el.value = (value !== undefined && value !== null) ? value : 100;
    } else if (cap === 'color') {
      el = document.createElement('input');
      el.type = 'color';
      el.className = 'form-input act-val';
      el.value = value || '#ffffff';
    } else if (cap === 'preset') {
      el = document.createElement('select');
      el.className = 'form-input act-val';
      (presets || []).forEach(function (p) {
        var o = document.createElement('option');
        o.value = p; o.textContent = p;
        if (p === value) o.selected = true;
        el.appendChild(o);
      });
    } else if (cap === 'hvacMode') {
      el = document.createElement('select');
      el.className = 'form-input act-val';
      ['cool', 'heat', 'auto', 'off'].forEach(function (m) {
        var o = document.createElement('option');
        o.value = m; o.textContent = m;
        if (m === value) o.selected = true;
        el.appendChild(o);
      });
    } else if (cap === 'targetTemperature') {
      el = document.createElement('input');
      el.type = 'number'; el.min = '16'; el.max = '30'; el.step = '0.5';
      el.className = 'form-input act-val';
      el.value = (value !== undefined && value !== null) ? value : 20;
    } else {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'form-input act-val';
      el.value = value !== undefined ? value : '';
    }
    return el;
  }

  // ── Modal helpers ──────────────────────────────────────────────────────────

  function openModal() { document.getElementById('auto-modal').classList.add('is-open'); }
  function closeModal() { document.getElementById('auto-modal').classList.remove('is-open'); }

  document.querySelectorAll('.modal-close').forEach(function (btn) {
    btn.addEventListener('click', closeModal);
  });
  document.getElementById('auto-modal').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
  });

  // ── Trigger type show/hide ─────────────────────────────────────────────────

  var typeEl = document.getElementById('auto-type');
  var groupTime = document.getElementById('group-time');
  var groupOffset = document.getElementById('group-offset');

  function updateTriggerFields() {
    var t = typeEl.value;
    groupTime.style.display = t === 'time' ? '' : 'none';
    groupOffset.style.display = t !== 'time' ? '' : 'none';
  }
  typeEl.addEventListener('change', updateTriggerFields);
  updateTriggerFields();

  // ── Action rows ───────────────────────────────────────────────────────────

  function addActionRow(device, capability, value) {
    device = device || (devices[0] && devices[0].id) || '';
    var devObj = devices.find(function (x) { return x.id === device; }) || devices[0] || {};
    var caps = settableCaps(devObj.capabilities || ['power']);
    capability = capability || caps[0] || 'power';
    var presets = devObj.presets || [];

    var row = document.createElement('div');
    row.className = 'action-row';

    // Device select
    var deviceSel = document.createElement('select');
    deviceSel.className = 'form-input act-device';
    devices.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      if (d.id === device) o.selected = true;
      deviceSel.appendChild(o);
    });

    // Capability select
    var capSel = document.createElement('select');
    capSel.className = 'form-input act-cap';
    caps.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (c === capability) o.selected = true;
      capSel.appendChild(o);
    });

    // Value input
    var valEl = buildValEl(capability, value, presets);

    // Remove button
    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon btn-remove-action';
    removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>';

    row.appendChild(deviceSel);
    row.appendChild(capSel);
    row.appendChild(valEl);
    row.appendChild(removeBtn);
    document.getElementById('actions-list').appendChild(row);

    // Device change → rebuild cap + val
    deviceSel.addEventListener('change', function () {
      var newDev = devices.find(function (x) { return x.id === deviceSel.value; }) || {};
      var newCaps = settableCaps(newDev.capabilities || ['power']);
      capSel.innerHTML = '';
      newCaps.forEach(function (c) {
        var o = document.createElement('option'); o.value = c; o.textContent = c; capSel.appendChild(o);
      });
      rebuildVal();
    });

    // Cap change → rebuild val
    capSel.addEventListener('change', rebuildVal);

    function rebuildVal() {
      var newDev = devices.find(function (x) { return x.id === deviceSel.value; }) || {};
      var newEl = buildValEl(capSel.value, undefined, newDev.presets || []);
      row.replaceChild(newEl, row.querySelector('.act-val'));
    }

    removeBtn.addEventListener('click', function () {
      document.getElementById('actions-list').removeChild(row);
    });
  }

  document.getElementById('btn-add-action').addEventListener('click', function () { addActionRow(); });

  // ── Open add modal ─────────────────────────────────────────────────────────

  function openAdd() {
    document.getElementById('auto-modal-title').textContent = 'Add Automation';
    document.getElementById('auto-id').value = '';
    document.getElementById('auto-name').value = '';
    typeEl.value = 'time';
    updateTriggerFields();
    document.getElementById('auto-time').value = '08:00';
    document.getElementById('auto-offset').value = '0';
    document.querySelectorAll('.day-check').forEach(function (c) { c.checked = false; });
    document.getElementById('actions-list').innerHTML = '';
    addActionRow();
    openModal();
  }

  var addBtn = document.getElementById('btn-add-auto');
  var addBtnEmpty = document.getElementById('btn-add-auto-empty');
  if (addBtn) addBtn.addEventListener('click', openAdd);
  if (addBtnEmpty) addBtnEmpty.addEventListener('click', openAdd);

  // ── Open edit modal ────────────────────────────────────────────────────────

  document.querySelectorAll('.btn-edit-auto').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = this.dataset.id;
      fetch('/api/automations').then(function (r) { return r.json(); }).then(function (list) {
        var auto = list.find(function (a) { return a.id === id; });
        if (!auto) return;
        document.getElementById('auto-modal-title').textContent = 'Edit Automation';
        document.getElementById('auto-id').value = auto.id;
        document.getElementById('auto-name').value = auto.name;
        typeEl.value = auto.trigger.type;
        updateTriggerFields();
        document.getElementById('auto-time').value = auto.trigger.time || '08:00';
        document.getElementById('auto-offset').value = auto.trigger.offset || 0;
        document.querySelectorAll('.day-check').forEach(function (c) {
          c.checked = auto.trigger.days && auto.trigger.days.includes(parseInt(c.value));
        });
        document.getElementById('actions-list').innerHTML = '';
        (auto.actions || []).forEach(function (a) { addActionRow(a.device, a.capability, a.value); });
        openModal();
      });
    });
  });

  // ── Save ──────────────────────────────────────────────────────────────────

  document.getElementById('btn-save-auto').addEventListener('click', function () {
    var id = document.getElementById('auto-id').value;
    var name = document.getElementById('auto-name').value.trim();
    if (!name) { alert('Name is required'); return; }

    var type = typeEl.value;
    var trigger = { type: type };
    if (type === 'time') {
      trigger.time = document.getElementById('auto-time').value;
    } else {
      trigger.offset = parseInt(document.getElementById('auto-offset').value) || 0;
    }
    var days = [];
    document.querySelectorAll('.day-check:checked').forEach(function (c) { days.push(parseInt(c.value)); });
    trigger.days = days;

    var actions = [];
    document.querySelectorAll('#actions-list .action-row').forEach(function (row) {
      var cap = row.querySelector('.act-cap').value;
      var raw = row.querySelector('.act-val').value;
      var val;
      if (raw === 'true') val = true;
      else if (raw === 'false') val = false;
      else if (cap === 'brightness' || cap === 'colorTemp' || cap === 'targetTemperature') val = parseFloat(raw);
      else val = raw;
      actions.push({
        device: row.querySelector('.act-device').value,
        capability: cap,
        value: val,
      });
    });
    if (actions.length === 0) { alert('Add at least one action'); return; }

    var payload = { name: name, trigger: trigger, actions: actions };
    var method = id ? 'PUT' : 'POST';
    var url = id ? '/api/automations/' + id : '/api/automations';

    fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function () { location.reload(); })
      .catch(function (e) { alert('Save failed: ' + e.message); });
  });

  // ── Toggle ────────────────────────────────────────────────────────────────

  document.querySelectorAll('.auto-toggle').forEach(function (cb) {
    cb.addEventListener('change', function () {
      fetch('/api/automations/' + this.dataset.id + '/toggle', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: this.checked }),
      });
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  document.querySelectorAll('.btn-delete-auto').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!confirm('Delete this automation?')) return;
      fetch('/api/automations/' + this.dataset.id, { method: 'DELETE' })
        .then(function () { location.reload(); });
    });
  });
})();
