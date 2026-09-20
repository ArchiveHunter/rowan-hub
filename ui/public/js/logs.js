(function () {
  'use strict';

  var console$el = document.getElementById('log-console');
  var filterEl   = document.getElementById('log-filter');
  var pauseBtn   = document.getElementById('btn-pause');
  var clearBtn   = document.getElementById('btn-clear');

  var paused     = false;
  var userScrolled = false;
  var currentFilter = 'all';

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function formatTs(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function levelLabel(level) {
    switch (level) {
      case 'warn':  return 'WARN';
      case 'error': return 'ERR';
      default:      return 'INFO';
    }
  }

  function createLine(entry) {
    var line = document.createElement('div');
    line.className = 'log-line log-line--' + (entry.level || 'info');
    if (currentFilter !== 'all' && entry.level !== currentFilter) {
      line.classList.add('hidden');
    }

    var ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = formatTs(entry.ts || Date.now());

    var lvl = document.createElement('span');
    lvl.className = 'log-level';
    lvl.textContent = levelLabel(entry.level);

    var txt = document.createElement('span');
    txt.className = 'log-text';
    txt.textContent = entry.text || '';

    line.appendChild(ts);
    line.appendChild(lvl);
    line.appendChild(txt);
    return line;
  }

  function appendLine(entry) {
    // Remove empty state placeholder
    var empty = console$el.querySelector('.log-empty');
    if (empty) empty.remove();

    console$el.appendChild(createLine(entry));

    if (!paused && !userScrolled) {
      console$el.scrollTop = console$el.scrollHeight;
    }
  }

  function applyFilter() {
    currentFilter = filterEl ? filterEl.value : 'all';
    var lines = console$el.querySelectorAll('.log-line');
    lines.forEach(function (line) {
      if (currentFilter === 'all') {
        line.classList.remove('hidden');
      } else {
        var match = line.classList.contains('log-line--' + currentFilter);
        line.classList.toggle('hidden', !match);
      }
    });
  }

  // ── Scroll tracking ───────────────────────────────────────────────────────────

  console$el.addEventListener('scroll', function () {
    var atBottom = console$el.scrollHeight - console$el.scrollTop - console$el.clientHeight < 40;
    userScrolled = !atBottom;
  });

  // ── Controls ──────────────────────────────────────────────────────────────────

  if (pauseBtn) {
    pauseBtn.addEventListener('click', function () {
      paused = !paused;
      pauseBtn.innerHTML = paused
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="3,2 13,8 3,14"/></svg> Resume'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="2" width="3.5" height="12" rx="1"/><rect x="9.5" y="2" width="3.5" height="12" rx="1"/></svg> Pause';
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      console$el.innerHTML = '';
    });
  }

  if (filterEl) {
    filterEl.addEventListener('change', applyFilter);
  }

  // ── Load history ──────────────────────────────────────────────────────────────

  fetch('/api/logs/history')
    .then(function (r) { return r.json(); })
    .then(function (entries) {
      if (entries && entries.length > 0) {
        entries.forEach(appendLine);
      } else {
        var empty = console$el.querySelector('.log-empty');
        if (empty) empty.textContent = 'No log entries yet.';
      }
    })
    .catch(function () {
      var empty = console$el.querySelector('.log-empty');
      if (empty) empty.textContent = 'Failed to load log history.';
    });

  // ── SSE stream ────────────────────────────────────────────────────────────────

  var es = new EventSource('/api/logs/stream');

  es.onmessage = function (e) {
    try {
      var entry = JSON.parse(e.data);
      if (!paused) appendLine(entry);
    } catch (err) {
      // ignore parse errors
    }
  };

  es.onerror = function () {
    console.warn('[Hazel] Log stream disconnected.');
  };

})();
