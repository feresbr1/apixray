## What does this change?

## How was it tested?

- [ ] `npm run check` passes
- [ ] Inference changes have a test in `test/analyze.test.ts`; output still validates as OpenAPI 3.1
- [ ] No credential can reach the generated output
- [ ] `dist/cli/` rebuilt (`npm run build:cli`) if core, node or CLI code changed
