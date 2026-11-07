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
const SURFACE_CASES = [["?matchId=m-SECRET1", "match", "m-SECRET1"], ["?groupId=g-SECRET2", "group", "g-SECRET2"]];

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
    // Measured on iOS Safari (iOS 26.5 simulator): once a script assigns
    // location to the byobsports:// scheme, no later script on the page runs.
    // Anything that must happen (the beacon) therefore has to run BEFORE it.
    if (navigations.length > 0) break;
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

// ---- beacon ------------------------------------------------------------------

check(scripts.length === 2, `expected exactly 2 inline scripts (beacon, then redirect), found ${scripts.length}`);
if (scripts.length === 2) {
  check(/sendBeacon/.test(scripts[0]), 'the FIRST script must be the beacon: scripts after the redirect never run on iOS Safari');
  check(!/location\s*\.\s*href\s*=/.test(scripts[0]), 'the beacon script must never navigate');
  check(/location\s*\.\s*href\s*=/.test(scripts[1]), 'the LAST script must be the redirect');
  check(!/sendBeacon/.test(scripts[1]), 'the redirect script must not know about the beacon');
}

const ALLOWED_PROPS = [
  '$insert_id',
  'distinct_id',
  'link_id',
  'page',
  'surface',
  'time',
  'token',
  'ua_class',
];

for (const [search, expectedSurface, secret] of SURFACE_CASES) {
  const label = `${PAGE}${search}`;
  const result = run(search);
  check(result.errors.length === 0, `${label}: a script threw: ${result.errors.join('; ')}`);
  check(result.events.length === 1, `${label}: expected one beacon, got ${result.events.length}`);
  const sent = result.events[0];
  if (!sent) continue;
  check(sent.url === 'https://api.mixpanel.com/track', `${label}: beacon went to ${sent.url}`);
  check(sent.event?.event === 'Link Page Viewed', `${label}: wrong event name`);
  const props = sent.event?.properties ?? {};
  check(
    Object.keys(props).sort().join() === ALLOWED_PROPS.join(),
    `${label}: properties must be exactly ${ALLOWED_PROPS.join(', ')}; got ${Object.keys(props).sort().join(', ')}`,
  );
  check(props.surface === expectedSurface, `${label}: surface should be ${expectedSurface}, got ${props.surface}`);
  check(props.page === PAGE, `${label}: page should be ${PAGE}`);
  check(props.ua_class === 'ios', `${label}: ua_class should be ios`);
  check(String(props.distinct_id).startsWith('lp-'), `${label}: distinct_id must be random and prefixed lp-`);
  check(Number.isInteger(props.time), `${label}: time must be integer milliseconds`);
  // The entity id is the one thing the page knows that must never leave it.
  check(!sent.raw.includes(secret), `${label}: the entity id "${secret}" leaked into the beacon`);
}

// sl handling: a valid id is forwarded and reported; anything else is dropped.
{
  const [base, surface, secret] = SURFACE_CASES[0];
  const joiner = base.includes('?') ? '&' : '?';
  const good = run(`${base}${joiner}sl=abcd1234`);
  check(
    good.navigations.length === 1 && good.navigations[0].endsWith('?sl=abcd1234'),
    `valid sl must be forwarded to the deep link, got ${JSON.stringify(good.navigations)}`,
  );
  check(good.events[0]?.event.properties.link_id === 'abcd1234', 'valid sl must be reported as link_id');

  const none = run(base);
  check(!none.navigations[0]?.includes('sl='), 'no sl in the link means none in the deep link');
  check(none.events[0]?.event.properties.link_id === null, 'no sl means link_id null');

  for (const bad of ['ABCD1234', 'abcd123', 'abcd12345', 'abcd123!', 'abcd%0a123', '', 'abcd1234%26x=1', '%3Cscript%3E']) {
    const r = run(`${base}${joiner}sl=${bad}`);
    check(
      r.navigations.length === 1 && !r.navigations[0].includes('sl='),
      `malformed sl "${bad}" must not reach the deep link, got ${JSON.stringify(r.navigations)}`,
    );
    check(r.events[0]?.event.properties.link_id === null, `malformed sl "${bad}" must be reported as null`);
  }

  // The beacon is best effort and must never affect the redirect.
  for (const mode of ['throws', 'missing']) {
    const r = run(base, { sendBeacon: mode });
    check(r.navigations.length === 1, `sendBeacon ${mode}: the redirect must still happen`);
    check(r.errors.length === 0, `sendBeacon ${mode}: a script threw: ${r.errors.join('; ')}`);
  }

  // Background loads, automation and malformed links are not views.
  check(run(base, { visibilityState: 'hidden' }).events.length === 0, 'a hidden page must not beacon');
  check(run(base, { webdriver: true }).events.length === 0, 'an automated browser must not beacon');
  check(run('').events.length === 0, 'an incomplete link must not beacon');

  const android = run(base, { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' });
  check(android.events[0]?.event.properties.ua_class === 'android', 'Android user agent should map to android');
  const desktop = run(base, { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  check(desktop.events[0]?.event.properties.ua_class === 'other', 'desktop user agent should map to other');

  // Two views must not share an identity or a dedupe key.
  const a = run(base).events[0]?.event.properties;
  const b = run(base).events[0]?.event.properties;
  check(a && b && a.distinct_id !== b.distinct_id, 'distinct_id must differ between page views');
  check(a && b && a.$insert_id !== b.$insert_id, '$insert_id must differ between page views');
  void surface;
  void secret;
}

if (failures.length) {
  console.error(`Smoke test FAILED (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK — ${PAGE}: smoke test passed (${REDIRECT_CASES.length} redirect cases).`);
