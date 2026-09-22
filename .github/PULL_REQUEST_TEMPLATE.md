## Summary

<!-- What does this PR change and why? Link the issue: "Closes #123" -->

## Changes

-

## How was this tested?

<!-- Commands run and their result, e.g.
`cd web && npm run typecheck && npm run test && npm run build` — all green -->

- [ ] `npm run typecheck` (web) / `npx tsc --noEmit` (root)
- [ ] `npm run test` (web) / `npx vitest run` (root)
- [ ] Build passes (`npm run build` / `npx electron-vite build`)

## Checklist

- [ ] User-visible copy added to **both** `zh-CN` and `en-US` locales
- [ ] No hard-coded colors (uses semantic tokens / theme variables)
- [ ] No API keys, tokens, or hosted-service calls introduced
- [ ] UI changes verified in the running app (web or Electron)
