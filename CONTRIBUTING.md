# Contributing

Thanks for contributing to OpenClaw Linear.

This document focuses on local development, validation, and repository boundaries.
It intentionally does not define issue templates or pull request rules.

## Development Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/TwoSX/openclaw-linear.git
cd openclaw-linear
pnpm install
```

## Project Areas

The repository has three practical code areas:

- `apps/gateway`
  - Cloudflare Worker + Durable Object gateway
  - handles OAuth, webhooks, MCP proxying, and WebSocket bridging
- `packages/plugin`
  - the OpenClaw plugin package
  - this is the only package intended for npm publication
- `shared/protocol.ts`
  - internal shared protocol types and helpers
  - not published as a separate package

## Common Commands

Validate the whole repository:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Validate only the gateway:

```bash
pnpm --filter ./apps/gateway typecheck
pnpm --filter ./apps/gateway test
```

Validate only the plugin:

```bash
pnpm --filter ./packages/plugin typecheck
pnpm --filter ./packages/plugin test
pnpm --filter ./packages/plugin build
```

Run the gateway locally:

```bash
pnpm --filter ./apps/gateway dev
```

Dry-run the Cloudflare deployment:

```bash
pnpm --filter ./apps/gateway exec wrangler deploy --dry-run
```

Check the npm package contents before publishing:

```bash
cd packages/plugin
npm pack --dry-run
```

## Public Package Boundary

Only `packages/plugin` is intended to be published to npm.

Current public package name:

```text
openclaw-channel-linear
```

Current OpenClaw runtime identity:

```text
linear
```

Do not change the runtime plugin/channel id casually. The npm package name and the
OpenClaw runtime id are intentionally different today.

## Documentation Expectations

If you change user-facing behavior, update the relevant public documentation:

- `README.md`
- `README.zh-CN.md`
- `packages/plugin/README.md`

Keep the root READMEs user-focused and onboarding-oriented.
Avoid moving internal engineering notes back into public entry documents.

## Internal Files

The repository intentionally keeps local working notes, internal phase summaries,
and AI workflow assets out of version control.

Do not reintroduce repository-private operational notes or local automation assets
into version control unless the repository policy changes.

## Practical Guidance

- Prefer small, verifiable changes.
- Reuse existing patterns before introducing new abstractions.
- If you touch OAuth, webhooks, or WebSocket behavior, validate the gateway tests.
- If you touch plugin packaging, always run `npm pack --dry-run`.
