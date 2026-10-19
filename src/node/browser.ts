import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Chrome-family browsers apixray can drive, in order of preference. */
export function browserCandidates(env = process.env, platform = process.platform): string[] {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      Boolean,
    ) as string[];
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'Chromium\\Application\\chrome.exe',
    ];
    return rel.flatMap((r) => roots.map((root) => join(root, r)));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  const names = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'brave-browser',
  ];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => join(d, n)));
}

export function findBrowser(explicit?: string): string | null {
  const choice = explicit ?? process.env.APIXRAY_BROWSER;
  if (choice) return existsSync(choice) ? choice : null;
  return browserCandidates().find((p) => existsSync(p)) ?? null;
}

export interface LaunchedBrowser {
  process: ChildProcess;
  wsUrl: string;
  profileDir: string;
  /** Resolves when the browser process exits (the user closed it). */
  exited: Promise<void>;
  kill(): void;
}

export interface LaunchOptions {
  executable: string;
  url: string;
  headless?: boolean;
  /** Keep logins between recordings by reusing this profile folder. */
  profileDir?: string;
}

export async function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
  const temporary = !opts.profileDir;
  const profileDir = opts.profileDir ?? mkdtempSync(join(tmpdir(), 'apixray-profile-'));
  const portFile = join(profileDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
  ];
  if (opts.headless) args.push('--headless=new');
  args.push(opts.url);
  const child = spawn(opts.executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let failed: Error | null = null;
  child.once('error', (err) => {
    failed = err;
  });

  // Chrome writes the port it picked to DevToolsActivePort in the profile folder.
  const deadline = Date.now() + 20_000;
  let wsUrl = '';
  while (!wsUrl) {
    if (failed) throw failed;
    if (child.exitCode !== null) {
      throw new Error(
        `The browser exited before it was ready (code ${child.exitCode}). If it is already running with this profile, close it or pass --profile <new folder>.${stderr ? `\n${stderr.trim()}` : ''}`,
      );
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('Timed out waiting for the browser to open its DevTools port.');
    }
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (port && path) wsUrl = `ws://127.0.0.1:${port}${path}`;
    }
    if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
  }

  const cleanup = async () => {
    if (!temporary) return;
    // Chrome may hold files for a moment after exit.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  return {
    process: child,
    wsUrl,
    profileDir,
    exited: exited.then(cleanup),
    kill: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}
