// Verifies that every text/background colour pair the stylesheet actually uses
// together clears WCAG AA, in both the light and the dark theme.
//
//   node scripts/check-contrast.mjs
//
// Reads the tokens straight out of assets/styles.css, so it fails the moment
// someone edits a colour to something unreadable rather than months later.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(
  fileURLToPath(new URL('../assets/styles.css', import.meta.url)), 'utf8'
);

/* The stylesheet declares :root twice — once plainly, once inside the
 * prefers-color-scheme: dark block. Take them in order. */
function tokensFrom(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2].length === 4
      ? '#' + [...m[2].slice(1)].map(c => c + c).join('')
      : m[2];
  }
  return out;
}

const rootBlocks = [...CSS.matchAll(/:root\s*\{([^}]*)\}/g)].map(m => m[1]);
if (rootBlocks.length < 2) {
  console.error('Expected at least two :root blocks (light and dark).');
  process.exit(2);
}
const light = tokensFrom(rootBlocks[0]);
const dark = { ...light, ...tokensFrom(rootBlocks[1]) };

// Pairs that genuinely co-occur, with the rule each has to meet.
// 4.5 = normal text, 3 = large text and non-text indicators (borders, bars).
const PAIRS = [
  ['ink', 'panel', 4.5, 'body text on cards'],
  ['ink', 'bg', 4.5, 'body text on the page'],
  ['ink-soft', 'panel', 4.5, '.seg-label, field labels'],
  ['ink-soft', 'bg', 4.5, '.meta under the heading'],
  ['ink-soft', 'panel-sunk', 4.5, 'table headers'],
  ['ink-faint', 'panel', 4.5, '.room-sub, .note, footer'],
  ['ink-faint', 'bg', 4.5, '.note on the page background'],
  ['ink-faint', 'panel-sunk', 4.5, '.open-desc, .daybar-scale'],
  ['busy-ink', 'busy-bg', 4.5, '.tag.busy'],
  ['open-ink', 'open-bg', 4.5, '.tag.free / OPEN'],
  ['gap-ink', 'gap-bg', 4.5, '.tag.gap'],
  ['current', 'panel', 4.5, '.status-CURRENT'],
  ['upcoming', 'panel', 4.5, '.status-UPCOMING'],
  ['accent-ink', 'accent', 4.5, 'active view toggle, primary button'],
  ['panel', 'open-mark', 4.5, '.now-badge text on its fill'],
  ['focus', 'panel', 3, 'focus ring against a card'],
  ['focus', 'bg', 3, 'focus ring against the page'],
  ['open-mark', 'panel', 3, 'day bar open segment'],
  ['busy-mark', 'panel', 3, 'day bar busy segment'],
  // --line is decorative (card edges, row dividers) and is exempt from 1.4.11;
  // --line-strong is what identifies an actual control, so it is not.
  ['line-strong', 'panel', 3, 'input, button and toggle borders'],
  ['line-strong', 'bg', 3, 'control borders against the page'],
];

const srgb = c => (c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
function lum(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;

for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  console.log(`\n${themeName}`);
  for (const [fg, bg, need, where] of PAIRS) {
    if (!theme[fg] || !theme[bg]) {
      console.log(`  ??    --.--   ${fg} / ${bg} — token missing`);
      failures++;
      continue;
    }
    const r = ratio(theme[fg], theme[bg]);
    const ok = r >= need;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1 (need ${need})  ` +
      `${fg} on ${bg} — ${where}`
    );
  }
}

console.log(failures
  ? `\n${failures} contrast failure(s)`
  : `\nAll ${PAIRS.length * 2} pairs pass.`);
process.exit(failures ? 1 : 0);
