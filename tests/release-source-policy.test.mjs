import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../scripts/assert-clean-release-source.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'discipline-release-source-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.name', 'Release Gate Test');
  git(cwd, 'config', 'user.email', 'release-gate@example.invalid');
  writeFileSync(join(cwd, 'source.txt'), 'committed\n');
  git(cwd, 'add', 'source.txt');
  git(cwd, 'commit', '--quiet', '-m', 'fixture');
  git(cwd, 'tag', 'v1.2.3');
  return cwd;
}

function verify(cwd, version = '1.2.3') {
  return spawnSync(process.execPath, [gate, '--version', version, '--json'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
}

test('production source gate records the clean commit, tree, and exact release tag', (t) => {
  const cwd = repository(t);
  const result = verify(cwd);
  assert.equal(result.status, 0, result.stderr);
  const source = JSON.parse(result.stdout);
  assert.equal(source.commit, git(cwd, 'rev-parse', 'HEAD^{commit}'));
  assert.equal(source.tree, git(cwd, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(source.exactTag, 'v1.2.3');
  assert.equal(source.dirty, false);
});

test('production source gate rejects a dirty tracked file', (t) => {
  const cwd = repository(t);
  appendFileSync(join(cwd, 'source.txt'), 'dirty tracked change\n');
  const result = verify(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked or untracked changes are present/);
  assert.equal(result.stdout, '');
});

test('production source gate rejects an untracked file', (t) => {
  const cwd = repository(t);
  writeFileSync(join(cwd, 'untracked.txt'), 'not committed\n');
  const result = verify(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tracked or untracked changes are present/);
  assert.equal(result.stdout, '');
});

test('production source gate rejects HEAD without the exact version tag', (t) => {
  const cwd = repository(t);
  const result = verify(cwd, '1.2.4');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires exact tag v1\.2\.4 on HEAD/);
  assert.equal(result.stdout, '');
});
