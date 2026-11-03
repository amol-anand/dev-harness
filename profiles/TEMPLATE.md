# Profile: owner/repo

<!-- Real profiles live in ~/.dev-harness/local/profiles/<owner>__<repo>.md (never committed).
     Generate one with `dev-harness profile init /path/to/checkout`, then fill in the Notes. -->

- **Kind:** eds | cloudflare-worker | helix-service | node | other
- **Default branch:** `main` (never commit to it directly)
- **Branch names:** short, describes only the change
- **Install:** `npm ci`
- **Lint:** `npm run lint`
- **Test:** `npm test`
- **Build:** _none_
- **Local server:** `aem up` / `npm run dev` / `npx wrangler dev`
- **Test frameworks:** mocha

## Verify recipe
lint → tests → run the changed path locally → …

## Notes (edit me)
- Related repos / local clone paths: e.g. "worker lives in ../my-worker; deploy it before the UI"
- Consumers that must keep working (back-compat): e.g. "DA app calls /schedule/:org/:site — keep that route unchanged"
- Gotchas: e.g. "tests must not use esmock; use the existing test/fixtures helpers"
