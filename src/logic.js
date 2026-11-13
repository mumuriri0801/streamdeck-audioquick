'use strict';
// Pure decision logic - no Stream Deck or Windows dependencies, so it can be unit-tested anywhere.
//
// Core idea: a device is remembered by its *name*, never by its Windows endpoint ID.
// Windows hands out a new ID (and often a "2- " style counter in the name) whenever it
// re-installs a device, so IDs are only ever looked up at the moment a key is pressed.

/** Descriptions that say nothing about which device it is; the part in parentheses is more useful. */
const GENERIC_DESCRIPTIONS = [
  '喇叭', '揚聲器', '耳機', '耳機喇叭', '耳機麥克風', '耳麥式麥克風', '麥克風', '麥克風排列', '數位輸出', '線路輸入',
  'speakers', 'speaker', 'headphones', 'headphone', 'headset', 'headset earphone', 'headset microphone',
  'microphone', 'microphone array', 'digital output', 'line in', 'line',
];

/** Removes the "2- " style counter Windows inserts when it re-installs a device, and tidies whitespace. */
function normalizeName(name) {
  return String(name == null ? '' : name)
    .replace(/\(\d+- /, '(')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

function sameName(a, b) {
  const ka = nameKey(a);
  return ka !== '' && ka === nameKey(b);
}

/** First active device of the given flow whose (normalised) name matches. */
function findDevice(snapshot, flow, name) {
  if (!snapshot || !name) return null;
  return snapshot.devices.find((d) => d.flow === flow && sameName(d.name, name)) || null;
}

function deviceById(snapshot, id) {
  if (!snapshot || !id) return null;
  return snapshot.devices.find((d) => d.id === id) || null;
}

/** Normalised, de-duplicated names of the active devices of one flow (for the settings page). */
function deviceNames(snapshot, flow) {
  const seen = new Set();
  const names = [];
  if (!snapshot) return names;
  for (const d of snapshot.devices) {
    if (d.flow !== flow) continue;
    const key = nameKey(d.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(normalizeName(d.name));
  }
  return names;
}

/** A short label derived from the device name, used when the user has not typed one. */
function autoLabel(name) {
  const n = normalizeName(name);
  const open = n.indexOf(' (');
  if (open > 0 && n.endsWith(')')) {
    const description = n.slice(0, open).trim();
    const inner = n.slice(open + 2, -1).trim();
    if (inner && GENERIC_DESCRIPTIONS.includes(description.toLowerCase())) return inner;
    return description;
  }
  return n;
}

function charWidth(ch) {
  const code = ch.codePointAt(0);
  // CJK, kana, hangul and full-width forms take roughly two Latin columns on a key.
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
}

function textWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Wraps a title so it fits on a key: at most maxLines lines of maxWidth columns, "…" when cut. */
function wrapTitle(text, maxWidth = 10, maxLines = 3) {
  const source = String(text == null ? '' : text).trim();
  if (!source) return '';
  if (source.includes('\n')) return source; // the user chose their own line breaks

  // Split into tokens: words (kept whole when possible) and single wide characters.
  const tokens = [];
  for (const word of source.split(/\s+/)) {
    let buffer = '';
    for (const ch of word) {
      if (charWidth(ch) === 2) {
        if (buffer) { tokens.push({ text: buffer, glue: false }); buffer = ''; }
        tokens.push({ text: ch, glue: false });
      } else {
        buffer += ch;
      }
    }
    if (buffer) tokens.push({ text: buffer, glue: false });
    if (tokens.length) tokens[tokens.length - 1].space = true; // a space followed this token
  }

  const lines = [];
  let line = '';
  let truncated = false;
  const push = () => { lines.push(line.trimEnd()); line = ''; };

  for (let token of tokens) {
    let piece = token.text;
    // A single word longer than a line is broken hard.
    while (textWidth(piece) > maxWidth) {
      if (line.trim()) push();
      let head = '';
      for (const ch of piece) {
        if (textWidth(head + ch) > maxWidth) break;
        head += ch;
      }
      line = head;
      push();
      piece = piece.slice(head.length);
    }
    if (textWidth(line + piece) > maxWidth) push();
    line += piece + (token.space ? ' ' : '');
  }
  if (line.trim()) push();

  if (lines.length > maxLines) {
    truncated = true;
    lines.length = maxLines;
  }
  if (truncated) {
    let last = lines[maxLines - 1];
    while (last && textWidth(last + '…') > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '…';
  }
  return lines.join('\n');
}

const ICONS = ['speaker', 'headphones', 'monitor', 'mic'];

/** Picks a key icon from the device name when the user left it on "auto". */
function guessIcon(name, flow) {
  const n = nameKey(name);
  if (flow === 'capture') return 'mic';
  if (/headset|headphone|earphone|earbud|airpods|耳機/.test(n)) return 'headphones';
  if (/hdmi|displayport|nvidia|amd high definition|intel\(r\) display|monitor|螢幕|顯示器/.test(n)) return 'monitor';
  return 'speaker';
}

function iconFor(entry, name, flow) {
  if (entry && ICONS.includes(entry.icon)) return entry.icon;
  return guessIcon(name, flow);
}

function switchEntries(settings) {
  const list = settings && Array.isArray(settings.devices) ? settings.devices : [];
  return list.filter((e) => e && typeof e.name === 'string' && e.name.trim() !== '');
}

function switchFlow(settings) {
  return settings && settings.flow === 'capture' ? 'capture' : 'render';
}

/**
 * Decides what a press of the "switch" key should do.
 * Returns { device, entry } to switch, { noop: true } when already there, or { error }.
 */
function planSwitch(snapshot, settings) {
  if (!snapshot) return { error: 'host' };
  const flow = switchFlow(settings);
  const entries = switchEntries(settings);
  if (entries.length === 0) return { error: 'unset' };

  const currentId = snapshot.defaults[flow];
  const current = deviceById(snapshot, currentId);

  if (entries.length === 1) {
    // "Set" behaviour: always (re)apply, so the communications role is fixed too.
    const device = findDevice(snapshot, flow, entries[0].name);
    return device ? { device, entry: entries[0] } : { error: 'unavailable' };
  }

  const index = current ? entries.findIndex((e) => sameName(e.name, current.name)) : -1;
  for (let step = 1; step <= entries.length; step++) {
    const entry = entries[(index + step + entries.length) % entries.length];
    const device = findDevice(snapshot, flow, entry.name);
    if (!device) continue; // unplugged / powered off: skip it
    if (device.id === currentId) return { noop: true }; // came full circle
    return { device, entry };
  }
  return { error: 'unavailable' };
}

/** What the "switch" key should show: { icon, lit, title }. */
function describeSwitch(snapshot, settings) {
  if (!snapshot) return { icon: 'error', lit: false, title: '音訊服務\n未就緒' };
  const flow = switchFlow(settings);
  const entries = switchEntries(settings);
  const showTitle = !settings || settings.showTitle !== false;
  if (entries.length === 0) return { icon: 'unset', lit: false, title: '未設定' };

  const current = deviceById(snapshot, snapshot.defaults[flow]);
  const title = (entry, name) => (showTitle ? wrapTitle((entry && entry.label && entry.label.trim()) || autoLabel(name)) : '');

  if (entries.length === 1) {
    const entry = entries[0];
    const lit = !!current && sameName(current.name, entry.name);
    return { icon: iconFor(entry, entry.name, flow), lit, title: title(entry, entry.name) };
  }

  if (!current) return { icon: flow === 'capture' ? 'mic' : 'speaker', lit: false, title: showTitle ? '無裝置' : '' };
  const entry = entries.find((e) => sameName(e.name, current.name));
  if (entry) return { icon: iconFor(entry, current.name, flow), lit: true, title: title(entry, current.name) };
  // The system is on a device that is not part of this key's list.
  return { icon: guessIcon(current.name, flow), lit: false, title: title(null, current.name) };
}

/** Capture devices a "mic mute" key acts on. */
function muteTargets(snapshot, settings) {
  if (!snapshot) return [];
  const capture = snapshot.devices.filter((d) => d.flow === 'capture');
  const target = settings && settings.target;
  if (target === 'all') return capture;
  if (target === 'device') {
    const device = findDevice(snapshot, 'capture', settings.name);
    return device ? [device] : [];
  }
  const id = target === 'communications' ? snapshot.defaults.captureCommunications : snapshot.defaults.capture;
  const device = deviceById(snapshot, id);
  return device ? [device] : [];
}

/** { available, muted } for a "mic mute" key. */
function describeMute(snapshot, settings) {
  const targets = muteTargets(snapshot, settings);
  return { available: targets.length > 0, muted: targets.length > 0 && targets.every((d) => d.muted) };
}

module.exports = {
  ICONS,
  normalizeName,
  sameName,
  findDevice,
  deviceById,
  deviceNames,
  autoLabel,
  wrapTitle,
  guessIcon,
  planSwitch,
  describeSwitch,
  muteTargets,
  describeMute,
  switchFlow,
  switchEntries,
};
