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
  }

  start() {
    this._scheduleAll();
    console.log('[Scheduler] Started');
  }

  setLocation(location) {
    this._lat = location?.latitude ?? this._lat;
    this._lon = location?.longitude ?? this._lon;
  }

  reload() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this._scheduleAll();
  }

  _scheduleAll() {
    for (const auto of automationsManager.getAll()) this._schedule(auto);
  }

  // Each automation is booked for its next run (however many days ahead) and re-booked when it
  // fires. Booking only "the rest of today" and rebuilding at 00:00:30 silently skipped 00:00 triggers.
  _schedule(auto, after = new Date()) {
    clearTimeout(this._timers.get(auto.id));
    this._timers.delete(auto.id);
    if (!auto.enabled) return;
    // A malformed automation must not take down the whole scheduler (or crash-loop startup)
    let fireAt;
    try { fireAt = this._nextRun(auto.trigger, after); } catch (e) {
      console.error(`[Scheduler] Skipping "${auto.name}": invalid trigger (${e.message})`);
      return;
    }
    if (!fireAt) return;

    console.log(`[Scheduler] "${auto.name}" scheduled for ${fireAt.toLocaleString()}`);
    const delay = Math.max(0, fireAt - Date.now());
    this._timers.set(auto.id, setTimeout(() => this._fire(auto, fireAt), delay));
  }

  // First fire time strictly after `after`, looking up to a week ahead (covers any day-of-week filter)
  _nextRun(trigger, after) {
    for (let d = 0; d < 8; d++) {
      const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + d, 12);
      const at = this._resolveTime(trigger, day, suncalc.getTimes(day, this._lat, this._lon));
      if (at && at > after) return at;
    }
    return null;
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

  // Next fire time for every enabled automation — for the UI.
  getNextRuns(now = new Date()) {
    const out = {};
    for (const auto of automationsManager.getAll()) {
      if (!auto.enabled) continue;
      let at;
      try { at = this._nextRun(auto.trigger, now); } catch { continue; }
      if (at) out[auto.id] = at;
    }
    return out;
  }

  async _fire(auto, firedAt) {
    // Book the next run first, so a reload() during the actions below can't leave two timers
    this._schedule(auto, firedAt);
    console.log(`[Scheduler] Firing: "${auto.name}"`);
    for (const action of auto.actions) {
      try {
        await this._registry.set(action.device, action.capability, action.value, { source: 'automation', by: auto.name });
      } catch (e) {
        console.error(`[Scheduler] Action failed (${action.device}): ${e.message}`);
      }
    }
    this.emit('fired', { id: auto.id, name: auto.name });
  }

  destroy() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }
}

module.exports = Scheduler;
