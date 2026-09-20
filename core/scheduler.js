const suncalc = require('suncalc');
const automationsManager = require('./automations-manager');

class Scheduler {
  constructor(registry, location) {
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
      const fireAt = this._resolveTime(auto.trigger, now, sun);
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

  async _fire(auto) {
    console.log(`[Scheduler] Firing: "${auto.name}"`);
    for (const action of auto.actions) {
      try {
        await this._registry.set(action.device, action.capability, action.value);
      } catch (e) {
        console.error(`[Scheduler] Action failed (${action.device}): ${e.message}`);
      }
    }
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
