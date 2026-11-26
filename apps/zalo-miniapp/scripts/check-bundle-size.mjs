#!/usr/bin/env node
// Bundle gate for the Zalo Mini App (AGENTS.md §3: bundle < 4MB, no OpenCV.js / WASM OCR on the client).
// Measures every file Vite emitted into dist/ (raw bytes; gzip shown for information) and fails the build
// if the total reaches 4,000,000 bytes (decimal MB, stricter than 4 MiB) or if any WASM/OpenCV artefact exists.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(appDir, 'dist');
const LIMIT_BYTES = 4_000_000;
const FORBIDDEN = [/\.wasm$/i, /opencv/i, /tesseract/i];
const FORBIDDEN_CONTENT = [/opencv/i, /WebAssembly\.instantiate/, /tesseract/i];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(distDir).map((p) => {
  const buf = readFileSync(p);
  return { file: relative(distDir, p), bytes: buf.length, gzipBytes: gzipSync(buf).length, buf };
});
const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
const totalGzip = files.reduce((a, f) => a + f.gzipBytes, 0);

const problems = [];
for (const f of files) {
  if (FORBIDDEN.some((re) => re.test(f.file))) problems.push(`forbidden artefact: ${f.file}`);
  if (/\.(js|mjs|css|html)$/.test(f.file)) {
    const text = f.buf.toString('utf8');
    for (const re of FORBIDDEN_CONTENT) if (re.test(text)) problems.push(`forbidden content ${re} in ${f.file}`);
  }
}
if (totalBytes >= LIMIT_BYTES) problems.push(`bundle ${totalBytes} B >= limit ${LIMIT_BYTES} B`);

const report = {
  limitBytes: LIMIT_BYTES,
  totalBytes,
  totalGzipBytes: totalGzip,
  headroomBytes: LIMIT_BYTES - totalBytes,
  files: files.map(({ file, bytes, gzipBytes }) => ({ file, bytes, gzipBytes })).sort((a, b) => b.bytes - a.bytes),
  ok: problems.length === 0,
  problems,
};
const outDir = join(appDir, 'test-results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'bundle-size.json'), `${JSON.stringify(report, null, 2)}\n`);

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
console.log('Zalo Mini App bundle (dist/):');
for (const f of report.files) console.log(`  ${f.file.padEnd(48)} ${kb(f.bytes).padStart(10)}  gzip ${kb(f.gzipBytes)}`);
console.log(`  TOTAL ${kb(totalBytes)} (gzip ${kb(totalGzip)}) / limit ${kb(LIMIT_BYTES)}`);
if (problems.length) {
  console.error(`Bundle check FAILED:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('Bundle check OK: < 4 MB, no WASM/OpenCV.');
