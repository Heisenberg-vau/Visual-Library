/**
 * Detects text whose characters are wrong because of a broken font encoding
 * (selecting works, but copy/paste gives other letters), and repairs the
 * common case where every code is shifted by a constant: subset fonts that
 * expose glyph indices instead of Unicode (e.g. "Dqg" for "And").
 * Anything that cannot be repaired this way goes to OCR.
 */

const COMMON = new Set(
  (
    "the of and to in is a that for it as with was on be by are this or from at an which not have has can " +
    "but all were when one their there been more if will other its into than these only also used use may " +
    "each such most between both through after over under any should must where about air engine pressure " +
    "turbine compressor fuel flow temperature system fig figure page chapter section aircraft blade blades " +
    "combustion nozzle gas speed power high low stage shaft bearing oil control valve inlet outlet thrust " +
    "của và các là có được cho trong một những với không này để khi đến từ người theo về như ra đã sẽ " +
    "hoặc bằng trên dưới nhiệt độ áp suất động cơ máy bay hệ thống"
  ).split(/\s+/),
);

/** 0..1: how much this looks like real (English/Vietnamese) prose. */
export function textScore(text: string, tooShort = 1): number {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length < 4) return tooShort; // too little to judge
  let hits = 0;
  let letterish = 0;
  for (const t of tokens) {
    if (COMMON.has(t)) hits++;
    if (/^[\p{L}]+$/u.test(t)) letterish++;
  }
  const commonFrac = hits / tokens.length;
  const letterFrac = letterish / tokens.length;
  // Common words carry the signal; shifted gibberish is often still "letters".
  return Math.min(1, commonFrac * 2.2) * 0.9 + letterFrac * 0.1;
}

export function looksGarbled(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 40) return false;
  // Private-use / control characters are a sure sign.
  const odd = [...t].filter((c) => {
    const cp = c.codePointAt(0)!;
    return (cp < 32 && cp !== 9) || (cp >= 0xe000 && cp <= 0xf8ff) || cp === 0xfffd;
  }).length;
  if (odd / t.length > 0.05) return true;
  return textScore(t) < 0.12;
}

export function shiftText(s: string, d: number): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 32) {
      out += " ";
      continue;
    }
    const n = cp + d;
    out += n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : "�";
  }
  return out;
}

/**
 * Finds a constant code shift that turns the text into readable prose.
 * Returns the shift, or null if none clearly works.
 */
export function findShift(sample: string): number | null {
  const base = textScore(sample);
  let best = 0;
  let bestScore = base;
  for (let d = -120; d <= 120; d++) {
    if (d === 0) continue;
    const sc = textScore(shiftText(sample, d), 0); // a shift that destroys the words scores 0
    if (sc > bestScore) {
      bestScore = sc;
      best = d;
    }
  }
  return best !== 0 && bestScore >= 0.35 && bestScore > base + 0.2 ? best : null;
}
