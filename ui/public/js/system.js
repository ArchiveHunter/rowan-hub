(function () {
  'use strict';

  var restartBtn = document.getElementById('btn-restart');

  // ── Formatters ────────────────────────────────────────────────────────────────

  function formatUptime(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function formatBytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ── Poll stats ────────────────────────────────────────────────────────────────

  function updateStats() {
    fetch('/api/system')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setText('stat-uptime',  formatUptime(data.uptime || 0));
        setText('stat-node',    data.nodeVersion || '–');
        setText('stat-host',    data.hostname || '–');
        setText('stat-cpu',     (data.cpuLoad || '0') + ' avg');
        setText('stat-devices', (data.deviceCount || 0) + ' registered');

        var used = data.processMem || 0;
        var total = data.totalMem || 1;
        var pct = Math.round((used / total) * 100);
        setText('stat-mem', formatBytes(used) + ' / ' + formatBytes(total) + ' (' + pct + '%)');

        var bar = document.getElementById('stat-mem-bar');
        if (bar) bar.style.width = Math.min(pct, 100) + '%';
      })
      .catch(function () {
        // Silently fail — the app might be restarting
      });
  }

  updateStats();
  var statsInterval = setInterval(updateStats, 5000);

  // ── Location ──────────────────────────────────────────────────────────────────

  var saveLocBtn = document.getElementById('btn-save-location');
  if (saveLocBtn) {
    saveLocBtn.addEventListener('click', function () {
      var lat = parseFloat(document.getElementById('loc-lat').value);
      var lon = parseFloat(document.getElementById('loc-lon').value);
      if (isNaN(lat) || isNaN(lon)) { showToast('Enter valid coordinates', 'error'); return; }

      fetch('/api/location', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lon }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) showToast('Location saved', 'success');
          else showToast(data.error || 'Save failed', 'error');
        })
        .catch(function () { showToast('Save failed', 'error'); });
    });
  }

  // ── Restart ───────────────────────────────────────────────────────────────────

  if (restartBtn) {
    restartBtn.addEventListener('click', function () {
      if (!confirm('Restart Hazel now? HomeKit accessories will be momentarily unavailable.')) return;

      restartBtn.disabled = true;
      restartBtn.textContent = 'Restarting…';

      fetch('/api/system/restart', { method: 'POST' })
        .then(function () {
          showToast('Hazel is restarting…', 'warn');
          clearInterval(statsInterval);
        })
        .catch(function () {
          // Request may fail because process exits — that's expected
          showToast('Restarting…', 'warn');
          clearInterval(statsInterval);
        });
    });
  }

})();
