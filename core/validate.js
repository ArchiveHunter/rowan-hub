// Input validation for scenes and automations — both are stored as JSON and replayed
// against devices, so only known fields with sane values are accepted.

function name(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 80) throw new Error('Name is required (max 80 characters)');
  return v.trim();
}

function actions(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('Add at least one action');
  if (list.length > 50) throw new Error('Too many actions (max 50)');
  return list.map(a => {
    if (!a || typeof a.device !== 'string' || !a.device) throw new Error('Each action needs a device');
    if (typeof a.capability !== 'string' || !/^[A-Za-z]{1,32}$/.test(a.capability)) throw new Error('Invalid action capability');
    if (!['string', 'number', 'boolean'].includes(typeof a.value)) throw new Error('Invalid action value');
    if (typeof a.value === 'string' && a.value.length > 100) throw new Error('Action value too long');
    return { device: a.device, capability: a.capability, value: a.value };
  });
}

function trigger(t) {
  if (!t || !['time', 'sunrise', 'sunset'].includes(t.type)) throw new Error('Trigger must be time, sunrise or sunset');
  const out = { type: t.type };
  if (t.type === 'time') {
    if (typeof t.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)) throw new Error('Time must be HH:MM');
    out.time = t.time;
  } else {
    const offset = Number(t.offset || 0);
    if (!Number.isInteger(offset) || Math.abs(offset) > 720) throw new Error('Offset must be whole minutes (±720)');
    out.offset = offset;
  }
  const days = t.days || [];
  if (!Array.isArray(days) || !days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('Invalid days');
  out.days = [...new Set(days)];
  return out;
}

// partial = update: validate only the fields present
function scene(data, partial = false) {
  const out = {};
  if (!partial || data.name !== undefined) out.name = name(data.name);
  if (!partial || data.actions !== undefined) out.actions = actions(data.actions);
  return out;
}

function automation(data, partial = false) {
  const out = {};
  if (!partial || data.name !== undefined) out.name = name(data.name);
  if (!partial || data.trigger !== undefined) out.trigger = trigger(data.trigger);
  if (!partial || data.actions !== undefined) out.actions = actions(data.actions);
  if (data.enabled !== undefined) out.enabled = Boolean(data.enabled);
  return out;
}

module.exports = { scene, automation };
