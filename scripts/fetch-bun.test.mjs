import assert from 'node:assert/strict';
import test from 'node:test';

import { executableFileName } from '../shared/executableFileName.js';

import { PLATFORMS } from './fetch-bun.mjs';

test('PLATFORMS pins the Windows x64 Bun archive and its bun.exe', () => {
  const windows = PLATFORMS['win32-x64'];
  assert.equal(windows.archive, 'bun-windows-x64.zip');
  assert.equal(windows.binary, 'bun-windows-x64/bun.exe');
  assert.match(windows.archiveSha256, /^[0-9a-f]{64}$/);
  assert.match(windows.binarySha256, /^[0-9a-f]{64}$/);
});

test('executableFileName adds .exe on win32 only', () => {
  assert.equal(executableFileName('bun', 'win32'), 'bun.exe');
  assert.equal(executableFileName('gajae-core', 'win32'), 'gajae-core.exe');
  assert.equal(executableFileName('bun', 'linux'), 'bun');
  assert.equal(executableFileName('bun', 'darwin'), 'bun');
});
