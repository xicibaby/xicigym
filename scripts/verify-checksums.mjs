/**
 * Generate or verify SHA256SUMS.txt for the delivery tree.
 *
 * Usage:
 *   node scripts/verify-checksums.mjs            # verify every listed file
 *   node scripts/verify-checksums.mjs --write    # regenerate SHA256SUMS.txt
 *
 * Excluded from the manifest: node_modules, .git, local drill data
 * (artifacts/step22/source, artifacts/step22/backup, artifacts/step23/sqlite) and the manifest itself.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = join(root, 'SHA256SUMS.txt');
const excludedTop = new Set(['node_modules', '.git']);
const excludedPaths = ['artifacts/step22/source', 'artifacts/step22/backup', 'artifacts/step23/sqlite', 'artifacts/staging-rehearsal/local'];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = relative(root, full).split(sep).join('/');
      if (excludedTop.has(entry.name) || excludedPaths.includes(rel)) continue;
      files.push(...await walk(full));
    } else if (entry.isFile()) {
      const rel = relative(root, full).split(sep).join('/');
      if (rel === 'SHA256SUMS.txt') continue;
      if (excludedPaths.some((prefix) => rel.startsWith(`${prefix}/`))) continue;
      files.push(rel);
    }
  }
  return files;
}

async function hashOf(relPath) {
  const data = await readFile(join(root, relPath));
  return createHash('sha256').update(data).digest('hex');
}

const write = process.argv.includes('--write');
const files = (await walk(root)).sort();

if (write) {
  const lines = [];
  for (const relPath of files) lines.push(`${await hashOf(relPath)}  ${relPath}`);
  await writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`SHA256SUMS.txt written with ${lines.length} entries.`);
} else {
  let manifest;
  try { manifest = await readFile(manifestPath, 'utf8'); }
  catch { console.error('SHA256SUMS.txt not found; run with --write first.'); process.exit(1); }
  const entries = manifest.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) throw new Error(`Malformed manifest line: ${line}`);
    return { hash: match[1], path: match[2] };
  });
  const mismatches = [];
  for (const entry of entries) {
    let actual;
    try { actual = await hashOf(entry.path); }
    catch { mismatches.push({ path: entry.path, reason: 'missing' }); continue; }
    if (actual !== entry.hash) mismatches.push({ path: entry.path, reason: 'hash-mismatch' });
  }
  if (mismatches.length) {
    console.error(`CHECKSUM FAILED: ${mismatches.length} problem(s)`);
    for (const item of mismatches) console.error(`- ${item.path}: ${item.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`CHECKSUM OK: ${entries.length} files verified.`);
  }
}
