// Publish dist/web to the gh-pages branch, which GitHub Pages serves.
// Usage: npm run build:web && npm run deploy
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const remote =
  process.env.DEPLOY_REMOTE ??
  execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

if (!existsSync('dist/web/index.html')) {
  console.error('dist/web is missing. Run `npm run build:web` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'apixray-pages-'));
try {
  cpSync('dist/web', dir, { recursive: true });
  writeFileSync(join(dir, '.nojekyll'), '');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'inherit' });
  git('init', '-q', '-b', 'gh-pages');
  git('-c', 'core.autocrlf=false', 'add', '-A');
  const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
  const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
  git(
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    'commit',
    '-q',
    '-m',
    `Deploy ${sha}`,
  );
  git('push', '-q', '-f', remote, 'gh-pages');
  console.log(`Deployed ${sha} to gh-pages.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
