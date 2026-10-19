# Security Policy

Only the latest release and https://feresbr1.github.io/apixray/ receive fixes. Report
vulnerabilities privately through
[GitHub security advisories](https://github.com/feresbr1/apixray/security/advisories/new), not in
public issues, and never attach captures containing real credentials.

## In scope

- **Credential leaks.** Any way a captured token, cookie, API key, password or JWT ends up in the
  generated `openapi.yaml`/`.json`, `client.ts` or curl commands while redaction is on (the default).
- **The web app.** HAR files are parsed in the browser and must never be uploaded or stored. A
  crafted HAR that runs script in the page, or anything that sends capture data off the device, is a
  vulnerability.
- **The recorder.** `apixray record` opens a browser with a temporary profile and a DevTools port
  bound to 127.0.0.1. Anything that exposes that port beyond the machine, or keeps the temporary
  profile after the recording ends, is in scope.

## Good to know

- `capture.har` (written by `record`) is raw traffic and is **not** redacted. Treat it like a
  password file.
- With `--profile <dir>`, the browser profile (cookies, logins) is kept in that folder by design.
- apixray sends nothing to any server of its own.
