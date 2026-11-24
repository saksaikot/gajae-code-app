import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeClosurePath } from './fill-runtime-manifest.mjs';

test('nativeClosurePath joins with / on every platform', () => {
  assert.equal(nativeClosurePath('x.node'), 'native/x.node');
});
