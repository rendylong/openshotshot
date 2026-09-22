# Contributing to ShotShot

Thanks for your interest in contributing! This document covers everything you need to get a development environment running and submit a change.

## Development setup

Requirements: **Node.js 22+** and npm.

```bash
git clone https://github.com/rendylong/shotshot.ai.git
cd shotshot.ai

# Root workspace (Electron main process) — installs electron & patch-package
npm install

# Web workspace (renderer / standalone web app) — separate lockfile
cd web && npm install
```

> The two workspaces have independent `node_modules`: the root typecheck compiles
> `web/src` types and the web typecheck compiles `../electron` files, so both
> installs are required even if you only touch one side.

### Running

```bash
# Web app (http://localhost:3000)
cd web && npm run dev

# Desktop app (second terminal, repo root)
npm run dev
```

## Before you open a PR

Run the checks for the side you touched:

```bash
# Web
cd web
npm run typecheck && npm run test && npm run build

# Desktop / root
npx tsc --noEmit && npx vitest run && npx electron-vite build
```

CI runs the same commands on every PR, so a green local run means a green CI.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Breaking changes get `!` (e.g. `feat(web)!: ...`).
- **User-visible copy** must be added to **both** locales: `web/src/i18n/locales/zh-CN.ts` and `en-US.ts`. Keys must exist in both files.
- **Design**: follow `DESIGN.md` and the existing component systems (shadcn/Radix for light UI, Ant Design where already in use). Don't introduce a new styling system.
- **Security**: never commit API keys or tokens. The app is local-first; don't add network calls to any hosted service.
- **Themes**: avoid hard-coded colors — use the semantic tokens so dark mode keeps working.

## Good first issues

Issues labeled [`good first issue`](https://github.com/rendylong/shotshot.ai/labels/good%20first%20issue) are scoped, small, and reviewed quickly — start there. During October, [`hacktoberfest`](https://github.com/rendylong/shotshot.ai/labels/hacktoberfest)-labeled issues are also fair game.

## Reporting bugs

Open a bug report using the issue template. Include your OS, browser or desktop version, console errors, and steps to reproduce.
