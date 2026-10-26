const { EventEmitter } = require('events');
const suncalc = require('suncalc');
const automationsManager = require('./automations-manager');

class Scheduler extends EventEmitter {
  constructor(registry, location) {
    super();
    this._registry = registry;
    this._lat = location?.latitude ?? 51.5;
    this._lon = location?.longitude ?? -0.12;
    this._timers = new Map();
    this._midnightTimer = null;
  }

  start() {
    this._scheduleDay();
    this._scheduleMidnight();
    console.log('[Scheduler] Started');
  }

  setLocation(location) {
    this._lat = location?.latitude ?? this._lat;
    this._lon = location?.longitude ?? this._lon;
  }

  reload() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this._scheduleDay();
  }

  _scheduleDay() {
    const now = new Date();
    const sun = suncalc.getTimes(now, this._lat, this._lon);

    for (const auto of automationsManager.getAll()) {
      if (!auto.enabled) continue;
      // A malformed automation must not take down the whole scheduler (or crash-loop startup)
      let fireAt;
      try { fireAt = this._resolveTime(auto.trigger, now, sun); } catch (e) {
        console.error(`[Scheduler] Skipping "${auto.name}": invalid trigger (${e.message})`);
        continue;
      }
      if (!fireAt || fireAt <= now) continue;

      const delay = fireAt - now;
      console.log(`[Scheduler] "${auto.name}" scheduled for ${fireAt.toLocaleTimeString()}`);
      this._timers.set(auto.id, setTimeout(() => this._fire(auto), delay));
    }
  }

  _resolveTime(trigger, now, sun) {
    let base;

    if (trigger.type === 'time') {
      const [h, m] = trigger.time.split(':').map(Number);
      base = new Date(now);
      base.setHours(h, m, 0, 0);
    } else if (trigger.type === 'sunrise') {
      base = new Date(sun.sunrise);
    } else if (trigger.type === 'sunset') {
      base = new Date(sun.sunset);
    } else {
      return null;
    }

    if (trigger.offset) base = new Date(base.getTime() + trigger.offset * 60000);

    // Day-of-week filter (0=Sun … 6=Sat). Empty array = every day.
    if (trigger.days && trigger.days.length > 0) {
      if (!trigger.days.includes(base.getDay())) return null;
    }

    return base;
  }

  // Next fire time for every enabled automation (looks up to a week ahead) — for the UI.
  getNextRuns(now = new Date()) {
    const out = {};
    for (const auto of automationsManager.getAll()) {
      if (!auto.enabled) continue;
      for (let d = 0; d < 8; d++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, 12);
        let at;
        try { at = this._resolveTime(auto.trigger, day, suncalc.getTimes(day, this._lat, this._lon)); } catch { break; }
        if (at && at > now) { out[auto.id] = at; break; }
      }
    }
    return out;
  }

  async _fire(auto) {
    console.log(`[Scheduler] Firing: "${auto.name}"`);
    for (const action of auto.actions) {
      try {
        await this._registry.set(action.device, action.capability, action.value);
      } catch (e) {
        console.error(`[Scheduler] Action failed (${action.device}): ${e.message}`);
      }
    }
    this.emit('fired', { id: auto.id, name: auto.name });
  }

  _scheduleMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 30, 0); // 30s past midnight to avoid edge cases
    this._midnightTimer = setTimeout(() => {
      for (const t of this._timers.values()) clearTimeout(t);
      this._timers.clear();
      this._scheduleDay();
      this._scheduleMidnight();
    }, midnight - now);
  }

  destroy() {
    for (const t of this._timers.values()) clearTimeout(t);
    clearTimeout(this._midnightTimer);
  }
}

module.exports = Scheduler;
