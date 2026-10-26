// Human-readable descriptions for the web UI: device kinds, automation triggers and
// actions, and friendly run times. Pure functions — safe to expose to EJS views.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Matter vendor IDs of the common home apps (bridge fabrics carry these)
const CONTROLLER_VENDORS = {
  0x1349: 'Apple Home',
  0x1384: 'Apple Home', // iOS also adds an Apple keychain fabric alongside the home
  0x1217: 'Amazon Alexa',
  0x6006: 'Google Home',
  0x110A: 'SmartThings',
};

const KINDS = ['light', 'plug', 'strip', 'switch', 'climate', 'sensor', 'blind'];

// What a device *is*, for its icon. `kind` set on the device wins; otherwise guess.
function deviceKind(d) {
  if (d.kind && KINDS.includes(d.kind)) return d.kind;
  const caps = d.capabilities || [];
  if (d.plugin === 'wled') return 'strip';
  if (d.plugin === 'daikin' || caps.includes('targetTemperature')) return 'climate';
  if (d.plugin === 'shelly' && d.component === 'roller') return 'blind';
  if (!caps.includes('power') && (caps.includes('temperature') || caps.includes('humidity'))) return 'sensor';
  if (/socket|plug|outlet/i.test(d.name || '')) return 'plug';
  return 'light';
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function daysText(days) {
  const d = [...new Set(days || [])].sort();
  if (d.length === 0 || d.length === 7) return 'every day';
  if (d.join() === '1,2,3,4,5') return 'on weekdays';
  if (d.join() === '0,6') return 'at weekends';
  return 'on ' + d.map(i => DAY_NAMES[i]).join(', ');
}

function triggerText(t) {
  if (!t) return '';
  let when;
  if (t.type === 'time') {
    when = t.time === '00:00' ? 'At midnight' : t.time === '12:00' ? 'At midday' : `At ${t.time}`;
  } else {
    const off = Number(t.offset) || 0;
    const event = t.type; // sunrise | sunset
    if (off === 0) when = `At ${event}`;
    else {
      const mins = Math.abs(off);
      const span = mins % 60 === 0 ? `${mins / 60} hour${mins === 60 ? '' : 's'}` : `${mins} min`;
      when = `${span} ${off < 0 ? 'before' : 'after'} ${event}`;
      when = when[0].toUpperCase() + when.slice(1);
    }
  }
  return `${when} ${daysText(t.days)}`;
}

// "turn on Driveway Lights and Yard Light, and set Living Room Wall to 40% brightness"
function actionsText(actions, nameOf) {
  const groups = new Map(); // phrase key → { verb, names }
  for (const a of actions || []) {
    const name = nameOf(a.device);
    let key, phrase;
    const v = a.value;
    switch (a.capability) {
      case 'power': key = 'power:' + (v === true || v === 'true'); phrase = (v === true || v === 'true') ? 'turn on {}' : 'turn off {}'; break;
      case 'brightness': key = 'bri:' + v; phrase = `set {} to ${v}% brightness`; break;
      case 'preset': key = 'preset:' + v; phrase = `set {} to “${v}”`; break;
      case 'hue': case 'saturation': case 'color': key = 'colour'; phrase = 'change the colour of {}'; break;
      case 'hvacMode': key = 'hvac:' + v; phrase = `set {} to ${v} mode`; break;
      case 'targetTemperature': key = 'temp:' + v; phrase = `set {} to ${v}°C`; break;
      default: key = a.capability + ':' + v; phrase = `set {} ${a.capability} to ${v}`;
    }
    if (!groups.has(key)) groups.set(key, { phrase, names: [] });
    const g = groups.get(key);
    if (!g.names.includes(name)) g.names.push(name);
  }
  const parts = [...groups.values()].map(g => g.phrase.replace('{}', joinNames(g.names)));
  return joinNames(parts);
}

// "Today 16:35", "Tomorrow 06:40", "Thu 16:00", "3 Nov 16:00"
function whenText(date, now = new Date()) {
  if (!date) return '';
  const d = new Date(date);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const startOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(now)) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${DAY_NAMES[d.getDay()]} ${time}`;
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${time}`;
}

function controllerName(fabric) {
  return CONTROLLER_VENDORS[fabric.vendorId] || fabric.label || 'Matter app';
}

module.exports = { deviceKind, triggerText, actionsText, whenText, controllerName, joinNames, KINDS };
