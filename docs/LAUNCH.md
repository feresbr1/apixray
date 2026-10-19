# Launch kit

Nothing here has been posted yet. Each channel needs the maintainer's account; follow each
community's self-promotion rules and post in one place at a time.

**Assets:** https://feresbr1.github.io/apixray/ · live demo https://feresbr1.github.io/apixray/#/explore?demo ·
screenshots in `docs/images/` (`explorer.png`, `landing.png`, `client.png`, `try-it.png`) · social
card `public/og.png` · real recording output in the README.

## One-liners

- **apixray**: X-ray any web app's API. Use the app, get the OpenAPI spec, a typed TypeScript client
  and curl commands. Local-first, secrets redacted.
- `npx github:feresbr1/apixray record https://app.example` opens your Chrome, you click around, you
  close it: `openapi.yaml` + `client.ts`. No proxy, no certificate, no Python.
- Drop a HAR file from DevTools on a web page, get an OpenAPI 3.1 spec. Nothing is uploaded.

## GitHub release announcement

> **apixray 1.0**: turn real browser traffic into an OpenAPI 3.1 spec, a typed TypeScript client and
> curl commands.
>
> - Drop a HAR file at https://feresbr1.github.io/apixray/ (parsed in your browser), or run
>   `npx github:feresbr1/apixray record <url>` to record a session in your own Chrome, Edge or Brave
>   over the DevTools Protocol.
> - It infers path parameters (ids, UUIDs, hashes, and slugs whose responses share a shape), optional
>   and nullable fields, enums, formats, maps and recursive types, plus auth schemes.
> - It filters analytics, merges hosts of the same site, and redacts tokens, JWTs and e-mails from
>   every output.
> - The generated spec validates against the OpenAPI 3.1 schema; the client is dependency-free and
>   fetch-based. MIT.

## Show HN

**Title:** `Show HN: Apixray – use a web app, get its OpenAPI spec and a typed client`

> I often need to script against an internal API that has no docs: our own admin panel, a vendor
> dashboard, a legacy app. mitmproxy2swagger (9.7k stars) proves the idea is popular, but it needs
> Python, mitmproxy, a proxy certificate and a two-pass workflow where you edit YAML to un-ignore
> paths, and its most-discussed issues are about empty output and installation.
>
> apixray does it in one step. Either drop a HAR file from DevTools on a static page (parsed
> locally, nothing uploaded), or run `npx github:feresbr1/apixray record <url>`. That launches your
> own Chrome/Edge/Brave with a temporary profile, records over the DevTools Protocol using Node 22's
> built-in WebSocket (no Playwright, no proxy), and writes openapi.yaml + client.ts when you close the
> window.
>
> The inference was the fun part:
>
> - Paths are templated not just by spotting ids: sibling literals are merged when their responses
>   have the same structure, so /pokemon/pikachu and /pokemon/eevee become /pokemon/{pokemonName} but
>   /products and /customers don't.
> - Comment trees become a recursive $ref instead of 10 levels of nesting.
> - Hosts of one site (Algolia calls the same API on several hosts) become one operation with several
>   servers.
> - Bearer/JWT, API-key and cookie auth become security schemes, and their values are redacted from
>   everything, including the curl commands.
>
> The generated spec validates against the official OpenAPI 3.1 schema, and the tests compile the
> generated client and call a live server with it. Demo on a real capture of hn.algolia.com:
> https://feresbr1.github.io/apixray/#/explore?demo

## Reddit

| Community                  | Angle                                                               | Notes                                 |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| r/webdev                   | "Use a web app, get its OpenAPI spec" with the explorer screenshot  | Showoff Saturday rules                |
| r/javascript, r/typescript | The generated fetch client; the CDP recorder with zero dependencies |                                       |
| r/node                     | `record` built on Node 22's WebSocket and CDP                       |                                       |
| r/selfhosted               | Scripting self-hosted apps that lack API docs                       | Only where tool posts are allowed     |
| r/reverseengineering       | Traffic-based API inference, with the responsible-use note          | Strict rules; technical write-up only |
| r/programming              | Technical article on shape-based path inference                     | Article, not a product post           |

## Other channels

- **Write-up:** "Inferring an OpenAPI spec from traffic: path templates by response shape" (blog,
  dev.to or Hashnode), linking the demo.
- **Tool ecosystems:** Bruno, Hoppscotch and Insomnia community forums/Discords ("generate a
  collection for an undocumented API").
- **Awesome lists:** awesome-openapi3, awesome-api-devtools, awesome-reverse-engineering (web/API
  section), awesome-chrome-devtools.
- **X / Bluesky / Mastodon:** a 20-second screen recording of `record` → explorer.

## Keywords and search queries

`har to openapi` · `har to swagger` · `generate openapi from traffic` · `reverse engineer api` ·
`reverse engineer rest api` · `undocumented api` · `openapi from browser` · `mitmproxy2swagger
alternative` · `api discovery tool` · `generate typescript client from har` · `chrome devtools
export har openapi` · `swagger from network tab` · `postman collection from har` ·
`create openapi spec automatically`

## Remaining actions (need the maintainer)

- [ ] Post Show HN (weekday morning US time) and answer questions.
- [ ] One Reddit post (r/webdev Showoff Saturday first).
- [ ] Record a short real screen capture of `apixray record` for social posts and the README.
- [ ] Submit to awesome-openapi3 / awesome-api-devtools.
