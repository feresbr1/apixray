# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-19

### Added

- Web app: drop a HAR file (or open the real demo capture) and explore inferred endpoints,
  parameters, schemas, real redacted examples, curl commands and client usage; toggle hosts and
  endpoints; download OpenAPI YAML/JSON and a TypeScript client. Files never leave the browser.
- `apixray <capture.har>...`: convert one or more HAR files into `openapi.yaml` and `client.ts`.
- `apixray record <url>`: record a session in the user's Chrome, Edge, Brave or Chromium over the
  Chrome DevTools Protocol (no proxy, no certificate), with `--headless`, `--duration` and `--profile`.
- Inference: path templates from ids, UUIDs, hashes, ULIDs, dates and response-shape similarity;
  base-path detection; hosts of one site merged; required/optional/nullable fields, enums, formats,
  maps and recursive `$ref` schemas; query, header and body parameters; one response per status.
- Auth detection (bearer/JWT, basic, API-key header and query, session cookie) as OpenAPI security
  schemes; credentials, JWTs and e-mail addresses redacted from all output by default.
- Telemetry and analytics hosts filtered by default.

[1.0.0]: https://github.com/feresbr1/apixray/releases/tag/v1.0.0
