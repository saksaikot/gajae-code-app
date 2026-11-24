import assert from 'node:assert/strict';
import test from 'node:test';

import { isSamePath } from './session-worktree-paths.js';

test('isSamePath folds separators and case on win32', () => {
  assert.equal(isSamePath('F:\\repo', 'f:/repo', 'win32'), true);
  assert.equal(isSamePath('F:\\Work\\Repo', 'f:/work/repo', 'win32'), true);
  assert.equal(isSamePath('F:\\repo', 'F:\\other', 'win32'), false);
});

test('isSamePath treats /Repo and /repo as different on Linux and macOS', () => {
  assert.equal(isSamePath('/Repo', '/repo', 'linux'), false);
  assert.equal(isSamePath('/Repo', '/repo', 'darwin'), false);
  assert.equal(isSamePath('/repo', '/repo', 'linux'), true);
});
