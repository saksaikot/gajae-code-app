import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { isSamePath } from './session-worktree-paths.js';

test('isSamePath folds separators and case on win32', () => {
  assert.equal(isSamePath('F:\\repo', 'f:/repo', 'win32'), true);
  assert.equal(isSamePath('F:\\Work\\Repo', 'f:/work/repo', 'win32'), true);
  assert.equal(isSamePath('F:\\repo', 'F:\\other', 'win32'), false);
});

test('isSamePath accepts the core forward-slash worktree spelling on win32 and refuses other jobs and siblings', () => {
  const expected = path.win32.join('E:\\repo', '.gjc-worktrees', 'job-1');
  assert.equal(isSamePath('E:/repo/.gjc-worktrees/job-1', expected, 'win32'), true);
  assert.equal(isSamePath('E:/repo/.gjc-worktrees/job-2', expected, 'win32'), false);
  assert.equal(isSamePath('E:/repo/.gjc-worktrees-x/job-1', expected, 'win32'), false);
  assert.equal(isSamePath('E:/other/.gjc-worktrees/job-1', expected, 'win32'), false);
});

test('isSamePath compares worktree paths exactly on linux', () => {
  const expected = path.posix.join('/repo', '.gjc-worktrees', 'job-1');
  assert.equal(isSamePath(expected, expected, 'linux'), true);
  assert.equal(isSamePath(expected.toUpperCase(), expected, 'linux'), false);
});

test('isSamePath treats /Repo and /repo as different on Linux and macOS', () => {
  assert.equal(isSamePath('/Repo', '/repo', 'linux'), false);
  assert.equal(isSamePath('/Repo', '/repo', 'darwin'), false);
  assert.equal(isSamePath('/repo', '/repo', 'linux'), true);
});
