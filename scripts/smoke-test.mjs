#!/usr/bin/env node
/**
 * Smoke test for the deep-link redirect page.
 *
 * Why this exists: check-redirect.mjs only reads text. It cannot tell that a
 * script has a syntax error, throws on load, or builds the wrong deep link, and
 * any of those dead-ends every shared link for every app version. This test
 * RUNS the page's inline scripts in a fake browser (node:vm, no dependencies)
 * and asserts what a user would get.
 *
 * It is not a browser. It proves the logic, not iOS timing: the redirect
 * position (end of <body>) is still guarded by check-redirect.mjs and was
 * settled on a device.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PAGE = 'BYOB-Invite';
// [query string, expected deep link, or null when the page must show "incomplete"]
const REDIRECT_CASES = [["?matchId=abc123", "byobsports://matches/abc123"], ["?groupId=g-9", "byobsports://groups/g-9"], ["?matchId=m1&groupId=g1", "byobsports://matches/m1"], ["?matchId=a%20b%2Fc", "byobsports://matches/a%20b%2Fc"], ["?matchId=m1&invite_token=tok", "byobsports://matches/m1"], ["", null], ["?foo=bar", null], ["?matchId=", null]];

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ---- static facts about the document ---------------------------------------

const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
check(
  scriptTags.every((m) => !/\bsrc\s*=/i.test(m[1])),
  'an external <script src> is present: only inline scripts may ship on this page',
);
const scripts = scriptTags.map((m) => m[2]);
check(scripts.length > 0, 'no inline script found');

/** Drop comments so prose such as "let the app" cannot trip the ES5 check. */
const withoutComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}()])\/\/[^\n]*/g, '$1');

const NOT_ES5 = [
  [/=>/, 'arrow function'],
  [/\b(?:let|const)\s/, 'let/const'],
  [/`/, 'template literal'],
  [/\?\.|\?\?/, 'optional chaining / nullish coalescing'],
  [/\basync\b|\bawait\b/, 'async/await'],
  [/\bclass\s+\w/, 'class'],
  [/\.\.\./, 'spread'],
];
scripts.forEach((code, i) => {
  const bare = withoutComments(code);
  for (const [pattern, label] of NOT_ES5) {
    check(!pattern.test(bare), `script ${i + 1} uses ${label}: keep the page ES5 for old iOS Safari`);
  }
});

// ---- a minimal fake browser -------------------------------------------------

/**
 * Runs every inline script, in document order, against a fake page at `search`.
 * A script that throws does not stop the next one, as in a real browser.
 */
function run(search, options = {}) {
  const {
    userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    visibilityState = 'visible',
    webdriver = false,
    sendBeacon = 'ok', // 'ok' | 'throws' | 'missing'
  } = options;

  const navigations = [];
  const beacons = [];
  const elements = {};
  const element = (id) => (elements[id] ??= { textContent: '', href: '' });

  const location = { search };
  Object.defineProperty(location, 'href', {
    get: () => `https://byob-sports.github.io/${PAGE}/${search}`,
    set: (value) => navigations.push(value),
  });

  const navigator = { userAgent, webdriver };
  if (sendBeacon !== 'missing') {
    navigator.sendBeacon = (url, body) => {
      if (sendBeacon === 'throws') throw new Error('beacon blocked');
      beacons.push({ url, body: String(body) });
      return true;
    };
  }

  const document = {
    hidden: false,
    visibilityState,
    getElementById: element,
    addEventListener: () => {},
  };
  const window = { location, close: () => {}, navigator, document };
  window.window = window;

  const context = vm.createContext({ window, document, navigator, URLSearchParams, location });
  const errors = [];
  for (const code of scripts) {
    try {
      vm.runInContext(code, context, { timeout: 1000 });
    } catch (error) {
      errors.push(String(error));
    }
  }

  const events = beacons.map((b) => {
    const data = new URLSearchParams(b.body).get('data');
    return { url: b.url, event: data ? JSON.parse(data) : null, raw: b.body };
  });
  return { navigations, elements, errors, events };
}

// ---- redirect behaviour ------------------------------------------------------

for (const [search, expected] of REDIRECT_CASES) {
  const label = `${PAGE}${search || '(no query)'}`;
  const result = run(search);
  check(result.errors.length === 0, `${label}: a script threw: ${result.errors.join('; ')}`);
  if (expected === null) {
    check(result.navigations.length === 0, `${label}: navigated although the link is incomplete`);
    check(
      /incomplete/i.test(result.elements.heading?.textContent ?? ''),
      `${label}: did not show the "incomplete" message`,
    );
    check(result.elements.open?.href === 'byobsports://', `${label}: fallback button should open byobsports://`);
  } else {
    check(
      result.navigations.length === 1 && result.navigations[0] === expected,
      `${label}: expected exactly one navigation to ${expected}, got ${JSON.stringify(result.navigations)}`,
    );
    check(result.elements.open?.href === expected, `${label}: the button href should equal the deep link`);
  }
}


if (failures.length) {
  console.error(`Smoke test FAILED (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK — ${PAGE}: smoke test passed (${REDIRECT_CASES.length} redirect cases).`);
