(function () {
  'use strict';

  // ── Theme ────────────────────────────────────────────────────────────────────

  var THEME_KEY = 'rowan-hub-theme';

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }

  window.toggleTheme = function () {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  };

  // Apply immediately (before paint) to prevent flash
  applyTheme((function () {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; }
  })());

  // ── Session ──────────────────────────────────────────────────────────────────

  // Any API call that comes back 401 means the session expired — go to the login page
  var _fetch = window.fetch.bind(window);
  window.fetch = function () {
    return _fetch.apply(null, arguments).then(function (res) {
      if (res.status === 401 && location.pathname !== '/login') {
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      }
      return res;
    });
  };

  window.signOut = function () {
    _fetch('/api/auth/logout', { method: 'POST' }).finally(function () { location.href = '/login'; });
  };

  // ── Toast notifications ──────────────────────────────────────────────────────

  window.showToast = function (msg, type) {
    type = type || 'success';
    var container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    toast.className = 'toast toast--' + type;
    toast.textContent = msg;
    container.appendChild(toast);
    // Trigger animation
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.classList.add('toast--visible');
      });
    });
    setTimeout(function () {
      toast.classList.remove('toast--visible');
      setTimeout(function () { toast.remove(); }, 200);
    }, 4000);
  };

  // ── Debounce ─────────────────────────────────────────────────────────────────

  window.debounce = function (fn, ms) {
    var t;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  };

  // ── API helper ────────────────────────────────────────────────────────────────

  window.api = function (method, url, body) {
    var opts = {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  };

})();
