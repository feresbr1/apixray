import { useEffect, useRef, useState } from 'preact/hooks';
import { HarError, parseHar } from '../core/har';
import { Explorer, type Capture } from './Explorer';

export const REPO = 'https://github.com/feresbr1/apixray';
const NPX = 'npx github:feresbr1/apixray';

function useRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '').split('?')[0]!;
}

async function readCapture(file: File): Promise<Capture> {
  const text = await file.text();
  const har = parseHar(text);
  return { name: file.name, har };
}

export function App() {
  const route = useRoute();
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (load: () => Promise<Capture>) => {
    setBusy(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 20)); // let "Reading…" paint
    try {
      const c = await load();
      setCapture(c);
      location.hash = '#/explore';
    } catch (err) {
      setError(
        err instanceof HarError
          ? err.message
          : `Could not read this file: ${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const openFile = (file: File) => open(() => readCapture(file));
  const openDemo = () =>
    open(async () => {
      const res = await fetch('./demo/hn-search.har');
      if (!res.ok) throw new Error(`demo capture unavailable (HTTP ${res.status})`);
      return {
        name: 'hn-search.har (real capture of hn.algolia.com)',
        har: parseHar(await res.text()),
      };
    });

  useEffect(() => {
    document.title =
      route === '/explore' && capture
        ? `${capture.name} · apixray`
        : "apixray: X-ray any web app's API";
    if (
      route === '/explore' &&
      !capture &&
      new URLSearchParams(location.hash.split('?')[1]).has('demo')
    ) {
      void openDemo();
    }
  }, [route, capture]);

  return (
    <>
      <a class="sr-only skip" href="#main">
        Skip to content
      </a>
      <header class="site">
        <div class="wrap bar">
          <a class="logo" href="#/">
            <Logo />
            apixray
          </a>
          <nav aria-label="Site">
            <a href="#/explore?demo" onClick={() => !capture && void openDemo()}>
              Demo
            </a>
            <a href={`${REPO}#readme`} class="hide-sm">
              Docs
            </a>
            <a href={REPO}>GitHub</a>
          </nav>
        </div>
      </header>
      <main id="main">
        {route === '/explore' && capture ? (
          <Explorer
            capture={capture}
            onClose={() => {
              setCapture(null);
              location.hash = '#/';
            }}
          />
        ) : (
          <Landing onFile={openFile} onDemo={openDemo} busy={busy} error={error} />
        )}
      </main>
      <footer class="site">
        <div class="wrap">
          MIT licensed · <a href={REPO}>Source</a> · <a href={`${REPO}/issues`}>Issues</a> · HAR
          files are read in your browser and never uploaded. Only reverse-engineer APIs you are
          allowed to use.
        </div>
      </footer>
    </>
  );
}

function Logo() {
  return (
    <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0b1220" />
      <path d="M8 8l16 16M24 8L8 24" stroke="#38e1ff" stroke-width="3.2" stroke-linecap="round" />
      <circle cx="16" cy="16" r="3.4" fill="#0b1220" stroke="#e8f7ff" stroke-width="2" />
    </svg>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div class="copy">
      <code>{text}</code>
      <button
        type="button"
        aria-label={`Copy: ${text}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          } catch {
            /* selectable anyway */
          }
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Landing({
  onFile,
  onDemo,
  busy,
  error,
}: {
  onFile: (f: File) => void;
  onDemo: () => void;
  busy: boolean;
  error: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <>
      <section class="hero wrap">
        <div class="hero-copy">
          <p class="kicker">open source · local-first · no proxy, no certificates</p>
          <h1>
            X-ray any web app&rsquo;s <span>API.</span>
          </h1>
          <p class="lede">
            Use the app. Get the spec. apixray turns real browser traffic into an <b>OpenAPI 3.1</b>{' '}
            document, a typed <b>TypeScript client</b> and ready-to-run <b>curl</b> commands,
            inferring path parameters, schemas, enums, nullable fields and auth on the way. Secrets
            are redacted by default.
          </p>
          <Copy text={`${NPX} record https://your-app.example`} />
          <p class="small">
            Opens your Chrome, Edge or Brave. Use the app, close the window, get{' '}
            <code>openapi.yaml</code>.
          </p>
        </div>
        <div
          class={`drop ${over ? 'is-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) onFile(f);
          }}
          data-testid="drop"
        >
          <div class="drop-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48">
              <path d="M24 6v24m0 0l-9-9m9 9l9-9" />
              <path d="M8 30v8a4 4 0 004 4h24a4 4 0 004-4v-8" />
            </svg>
          </div>
          <p class="drop-title">{busy ? 'Reading capture…' : 'Drop a .har file'}</p>
          <p class="muted">or</p>
          <div class="drop-actions">
            <button
              type="button"
              class="btn primary"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              Choose file
            </button>
            <button type="button" class="btn" onClick={onDemo} disabled={busy}>
              Try a real capture
            </button>
          </div>
          <label class="sr-only" for="file">
            Choose a HAR file
          </label>
          <input
            ref={input}
            id="file"
            type="file"
            accept=".har,.json,application/json"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) onFile(f);
              e.currentTarget.value = '';
            }}
          />
          <p class="small muted">Read in your browser. Nothing is uploaded.</p>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>

      <section class="wrap how" aria-labelledby="how-title">
        <h2 id="how-title">Get a HAR file in 20 seconds</h2>
        <ol class="steps">
          <li>
            <b>Open DevTools</b>
            <span>
              <kbd>F12</kbd> or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>, then the{' '}
              <b>Network</b> tab.
            </span>
          </li>
          <li>
            <b>Use the app</b>
            <span>
              Load pages, search, open items, submit forms: every feature you want in the spec.
            </span>
          </li>
          <li>
            <b>Export</b>
            <span>
              Chrome/Edge: the download icon (<i>Export HAR</i>). Firefox: right-click →{' '}
              <i>Save All As HAR</i>. Safari:
              <i> Export</i>.
            </span>
          </li>
          <li>
            <b>Drop it here</b>
            <span>Or skip all of this with the CLI recorder.</span>
          </li>
        </ol>
      </section>

      <section class="wrap features" aria-labelledby="what-title">
        <h2 id="what-title">What it figures out for you</h2>
        <div class="grid">
          <div>
            <h3>Path templates</h3>
            <p>
              <code>/users/42</code> and <code>/users/97</code> become{' '}
              <code>/users/{'{userId}'}</code>. UUIDs, hashes and dates are recognised, and even{' '}
              <code>/pokemon/pikachu</code> vs <code>/pokemon/eevee</code> are merged when their
              responses have the same shape.
            </p>
          </div>
          <div>
            <h3>Schemas from every sample</h3>
            <p>
              Fields missing in some responses are optional, nulls make a field nullable, small
              repeated sets become enums, and dates, e-mails, URLs and UUIDs get formats. Comment
              trees become a recursive <code>$ref</code>.
            </p>
          </div>
          <div>
            <h3>Auth, detected and redacted</h3>
            <p>
              Bearer tokens (and JWTs), Basic auth, API-key headers and query parameters, and
              session cookies become security schemes. Their values never reach the output; examples
              are scrubbed too.
            </p>
          </div>
          <div>
            <h3>Noise filtered</h3>
            <p>
              Scripts, images, preflights and analytics or telemetry hosts are skipped. Hosts of one
              site (<code>eu.api.x.com</code>, <code>us.api.x.com</code>) are merged into one API
              with several servers.
            </p>
          </div>
          <div>
            <h3>A client you can call</h3>
            <p>
              <code>client.ts</code> is a dependency-free, fetch-based TypeScript client with one
              typed method per operation, named like a human would: <code>listUsers</code>,{' '}
              <code>getUser</code>, <code>cancelOrder</code>.
            </p>
          </div>
          <div>
            <h3>Works with your tools</h3>
            <p>
              Import <code>openapi.yaml</code> into Postman, Bruno, Insomnia, Hoppscotch or Swagger
              UI, generate SDKs with openapi-generator, or mock it with Prism.
            </p>
          </div>
        </div>
      </section>

      <section class="wrap cli" aria-labelledby="cli-title">
        <h2 id="cli-title">Or record from the terminal</h2>
        <pre class="term">{`$ npx github:feresbr1/apixray record https://your-app.example
apixray: recording https://your-app.example
  Use the app: log in, click around, trigger the features you care about.
  Close the browser window (or press Ctrl+C) when you are done.

  GET    200 your-app.example/api/v1/users
  GET    200 your-app.example/api/v1/users/1
  POST   201 your-app.example/api/v1/users
  ...
Wrote apixray-out/openapi.yaml, apixray-out/client.ts, apixray-out/capture.har`}</pre>
        <p class="small muted">
          Uses the Chrome DevTools Protocol of a browser you already have, with a fresh temporary
          profile. No proxy, no certificate to install, no Python. Node.js 22+.
        </p>
      </section>
    </>
  );
}
