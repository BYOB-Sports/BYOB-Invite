#!/usr/bin/env node
/**
 * Blocks the blank-page regression on the BYOB Sports deep-link redirect pages.
 *
 * The bug this exists to stop: assigning `window.location` from a <script> in
 * <head> commits a navigation before the parser has reached <body>. iOS Safari
 * hands the byobsports:// URL to the app — so the redirect "works" — but the
 * tab left behind never got a body. The user switches back to Safari and finds
 * a blank white page, with the "open the app" fallback link that was supposed
 * to rescue them never rendered.
 *
 * The invariant is deliberately a bright line rather than a heuristic: no
 * navigation statement may appear anywhere inside <head>. Putting the redirect
 * after </head> is the only shape that guarantees a parsed body, and it is
 * trivially checkable without parsing JavaScript. A "is it wrapped in a
 * DOMContentLoaded handler?" rule would be more permissive and less certain.
 *
 * Verified to FAIL on every pre-fix page (see check-redirect.test.mjs).
 */

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const NAVIGATION = /(?:window\s*\.\s*)?location\s*(?:\.\s*(?:href|replace|assign)\s*(?:=[^=]|\()|=[^=])/;

/** Every .html file under `root`, skipping the usual noise directories. */
function htmlFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.html')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * The <head> region, or null when the document has no explicit head.
 *
 * Matched case-insensitively because the tag casing is not the thing under
 * test — a page that shouted `<HEAD>` would otherwise skip the check silently.
 */
function headRegion(html) {
  const open = html.search(/<head[\s>]/i);
  const close = html.search(/<\/head\s*>/i);
  if (open === -1 || close === -1 || close < open) return null;
  return html.slice(open, close);
}

const root = process.argv[2] ?? '.';
const failures = [];

for (const file of htmlFiles(root)) {
  const html = readFileSync(file, 'utf8');
  const head = headRegion(html);
  if (head === null) continue;

  head.split('\n').forEach((line, i) => {
    if (!NAVIGATION.test(line)) return;
    // `location.search` / `location.hash` reads are fine — only navigation is
    // parser-blocking. The regex already requires an assignment or a call, so
    // a bare read never reaches here.
    failures.push({
      file: relative(root, file) || file,
      line: i + 1,
      text: line.trim(),
    });
  });
}

if (!failures.length) {
  console.log('OK — no navigation inside <head> in any HTML file.');
  process.exit(0);
}

console.error('Navigation found inside <head>. This ships a blank page on iOS Safari.\n');
for (const f of failures) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.text}`);
}
console.error(
  '\nMove the redirect to a <script> after </head>, at the end of <body>, so the\n' +
  'page paints before it navigates. See the comment at the top of this file.'
);
process.exit(1);
