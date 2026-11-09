// The hub runs in the timezone saved with its location, so "16:00" means 16:00 at home
// (clock changes included) whatever the host's system clock is set to.
// Node picks up process.env.TZ changes at runtime, so a new zone applies without a restart.

const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function isValid(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

// Applies the configured zone, or the host's own zone when none is saved (older installs)
function apply(tz) {
  process.env.TZ = isValid(tz) ? tz : SYSTEM_ZONE;
  return current();
}

function current() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

module.exports = { isValid, apply, current, SYSTEM_ZONE };
