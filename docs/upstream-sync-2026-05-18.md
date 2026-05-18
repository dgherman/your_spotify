# Upstream Sync Analysis

- **Date:** 2026-05-18
- **Upstream Repository:** https://github.com/Yooooomi/your_spotify
- **Fork Repository:** https://github.com/dgherman/your_spotify
- **Previous sync:** none — first sync. Pickup point determined from merge-base `9658231` (bumped to 1.19.0).

## Current State

| Branch | Latest Commit | Date |
|--------|---------------|------|
| Fork (origin/master) | `c7e1ef9` Tolerate 403/429 in singular Spotify getters during migrate | 2026-04 |
| Upstream (upstream/master) | `09c07fb` fixed app typecheck | 2026-05-17 |

**New upstream commits since merge-base:** 13 commits (range 2026-02-24 → 2026-05-17)

---

## Changes Implemented

### 1. Docs: full privacy data export filenames (upstream `f52167f` + merge `6d15a35`)

| Fork Commit | Description |
|-------------|-------------|
| `ecc7f9e` | README update — corrected full privacy export filename pattern |

### 2. `getAlbumsWithoutArtist()` fix (upstream `8fecf02`, `f756e3c` + merge `07547e9`)

| Fork Commit | Description |
|-------------|-------------|
| `8ec48a3` | Fix initial bug — function returned no results |
| `80c3d76` | Refine: `$lookup` `localField` now `artists` instead of `album` |

### 3. Security: gate file upload behind auth (upstream `7ff41ee`)

| Fork Commit | Description |
|-------------|-------------|
| `9aadf9b` | `routes/importer.ts` — upload route no longer publicly exposed |

Applied cleanly. Fork's other modifications to `importer.ts` (`d10395f`, `0fe83cd`) preserved.

### 4. Configurable per-request Spotify API delay (upstream `dbbdcb8` + merge `27cc35c`, adapted)

| Fork Commit | Description |
|-------------|-------------|
| `95b952d` | `SPOTIFY_API_DELAY_MS` env var (default 2000ms), wired through `PromiseQueue` constructor |

**Adaptation:** dropped the Dockerfile `--dangerously-allow-all-builds` portion of the upstream commit. Fork already addresses pnpm 10 build-script gating via `package.json` `onlyBuiltDependencies` allowlist (commit `28eea2d`), which is more targeted than upstream's blanket flag.

Complements (does not replace) fork's `LOOP_INTERVAL_MS` + `SpotifyRateLimitError` retry-after handling from `ac64141`. Both knobs stack:
- `SPOTIFY_API_DELAY_MS` — per-request throttle inside the queue
- `LOOP_INTERVAL_MS` — interval between polling cycles

### 5. Version bump to 1.20.0 (upstream `060d96a`)

| Fork Commit | Description |
|-------------|-------------|
| `8cf84e8` | Root + `apps/server` + `apps/client` package.json bumped to 1.20.0 |

### 6. Updated dependencies (upstream `b560201`)

| Fork Commit | Description |
|-------------|-------------|
| `22dcc53` | Cherry-pick of upstream dep bumps (mongoose, vite, eslint, etc.); large `pnpm-lock.yaml` churn |

**Notes:** fork's `Dockerfile.*.production` `pnpm@9` pin (`de212c0`) preserved. Upstream's `--dangerously-allow-all-builds` flag landed in the production Dockerfiles via this commit and was left in place — the upstream master state for those files already had it, and the new transitive deps may require it. Fork's `onlyBuiltDependencies` allowlist remains the primary mechanism for non-Docker installs.

### 7. tsconfig + CI workflow + typecheck cleanup (upstream `1f4307e`, `842fb6c`, `09c07fb`)

| Fork Commit | Description |
|-------------|-------------|
| `064f0e2` | `apps/dev/tsconfig.json` tweak |
| `f979f09` | nightly workflow triggers on `apps/dev` changes |
| `613f128` | TypeScript noise after dep bumps cleared (22 files touched in client + server) |

---

## Deliberately Skipped

| Feature | Upstream Commits | Reason |
|---------|------------------|--------|
| Dockerfile `--dangerously-allow-all-builds` flag (non-production) | portion of `dbbdcb8` | Fork uses `onlyBuiltDependencies` allowlist in `package.json` (`28eea2d`); more targeted than blanket allow |
| Merge commits | `6d15a35`, `07547e9`, `27cc35c` | Component commits already cherry-picked individually |

---

## Pickup Point

Next sync starts from upstream commit `09c07fb` (2026-05-17).
