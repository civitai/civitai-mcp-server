# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the Civitai team rather than
opening a public issue. Use GitHub's "Report a vulnerability" (Security advisories)
on this repository, or contact the maintainers directly.

## Runtime dependency posture

The shipped artifact (the Docker image / `node dist/index.js`) installs **production
dependencies only** (`@modelcontextprotocol/sdk`, `express`, `zod`). `pnpm audit --prod`
reports **no known vulnerabilities** in that set. The dev/test toolchain is not part of
the running service.

### Known dev-only advisory (not shipped, not exploitable here)

`pnpm audit` may report one moderate advisory in the test toolchain:

- **vite** (`GHSA-4w7w-66w2-5vf9`, path traversal in optimized-deps `.map` handling) —
  reached transitively through `vitest@4 -> vite@5` (vitest 4 peer-depends on vite 5, so
  the patched vite 6.4.2+ cannot be forced without breaking the test runner).

This advisory only affects a **running Vite dev server exposed to a network**. This project
never starts a Vite dev server — `vitest` uses Vite's in-process transform pipeline during
`pnpm test` only, with no HTTP listener — and Vite is a `devDependency` that is absent from
the production image. There is no execution path that reaches the vulnerable behavior in this
service. It is tracked here and will clear when vitest's peer range advances to vite 6.4.2+.

The previously-reported critical (`vitest` `GHSA-5xrq-8626-4rwp`) and the `esbuild` advisory
are resolved (vitest upgraded to 4.x; `esbuild` pinned to `>=0.25.0` via a pnpm override).
