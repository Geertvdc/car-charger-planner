---
name: merge-and-release
description: Use when the user asks to merge a branch/worktree to main and cut a new release for car-charger-planner (e.g. "commit this to main and create a new release", "merge to main and release", "ship this"). Covers the exact order: verify, push code, wait for CI, only then bump the version.
---

# Merge to main and release

This repo publishes the Home Assistant add-on images via
`.github/workflows/addon-build.yml`, which triggers on **any** push to `main` that
touches `src/**`, `prisma/**`, `public/**`, `package.json`, `package-lock.json`,
`next.config.mjs`, `tsconfig.json`, `Dockerfile`, `docker-entrypoint.sh`, or
`car_charger_planner/config.yaml`. It reads the version straight out of
`car_charger_planner/config.yaml` and builds+pushes `ghcr.io/geertvdc/car-charger-planner-{amd64,aarch64}`
tagged with that version **and** `:latest`, for both architectures. That's the actual
Home Assistant add-on package users get on update — a green `npm run build` locally does
**not** prove that build works, since it doesn't run in Docker/QEMU on two architectures.

**The rule: never bump the version in the same push as the code.** Bumping the version
publishes a real, user-facing release number. If you bump it before confirming the code
builds in the real CI pipeline, a failed build leaves a broken version tag in the
changelog. Split it into two pushes so the *first* one (still under the old version) is
what actually proves the code builds, and the version bump only happens once that's
already green.

## Steps

1. **Verify on the feature branch/worktree first**, before touching main:
   - `npx tsc --noEmit`
   - `npx vitest run` (or the project's `npm test`)
   - `npm run build` (the real Next.js production build, not just typecheck)
   - Any relevant browser verification for UI changes (see the repo's own
     verification workflow conventions).

2. **Merge into main.** From the main checkout (not the worktree — worktrees share one
   `.git`, so operate on the primary checkout's `main` branch):
   - `git fetch origin main` and compare `git rev-list --left-right --count main...origin/main` —
     confirm main is clean and up to date with origin before touching it.
   - Check whether main has moved since the branch was created
     (`git merge-base main <branch>` vs `git log -1 main`) — a prior release commit on
     main is common here (see history: release commits land directly on main). If it has,
     a plain `git merge --ff-only` will refuse; use a real merge
     (`git merge --no-ff <branch> -m "..."`) instead of force-pushing or rebasing main.
   - Re-run typecheck + full test suite + `npm run build` on main *after* the merge —
     the merge itself can break things even when both sides were clean.

3. **Push the merge to origin main — with no version bump yet.**
   - `git push origin main`
   - This alone triggers the GitHub Actions build (since the merge touches `src/**`
     etc.), still tagged with the *previous* version. That's fine and expected — it's
     the real-world proof that this code builds, before any release number is attached
     to it.

4. **Wait for that workflow run to complete. Do not proceed until it's green.**
   - Find the run: `gh run list --repo Geertvdc/car-charger-planner --branch main --limit 1`
   - Watch it: `gh run watch <run-id> --repo Geertvdc/car-charger-planner --exit-status`
   - If it fails, fix the problem and repeat from step 3 — do **not** bump the version
     on top of a failed build.

5. **Only now "add the release"**: bump the version and write the changelog entry, in
   one commit, following the existing pattern (check the last few `Release x.y.z`
   commits for the exact style):
   - `package.json` — `"version"`
   - `package-lock.json` — the top-level `"version"` **and** the `""` package's
     `"version"` (exactly those two lines — a blind find-and-replace can also hit an
     unrelated dependency that happens to share the same version string; check
     `git diff package-lock.json` only touches those two lines before committing)
   - `car_charger_planner/config.yaml` — `version: "x.y.z"`
   - `car_charger_planner/CHANGELOG.md` — a new `## x.y.z` section above the previous
     one, written for the *user* of the add-on (what changed and why it matters to
     them), not a commit-log dump
   - Commit message: `Release x.y.z` (see prior release commits for the exact shape,
     including the `Co-Authored-By` trailer this project's commits use)

6. **Push the release commit — "create the package."**
   - `git push origin main`
   - This triggers a second build, this time tagged with the new version — the actual
     package a Home Assistant instance will pull on update.

7. **Wait for and confirm this second workflow run too**, same as step 4. Only report
   the release as done once this one is green — a version bump with a red build behind
   it is a broken release, even though the commits are already on `main`.

## Notes

- Both build jobs (amd64 native, aarch64 native — no QEMU emulation, per the workflow's
  own comment) typically take 3–6 minutes each, run in parallel.
- `gh run watch` blocks and streams status; don't poll `gh run list` in a loop instead.
- If the user only says "commit this to the worktree" (not main), stop after local
  verification — don't merge/push/release unless they say so.
