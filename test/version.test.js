import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../src/version.js';

test('reported service version matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});
