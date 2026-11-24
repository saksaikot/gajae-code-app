import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { isPreparedWorktreePath, isSamePath } from './session-worktree-paths.js';

test('isSamePath folds separators and case on win32', () => {
  assert.equal(isSamePath('F:\\repo', 'f:/repo', 'win32'), true);
  assert.equal(isSamePath('F:\\Work\\Repo', 'f:/work/repo', 'win32'), true);
  assert.equal(isSamePath('F:\\repo', 'F:\\other', 'win32'), false);
});

test('isPreparedWorktreePath accepts the core forward-slash spelling on win32 and refuses other jobs and siblings', () => {
  const root = 'E:\\repo';
  assert.equal(isPreparedWorktreePath('E:/repo/.gjc-worktrees/job-1', root, 'job-1', 'win32'), true);
  assert.equal(isPreparedWorktreePath('E:/repo/.gjc-worktrees/job-2', root, 'job-1', 'win32'), false);
  assert.equal(isPreparedWorktreePath('E:/repo/.gjc-worktrees-x/job-1', root, 'job-1', 'win32'), false);
  assert.equal(isPreparedWorktreePath('E:/other/.gjc-worktrees/job-1', root, 'job-1', 'win32'), false);
  assert.equal(isPreparedWorktreePath(null, root, 'job-1', 'win32'), false);
});

test('isPreparedWorktreePath compares exactly on linux', () => {
  const expected = path.join('/repo', '.gjc-worktrees', 'job-1');
  assert.equal(isPreparedWorktreePath(expected, '/repo', 'job-1', 'linux'), true);
  assert.equal(isPreparedWorktreePath(expected.toUpperCase(), '/repo', 'job-1', 'linux'), false);
});

test('isSamePath treats /Repo and /repo as different on Linux and macOS', () => {
  assert.equal(isSamePath('/Repo', '/repo', 'linux'), false);
  assert.equal(isSamePath('/Repo', '/repo', 'darwin'), false);
  assert.equal(isSamePath('/repo', '/repo', 'linux'), true);
});
