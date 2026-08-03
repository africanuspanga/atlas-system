# ATLAS web

Next.js 16 App Router application for school staff, parents, and ATLAS platform
staff. It contains the school dashboard and modules, `/portal`, `/assistant`,
and the platform control centre at `/platform`.

## Local development

The browser-safe Supabase and API values live in `apps/web/.env.local`.

```bash
pnpm dev
```

The default URL is `http://localhost:3000`. On a machine where port 3000 is
occupied, use:

```bash
pnpm exec next dev -p 3001
```

## Tenant selection

Server pages use `src/lib/active-tenant.ts`. Multi-school users choose from the
tenant switcher; the choice is stored in an HTTP-only cookie through
`POST /api/tenant`. Do not add a new `.from("tenants").limit(1)` lookup to a
page. Tenant selection improves correctness; API authorization and RLS remain
the actual security boundaries.

## UI conventions

- Server `page.tsx` files perform auth/tenant redirects and initial reads.
- Client views use `apiFetch` for protected mutations and display stable,
  localized error states with retry paths.
- Add English and Kiswahili strings to `packages/i18n/src/index.ts`.
- Preserve the shell skip link, semantic `<main>`, keyboard focus, reduced
  motion behavior, and targeted transitions.

## Production verification

Generate Next route types before the workspace typecheck. Do not run this at
the same time as `next build`, because both operate on `.next`.

```bash
pnpm exec next typegen
pnpm lint
pnpm typecheck
pnpm build
```

Production requires the public Supabase values and an HTTPS API URL. The API's
`WEB_ORIGIN` must exactly match the deployed web origin.
