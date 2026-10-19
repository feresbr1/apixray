# Product decisions

## The bet

**apixray: X-ray any web app's API.** Use the app (or drop a HAR file) and get an OpenAPI 3.1
spec, a typed TypeScript client and curl commands inferred from the real traffic. Zero install in
the browser; one command (`apixray record <url>`) with a browser you already have.

## Evidence of demand

- **Reverse-engineering APIs from traffic is a proven want.**
  [alufers/mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) has 9.7k★ and was still
  being pushed to in October 2026. [Integuru](https://github.com/Integuru-AI/Integuru), an AI agent
  that "builds permissionless integrations through reverse engineering platforms' internal APIs",
  has 4.8k★. People clearly want this capability.
- **The leading tool is hard to get working.** Its most-discussed issues are installation and
  workflow failures, not missing features:
  - [#29 "Nothing shows up in the output file"](https://github.com/alufers/mitmproxy2swagger/issues/29), 10 comments.
  - [#177 "Update for mitmproxy 11"](https://github.com/alufers/mitmproxy2swagger/issues/177), 10 comments.
  - [#172 "command not found"](https://github.com/alufers/mitmproxy2swagger/issues/172), 9 comments, open.
  - #173 "Output file always empty", #57 "Output file is empty", #184 and #218 "Dockerfile failed to build",
    #21 and #84 flow-format version mismatches.
  - It needs Python, mitmproxy, a proxy and a certificate, then a two-pass workflow where you hand-edit
    YAML to un-ignore paths.
- **Map-like objects** are a requested feature there ([#147](https://github.com/alufers/mitmproxy2swagger/issues/147),
  `additionalProperties` for dicts with generic keys). apixray does this automatically.
- **The rest of the ecosystem consumes OpenAPI.** Bruno (47.7k★), Insomnia (40k★), Hoppscotch
  (80.7k★), Mockoon (8.4k★) and Prism (5k★) all import OpenAPI. A spec is the entry ticket to all
  of them, which makes the output immediately useful.
- The closest JavaScript tool, [jonluca/har-to-openapi](https://github.com/jonluca/har-to-openapi),
  has 135★ and is a library/CLI for HAR files (no browser UI or recorder).

(Stars checked with the GitHub API on 2026-10-19.)

## Why apixray is different

|                      | mitmproxy2swagger (from its README)                                                | apixray                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Install              | Python + mitmproxy (proxy + CA certificate), or HAR input                          | none (web) / `npx` + a Chrome-family browser                                                |
| Capture              | mitmproxy flow files or HAR                                                        | HAR, or `record`: drives your own browser over CDP                                          |
| Workflow             | two passes: generate, edit `ignore:` lines, generate again                         | one pass, then toggle hosts/endpoints in the explorer                                       |
| Path parameters      | from the paths you un-ignore                                                       | ids, UUIDs, hashes, dates, plus shape-based merging (`/pokemon/pikachu` + `/pokemon/eevee`) |
| Schemas              | merged from captures                                                               | optional/nullable/enum/format, map detection, recursive `$ref` for trees                    |
| Auth                 | not described in the README                                                        | bearer/JWT, basic, API-key header/query, session cookie → security schemes                  |
| Examples and headers | opt-in (`--examples`, `--headers`), README warns they may add tokens and passwords | on by default with credentials, JWTs and e-mails redacted                                   |
| Extras               | HTML docs via redoc-cli                                                            | typed TS client, curl, browsable explorer, multi-host sites merged                          |

## Candidates considered

|   # | Idea                                                                           | Evidence checked                                                             | Verdict                                                          |
| --: | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
|   1 | **apixray**: traffic → OpenAPI + client, in the browser and via a CDP recorder | mitmproxy2swagger 9.7k★ with install pain; Integuru 4.8k★; OpenAPI ecosystem | **Chosen**                                                       |
|   2 | Website → design-tokens extractor                                              | [dembrandt](https://github.com/dembrandt/dembrandt) 3.7k★, active            | Strong but already well served                                   |
|   3 | Repo → architecture diagram                                                    | [gitdiagram](https://github.com/ahmedkhaleel2004/gitdiagram) 18.3k★          | Crowded, mostly an LLM wrapper                                   |
|   4 | Browser hex/binary format explorer                                             | [ImHex](https://github.com/WerWolv/ImHex) 55k★, Kaitai 4.7k★                 | Dominated by mature tools                                        |
|   5 | Examples → regex generator                                                     | [grex](https://github.com/pemistahl/grex) 8.3k★                              | Solved                                                           |
|   6 | JSON → types                                                                   | [quicktype](https://github.com/glideapps/quicktype) 13.9k★                   | Solved (apixray uses the same idea per endpoint)                 |
|   7 | DB schema → ERD in browser                                                     | [drawdb](https://github.com/drawdb-io/drawdb) 40k★                           | Solved                                                           |
|   8 | HAR → mock server                                                              | Mockoon (8.4k★) and Prism (5k★) mock from OpenAPI                            | Better as a consequence of #1 than a product                     |
|   9 | Intercepting proxy UI                                                          | mitmproxy 45.7k★, HTTP Toolkit                                               | Heavy, crowded                                                   |
|  10 | API client app                                                                 | Bruno, Insomnia, Hoppscotch (40–80k★)                                        | Saturated                                                        |
|  11 | AI agent that writes integrations from traffic                                 | Integuru 4.8k★                                                               | Needs an LLM key; apixray's spec is the deterministic first half |
|  12 | Source-map extractor for production sites                                      | Several small tools                                                          | Legal/ethical grey zone, narrow                                  |
|  13 | Request-rewrite browser extension                                              | [Requestly](https://github.com/requestly/requestly) 6.8k★                    | Crowded                                                          |
|  14 | OpenAPI breaking-change linter                                                 | [Optic](https://github.com/opticdev/optic) archived (1.5k★)                  | Opening exists, but smaller audience and less "wow"              |
|  15 | GraphQL schema from traffic                                                    | Introspection usually works; niche when it doesn't                           | Smaller audience; possible apixray extension                     |
|  16 | Webhook inspector                                                              | Many hosted and OSS options                                                  | Crowded                                                          |

## Key design decisions

- **Local-first.** The web app parses HAR files in the browser and never uploads them; the CLI
  writes files locally. A HAR contains cookies and tokens, so this is the only acceptable default.
- **Redaction by default.** Credential values never reach the spec, client or curl: they become
  security schemes plus `$TOKEN`, `$API_KEY` and `$COOKIE` placeholders. Examples are scrubbed of
  tokens, JWTs and e-mail addresses (`--no-redact` to opt out).
- **Recorder without Playwright or a proxy.** `apixray record` launches the user's Chrome, Edge,
  Brave or Chromium with a temporary profile and speaks the DevTools Protocol over Node 22's built-in
  WebSocket. The bundle stays dependency-free. Two things had to be verified: the page has to be
  opened _after_ attaching (otherwise the first requests are missed), and `loadingFailed` can follow
  a valid response (a 204 with a JSON content type), so those are kept.
- **Shape-based path merging.** Value detection alone misses slugs (`/pokemon/pikachu`). Siblings
  are merged into one parameter only when their responses have nearly the same structure, so
  `/products` and `/customers` stay separate. Reserved words (`me`, `search`, `latest`, …) are never
  merged.
- **Sites, not hosts.** Algolia's search client calls the same API on several hosts
  (`c3-de-1.algolia.net`, `t5-in-1.algolia.net`, …). Endpoints are templated per registrable
  domain and keep a server list, instead of producing one duplicate operation per host.
- **Verification over claims.** Tests validate generated specs against the OpenAPI 3.1 schema, check
  that YAML round-trips, compile the generated client with `tsc --strict`, and call a live server with
  it. The recorder test drives real headless Chromium.

## Scope of v1.0

- Web app: drop HAR → explorer (endpoints, parameters, schemas, real examples, curl, client usage),
  host toggles, endpoint selection, YAML/JSON/client.ts downloads. Real demo capture of
  hn.algolia.com.
- CLI: `apixray <har>...` and `apixray record <url>` (`--headless`, `--duration`, `--profile`,
  `--origin`, `--stdout`, `--format`, `--no-redact`, `--no-examples`).

Not in v1: GraphQL operation splitting, WebSocket messages, response headers, source of truth
merging with an existing spec.
