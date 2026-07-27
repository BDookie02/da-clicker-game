import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUsername } from '../server/username-policy.js';

test('accepts ordinary usernames', () => {
  for (const name of ['RoadKing', 'Jojo_77', 'AceDriver']) assert.equal(validateUsername(name), null);
});

test('rejects invalid and reserved usernames', () => {
  assert.equal(validateUsername('ab'), 'invalid_username');
  assert.equal(validateUsername('admin'), 'reserved_username');
  assert.equal(validateUsername('Discipline'), 'reserved_username');
});

test('rejects inappropriate names and basic evasions', () => {
  for (const name of ['f_u_c_k', 'N1GGER', 'd1ckhead', 'p0rnst4r', 'Hitlerr'])
    assert.equal(validateUsername(name), 'inappropriate_username', name);
});
