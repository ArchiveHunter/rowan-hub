(function () {
  'use strict';

  var SCHEMAS = window.PLUGIN_SCHEMAS || {};

  var selectedPlugin = null;
  var editingDeviceId = null;
  var deletingDeviceId = null;

  // ── Modal helpers ─────────────────────────────────────────────────────────────

  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('is-open');
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('is-open');
  }

  // Close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Close buttons
  document.querySelectorAll('.modal-close, [data-modal]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.dataset.modal || btn.closest('.modal-overlay').id;
      closeModal(target);
    });
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.is-open').forEach(function (m) {
        closeModal(m.id);
      });
    }
  });

  // ── Tag input ─────────────────────────────────────────────────────────────────

  function buildTagInput(container, initialTags) {
    container.innerHTML = '';
    var tags = initialTags ? initialTags.slice() : [];

    function render() {
      container.innerHTML = '';
      tags.forEach(function (tag, i) {
        var span = document.createElement('span');
        span.className = 'tag';

        var text = document.createElement('span');
        text.textContent = tag;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tag-remove';
        btn.setAttribute('aria-label', 'Remove ' + tag);
        btn.innerHTML = '&times;';
        btn.addEventListener('click', function () {
          tags.splice(i, 1);
          render();
        });

        span.appendChild(text);
        span.appendChild(btn);
        container.appendChild(span);
      });

      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'tag-text-input';
      inp.placeholder = tags.length === 0 ? 'Type and press Enter…' : '';
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          var val = inp.value.trim().replace(/,$/, '');
          if (val) { tags.push(val); render(); }
        }
        if (e.key === 'Backspace' && inp.value === '' && tags.length > 0) {
          tags.pop();
          render();
        }
      });
      inp.addEventListener('blur', function () {
        var val = inp.value.trim().replace(/,$/, '');
        if (val) { tags.push(val); render(); }
      });
      container.appendChild(inp);
      inp.focus();
    }

    container.addEventListener('click', function () {
      var inp = container.querySelector('.tag-text-input');
      if (inp) inp.focus();
    });

    render();

    return {
      getTags: function () {
        // Flush any pending text
        var inp = container.querySelector('.tag-text-input');
        if (inp && inp.value.trim()) {
          tags.push(inp.value.trim());
          inp.value = '';
        }
        return tags.slice();
      }
    };
  }

  // ── Dynamic form builder ──────────────────────────────────────────────────────

  var tagInputRef = null;

  function buildFields(containerId, pluginName, existingData) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    tagInputRef = null;

    var schema = SCHEMAS[pluginName];
    if (!schema) return;

    schema.fields.forEach(function (field) {
      var group = document.createElement('div');
      group.className = 'form-group';

      var label = document.createElement('label');
      label.setAttribute('for', containerId + '-' + field.name);
      label.innerHTML = field.label + (field.required ? ' <span class="required">*</span>' : '');

      group.appendChild(label);

      if (field.type === 'tags') {
        var tagContainer = document.createElement('div');
        tagContainer.className = 'tag-input-container';
        tagContainer.id = containerId + '-' + field.name;
        group.appendChild(tagContainer);

        if (field.hint) {
          var hint = document.createElement('span');
          hint.className = 'form-hint';
          hint.textContent = field.hint;
          group.appendChild(hint);
        }

        container.appendChild(group);

        var initialTags = existingData && existingData[field.name]
          ? (Array.isArray(existingData[field.name]) ? existingData[field.name] : existingData[field.name].split(',').map(function (s) { return s.trim(); }).filter(Boolean))
          : [];
        tagInputRef = buildTagInput(tagContainer, initialTags);
        return;
      }

      var input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : 'text');
      input.id = containerId + '-' + field.name;
      input.name = field.name;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.required) input.required = true;
      if (existingData && existingData[field.name] !== undefined && existingData[field.name] !== null) {
        input.value = existingData[field.name];
      }
      group.appendChild(input);
      container.appendChild(group);
    });
  }

  function collectFormData(containerId, pluginName) {
    var container = document.getElementById(containerId);
    var schema = SCHEMAS[pluginName];
    if (!container || !schema) return null;

    var data = { plugin: pluginName };

    schema.fields.forEach(function (field) {
      if (field.type === 'tags') {
        data[field.name] = tagInputRef ? tagInputRef.getTags() : [];
        return;
      }
      var el = document.getElementById(containerId + '-' + field.name);
      if (!el) return;
      if (field.required && !el.value.trim()) {
        el.focus();
        throw new Error(field.label + ' is required');
      }
      var val = el.value.trim();
      if (val !== '') {
        data[field.name] = field.type === 'number' ? (parseFloat(val) || 0) : val;
      }
    });

    return data;
  }

  // ── Plugin selector (Add modal) ───────────────────────────────────────────────

  document.querySelectorAll('.plugin-choice').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.plugin-choice').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedPlugin = btn.dataset.plugin;
      buildFields('add-dynamic-fields', selectedPlugin, null);
    });
  });

  // ── Add modal ─────────────────────────────────────────────────────────────────

  function openAddModal() {
    selectedPlugin = null;
    tagInputRef = null;
    document.getElementById('add-dynamic-fields').innerHTML = '';
    document.querySelectorAll('.plugin-choice').forEach(function (b) { b.classList.remove('active'); });
    openModal('add-modal');
  }

  var addBtn = document.getElementById('btn-add-device');
  if (addBtn) addBtn.addEventListener('click', openAddModal);

  var addBtnEmpty = document.getElementById('btn-add-device-empty');
  if (addBtnEmpty) addBtnEmpty.addEventListener('click', openAddModal);

  var saveAddBtn = document.getElementById('btn-save-add');
  if (saveAddBtn) {
    saveAddBtn.addEventListener('click', function () {
      if (!selectedPlugin) {
        showToast('Please select a plugin', 'warn');
        return;
      }
      var data;
      try {
        data = collectFormData('add-dynamic-fields', selectedPlugin);
      } catch (e) {
        showToast(e.message, 'error');
        return;
      }

      saveAddBtn.disabled = true;

      api('POST', '/api/devices', data)
        .then(function (res) {
          showToast(res.message || 'Device added.', 'success');
          closeModal('add-modal');
          setTimeout(function () { location.reload(); }, 800);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
          saveAddBtn.disabled = false;
        });
    });
  }

  // ── Toggle enable/disable ────────────────────────────────────────────────────

  document.querySelectorAll('.btn-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var deviceId = btn.dataset.deviceId;
      var currentEnabled = btn.dataset.enabled === 'true';
      api('PUT', '/api/devices/' + encodeURIComponent(deviceId) + '/toggle', { enabled: !currentEnabled })
        .then(function (res) {
          showToast(res.message || 'Device updated.', 'success');
          setTimeout(function () { location.reload(); }, 800);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
        });
    });
  });

  // ── Edit modal ────────────────────────────────────────────────────────────────

  document.querySelectorAll('.btn-edit').forEach(function (btn) {
    btn.addEventListener('click', function () {
      editingDeviceId = btn.dataset.deviceId;
      var device = (window.DEVICES_DATA || []).find(function (d) { return d.id === editingDeviceId; });
      if (!device) return;

      selectedPlugin = device.plugin;
      buildFields('edit-dynamic-fields', selectedPlugin, device);
      openModal('edit-modal');
    });
  });

  var saveEditBtn = document.getElementById('btn-save-edit');
  if (saveEditBtn) {
    saveEditBtn.addEventListener('click', function () {
      if (!editingDeviceId || !selectedPlugin) return;

      var data;
      try {
        data = collectFormData('edit-dynamic-fields', selectedPlugin);
      } catch (e) {
        showToast(e.message, 'error');
        return;
      }

      saveEditBtn.disabled = true;

      api('PUT', '/api/devices/' + encodeURIComponent(editingDeviceId), data)
        .then(function (res) {
          showToast(res.message || 'Device updated.', 'success');
          closeModal('edit-modal');
          setTimeout(function () { location.reload(); }, 800);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
          saveEditBtn.disabled = false;
        });
    });
  }

  // ── Delete modal ──────────────────────────────────────────────────────────────

  document.querySelectorAll('.btn-delete').forEach(function (btn) {
    btn.addEventListener('click', function () {
      deletingDeviceId = btn.dataset.deviceId;
      var nameEl = document.getElementById('delete-device-name');
      if (nameEl) nameEl.textContent = btn.dataset.deviceName || deletingDeviceId;
      openModal('delete-modal');
    });
  });

  var confirmDeleteBtn = document.getElementById('btn-confirm-delete');
  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener('click', function () {
      if (!deletingDeviceId) return;

      confirmDeleteBtn.disabled = true;

      api('DELETE', '/api/devices/' + encodeURIComponent(deletingDeviceId))
        .then(function (res) {
          showToast(res.message || 'Device removed.', 'success');
          closeModal('delete-modal');
          setTimeout(function () { location.reload(); }, 800);
        })
        .catch(function (err) {
          showToast(err.message, 'error');
          confirmDeleteBtn.disabled = false;
        });
    });
  }

})();
