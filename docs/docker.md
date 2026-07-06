# Docker — Building and Running This Bot in a Container

## Why Docker is offered as an option, not a requirement
The primary deployment path documented in `docs/operator-runbook.md`
(Render's native Node buildpack) still works exactly as before and
needs no Dockerfile at all. Docker is useful if you want:
- **Deployment portability** — the same image runs on Render (which
  natively supports building from a Dockerfile instead of a buildpack),
  Fly.io, a VPS, or your own machine, without re-deriving the runtime
  environment each time.
- **Reproducible local development** — "it works in the container"
  removes "works on my machine" drift for a project with a native
  dependency (see below).

## The one real risk this project has with containerization — and how it's handled
This bot depends on `chartjs-node-canvas`, which depends on `canvas`, a
**native Node addon**. This is exactly the kind of dependency that most
often breaks silently in Docker images, so it was verified concretely
during development rather than assumed:

- **Inspected the actual installed binary** (`node_modules/canvas/build/Release/canvas.node`)
  with `ldd` and confirmed canvas 3.x ships a self-contained prebuilt
  binary bundling Cairo/Pango/etc. as its own `.so` files. It only
  depends on universal glibc-level libraries (`libc`, `libm`,
  `libstdc++`, `libpthread`) — **not** a long list of system `-dev`
  packages the way older `canvas@2.x` guidance (common in search
  results) suggests.
- **This is why the Dockerfile uses `node:20-slim` (Debian, glibc), never
  `node:20-alpine` (musl)** — canvas's prebuilt binary is not
  musl-compatible, and Alpine has a well-documented history of breaking
  `canvas` installs for exactly this reason.
- **A bare `slim` image has no fonts and no fontconfig at all**, which
  does NOT crash chart rendering — it silently produces blank or
  garbled label text, a much worse failure mode than an error. The
  Dockerfile installs `fontconfig` + `fonts-dejavu-core` explicitly to
  prevent this.
- **All of the above was verified with a real `docker build` and a real
  running container during development, not just written and assumed
  correct**: the image built successfully, `/healthz` responded `200`
  from outside the container, Docker's own `HEALTHCHECK` reported
  `healthy`, and a chart was rendered *inside the running container* and
  visually confirmed to have legible axis labels and legend text,
  pixel-identical to a chart rendered outside Docker.

## Building and running locally
```bash
npm run docker:build          # docker build -t notion-bot-assistant .
npm run docker:run             # runs it, reading your local .env
```
or with Compose:
```bash
docker compose up --build
```
(`docker-compose.yml` is for local iteration only — it reads your local
`.env` file. It is not how you deploy to Render; see below.)

## Deploying this image to Render
Render supports building directly from a `Dockerfile` in your repo as
an alternative to its native Node buildpack:
1. New Web Service → connect your repo → Render will auto-detect the
   `Dockerfile` and offer to build from it instead of a buildpack
   (or explicitly choose "Docker" as the environment).
2. Everything else is identical to the buildpack path already documented
   in `docs/operator-runbook.md` — same environment variables, same
   `/healthz` endpoint, same webhook/cron wiring steps. The only thing
   that changes is *how* Render builds and runs the process; the
   running server is byte-for-byte the same code either way.
3. Render's own health-check configuration can point at `/healthz`
   directly (independent of the Docker-level `HEALTHCHECK` directive,
   which is mainly useful for `docker ps` / local orchestration
   visibility).

## What's deliberately NOT in the image
- **No dev dependencies, no TypeScript compiler, no test suite** —
  multi-stage build compiles in a `builder` stage and copies only
  `dist/` + production `node_modules` into the final image. Verified:
  the final image was measured at ~278MB, and `npm ci --omit=dev` in
  the runtime stage confirmed 0 vulnerabilities.
- **No `.env` file ever baked into a layer** — `.dockerignore` excludes
  it explicitly. Secrets only ever reach the container via runtime
  environment variables (`docker run --env-file`, Render's environment
  tab, or Compose's `env_file:`), matching the "no exposed credentials"
  principle used everywhere else in this codebase.
- **Runs as a non-root user** (`USER node`, uid 1000 — the user Node's
  official image already ships) rather than root, reducing the impact
  of any future container-escape-class vulnerability.

## Known limitations
- The Docker path has not been tested against Render's actual Docker
  build infrastructure specifically (only a local `docker build`/`docker
  run` in this development environment) — the underlying image and
  Dockerfile are standard enough that this is a low-risk gap, but it's
  not the same as a confirmed live Render deployment.
- `docker-compose.yml` is intentionally minimal (one service, no
  attached database) since Supabase is an external managed service, not
  something this project runs in a container.
