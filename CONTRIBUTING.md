# Contributing to apixray

Most valuable contributions:

1. **Inference bugs with a reproduction.** A capture where apixray merges paths it shouldn't, misses
   a parameter, names an operation badly or produces an invalid spec. Please reduce it to a small,
   **scrubbed** HAR (or a list of URLs and response bodies) and add it as a test in
   `test/analyze.test.ts`. Never attach a HAR containing real cookies or tokens.
2. **Auth and noise patterns.** New credential headers (`src/core/auth.ts`) or telemetry hosts
   (`src/core/classify.ts`) you have seen in the wild.
3. **Recorder compatibility.** Reports of browsers or platforms where `apixray record` misbehaves.

## Development

Requires Node.js 22+.

```sh
npm install
npx playwright install chromium   # used by the recorder test and the e2e tests
npm run check                     # format, lint, typecheck, tests, build
npm run test:e2e                  # web app, desktop and mobile
npm run dev                       # web app on http://localhost:5173/apixray/
```

## Layout

```
src/core/    HAR parsing, API-call detection, path templating and analysis (analyze.ts), shape/schema
             inference, auth detection, redaction, OpenAPI/YAML/TypeScript/curl output
src/node/    browser discovery and launch, a minimal CDP client, the traffic recorder
src/cli/     command line
src/site/    the web app (explorer)
examples/    the demo capture (scripts/capture-demo.mjs re-records it)
```

## Rules

- Output must stay valid OpenAPI 3.1: the tests validate it against the official schema.
- Never let a credential value reach the spec, client or curl output. Add a test when you touch
  redaction or auth detection.
- Rebuild and commit `dist/cli/` (`npm run build:cli`) when core, node or CLI code changes.

By contributing you agree that your contributions are licensed under the MIT License and that you
will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
