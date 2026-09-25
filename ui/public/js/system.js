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

        syncPairingState(data.windowStatus || 0);
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

  // ── Pairing window ────────────────────────────────────────────────────────────

  var pairBtn = document.getElementById('btn-open-commissioning');
  var pairingStatus = document.getElementById('pairing-status');
  var pairingCountdown = document.getElementById('pairing-countdown');
  var pairingTimer = null;
  var pairingSecondsLeft = 0;

  function formatCountdown(s) {
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function startPairingCountdown(seconds) {
    if (pairingTimer) clearInterval(pairingTimer);
    pairingSecondsLeft = seconds;
    if (pairBtn) { pairBtn.disabled = true; pairBtn.textContent = 'Pairing window open…'; }
    if (pairingStatus) pairingStatus.style.display = '';
    if (pairingCountdown) pairingCountdown.textContent = formatCountdown(pairingSecondsLeft);

    pairingTimer = setInterval(function () {
      pairingSecondsLeft--;
      if (pairingCountdown) pairingCountdown.textContent = formatCountdown(Math.max(0, pairingSecondsLeft));
      if (pairingSecondsLeft <= 0) {
        clearInterval(pairingTimer);
        pairingTimer = null;
        if (pairBtn) { pairBtn.disabled = false; pairBtn.textContent = 'Open for pairing'; }
        if (pairingStatus) pairingStatus.style.display = 'none';
      }
    }, 1000);
  }

  if (pairBtn) {
    pairBtn.addEventListener('click', function () {
      pairBtn.disabled = true;
      pairBtn.textContent = 'Opening…';
      fetch('/api/system/open-commissioning', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            startPairingCountdown(data.timeout || 900);
          } else {
            pairBtn.disabled = false;
            pairBtn.textContent = 'Open for pairing';
            showToast(data.error || 'Failed to open pairing window', 'error');
          }
        })
        .catch(function () {
          pairBtn.disabled = false;
          pairBtn.textContent = 'Open for pairing';
          showToast('Failed to open pairing window', 'error');
        });
    });
  }

  // Sync pairing state when polling picks up windowStatus from another source
  function syncPairingState(windowStatus) {
    if (windowStatus > 0 && !pairingTimer) {
      // Window is open but we don't have a local countdown — show generic open state
      if (pairBtn) { pairBtn.disabled = true; pairBtn.textContent = 'Pairing window open…'; }
      if (pairingStatus) pairingStatus.style.display = '';
    } else if (windowStatus === 0 && !pairingTimer) {
      if (pairBtn) { pairBtn.disabled = false; pairBtn.textContent = 'Open for pairing'; }
      if (pairingStatus) pairingStatus.style.display = 'none';
    }
  }

  // ── Push notifications ────────────────────────────────────────────────────────

  var pushBtn = document.getElementById('btn-push-toggle');
  var pushStatusText = document.getElementById('push-status-text');

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function setPushUI(subscribed) {
    if (!pushBtn) return;
    pushBtn.textContent = subscribed ? 'Disable notifications' : 'Enable notifications';
    pushBtn.className = subscribed ? 'btn btn-secondary' : 'btn btn-primary';
    if (pushStatusText) pushStatusText.textContent = subscribed ? 'Notifications are on for this browser' : '';
  }

  function initPush() {
    if (!pushBtn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      pushBtn.disabled = true;
      pushBtn.textContent = 'Not supported';
      if (pushStatusText) pushStatusText.textContent = 'Push notifications are not supported in this browser.';
      return;
    }

    navigator.serviceWorker.ready.then(function (reg) {
      reg.pushManager.getSubscription().then(function (existing) {
        setPushUI(!!existing);
      });
    });

    pushBtn.addEventListener('click', function () {
      if (Notification.permission === 'denied') {
        if (pushStatusText) pushStatusText.textContent = 'Notifications are blocked — allow them in your browser settings.';
        return;
      }

      navigator.serviceWorker.ready.then(function (reg) {
        reg.pushManager.getSubscription().then(function (existing) {
          if (existing) {
            // Unsubscribe
            existing.unsubscribe().then(function () {
              fetch('/api/push/subscribe', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: existing.endpoint }),
              });
              setPushUI(false);
              showToast('Notifications disabled', 'success');
            });
          } else {
            // Subscribe
            fetch('/api/push/vapid-public-key')
              .then(function (r) { return r.json(); })
              .then(function (data) {
                return reg.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: urlBase64ToUint8Array(data.publicKey),
                });
              })
              .then(function (sub) {
                return fetch('/api/push/subscribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(sub),
                });
              })
              .then(function (r) { return r.json(); })
              .then(function (data) {
                if (data.ok) {
                  setPushUI(true);
                  showToast('Notifications enabled', 'success');
                }
              })
              .catch(function () {
                showToast('Could not enable notifications', 'error');
              });
          }
        });
      });
    });
  }

  initPush();

  // ── Restart ───────────────────────────────────────────────────────────────────

  if (restartBtn) {
    restartBtn.addEventListener('click', function () {
      if (!confirm('Restart Rowan Hub now? HomeKit accessories will be momentarily unavailable.')) return;

      restartBtn.disabled = true;
      restartBtn.textContent = 'Restarting…';

      fetch('/api/system/restart', { method: 'POST' })
        .then(function () {
          showToast('Rowan Hub is restarting…', 'warn');
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
