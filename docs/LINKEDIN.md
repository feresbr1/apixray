# LinkedIn post

Ready to copy and paste. Attach the image listed below (a real screenshot from the project). LinkedIn
tends to show posts with external links to fewer people, so a common approach is to put the links in
the first comment instead of the post. The post works either way.

**Image to attach:** `docs/images/explorer.png`

**First comment (optional):** Try it on a real capture: https://feresbr1.github.io/apixray/#/explore?demo · Code: https://github.com/feresbr1/apixray

---

Use a web app. Get its API spec.

Undocumented APIs are everywhere: your own admin panel, a legacy app, an internal dashboard. Writing the OpenAPI spec by hand is tedious, and the existing tools need a proxy, a certificate and a manual multi-step workflow.

So I built apixray. Two ways in:

🔴 npx github:feresbr1/apixray record https://your-app.example
It opens your own Chrome, Edge or Brave. You click around and close the window, and you get openapi.yaml plus a typed TypeScript client. No proxy, no certificate.

📄 Or drop a HAR file from your browser's DevTools on the website. It is parsed in your browser and never uploaded.

What it infers from the traffic:
• path parameters: /users/42 → /users/{userId}, and /pokemon/pikachu + /pokemon/eevee → /pokemon/{pokemonName} when their responses share a shape
• schemas from every sample: optional and nullable fields, enums, formats, recursive types for comment trees
• auth (bearer/JWT, API keys, session cookies) as security schemes, with every secret redacted from the output
• analytics and telemetry filtered out

The generated spec validates against the official OpenAPI 3.1 schema, and the client is a dependency-free fetch wrapper with one typed method per endpoint.

Open source, MIT. Please only reverse-engineer APIs you're allowed to use.

🔗 https://feresbr1.github.io/apixray/
💻 https://github.com/feresbr1/apixray

#openapi #api #webdevelopment #typescript #opensource
