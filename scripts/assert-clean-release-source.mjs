import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1 || argv[index + 1].startsWith('--'))
    throw new Error(`${name} requires a value`);
  return argv[index + 1];
};

const versionName = option('--version');
if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(versionName))
  throw new Error('A valid release VERSION_NAME is required before source verification.');

const expectedTag = `v${versionName}`;
const git = (...args) => execFileSync('git', args, {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
}).trim();

const status = git('status', '--porcelain=v1', '--untracked-files=all');
if (status) {
  throw new Error(
    'Production release requires clean committed source; tracked or untracked changes are present.',
  );
}

const commit = git('rev-parse', '--verify', 'HEAD^{commit}');
const tree = git('rev-parse', '--verify', 'HEAD^{tree}');
let taggedCommit = '';
try {
  taggedCommit = git('rev-parse', '--verify', `refs/tags/${expectedTag}^{commit}`);
} catch {
  throw new Error(`Production release requires exact tag ${expectedTag} on HEAD.`);
}
if (taggedCommit !== commit)
  throw new Error(`Production release tag ${expectedTag} does not point to HEAD.`);

const exactTags = git('tag', '--points-at', 'HEAD', '--list', expectedTag)
  .split(/\r?\n/).filter(Boolean);
if (!exactTags.includes(expectedTag))
  throw new Error(`Production release requires exact tag ${expectedTag} on HEAD.`);

const source = {
  commit,
  tree,
  exactTag: expectedTag,
  branch: git('branch', '--show-current'),
  dirty: false,
};

if (argv.includes('--json')) console.log(JSON.stringify(source));
else console.log(`Clean tagged release source verified: ${expectedTag} ${commit}`);
