# Repository Guidelines

## Project Structure & Module Organization
- `bot/` TypeScript trading bot, CLI tools, and dashboard backend (SSE). Key areas: `bot/src/arb/`, `bot/src/market-maker/`, `bot/src/dashboard/`, `bot/src/terminal/`, `bot/src/testing/`.
- `front/` React dashboard sources and preview HTML (`front/preview.html`).
- `sdk/` vendored Predict SDK with its own build and test toolchain.
- `docs/`, `data/`, `scripts/`, and `polymarket-sdk-master/` are supporting material and vendor drops; avoid editing vendor folders unless upgrading.

## Build, Test, and Development Commands
Bot (Node >=18):
```bash
cd bot
npm install
npm run dev
npm run build
npm run dashboard
npm run arb-monitor
npm run market-maker
npm run typecheck
npm run lint
npm run test:all
```

SDK (Yarn required):
```bash
cd sdk
yarn install
yarn build
yarn test
yarn typecheck
yarn lint
yarn format:write
```
Dashboard defaults to port 3005. Override with `DASHBOARD_PORT=3005 npm run dashboard`.

## Coding Style & Naming Conventions
- TypeScript ES modules; 4-space indentation is the dominant style in `bot/` and `front/`.
- File names prefer kebab-case (e.g., `arb-monitor.ts`, `market-maker/`).
- Use camelCase for functions/vars, PascalCase for types/classes, and keep exported names stable.
- SDK uses ESLint and Prettier; bot uses ESLint via `npm run lint` but has minimal formatting rules.

## Testing Guidelines
- Bot tests are runnable scripts (`npm run test:*`) and ad-hoc scripts under `bot/src/testing/` and `bot/test-*.cjs`. Add new checks there when covering integrations.
- SDK tests use Jest with files in `sdk/tests/*.test.ts`. Run `yarn test` before changes that touch `sdk/src/`.
- No explicit coverage thresholds are configured.

## Commit & Pull Request Guidelines
- Git history is minimal; no formal convention is enforced. Use concise, imperative subjects (e.g., "Add dashboard SSE filter") and describe rationale in the body.
- PRs should include: summary of changes, commands run, and any config or env impact. Add screenshots or GIFs for dashboard UI changes. Link related issues if available.

## Security & Configuration Tips
- Copy `.env.example` to `.env` and keep keys and private data out of git. Review `.gitignore` before committing.
- Trading credentials are required for live runs; test scripts may read the same environment variables.
