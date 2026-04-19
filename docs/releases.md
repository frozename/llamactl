# Cutting a release

## TL;DR

```sh
# From a clean main branch with everything you want in the release:
git tag v0.4.0
git push origin v0.4.0
```

That's it. A GitHub Actions workflow builds four per-platform
`llamactl-agent` binaries, attaches SHA-256 checksums, and publishes
them as a GitHub Release.

## What the workflow produces

The `.github/workflows/release-agent.yml` workflow runs on any pushed
`vX.Y.Z` tag. For each supported platform it:

1. Installs Bun + the workspace's frozen deps.
2. Runs `bun build --compile --target=bun-<platform>
   packages/cli/src/bin.ts` — produces a single-file binary
   (~60 MB) that needs no runtime on the target host.
3. Writes `<binary>.sha256` alongside.
4. Uploads both to the workflow.

After all four platform builds succeed, a `release` job gathers the
eight files (four binaries, four checksums) and publishes them to a
GitHub Release named after the tag.

## Supported platforms

| Platform | Target flag (bun) |
|---|---|
| macOS on Apple silicon | `bun-darwin-arm64` |
| macOS on Intel | `bun-darwin-x64` |
| Linux on x86_64 | `bun-linux-x64` |
| Linux on aarch64 / ARM | `bun-linux-arm64` |

llamactl's agent server validates platform strings against this
exact set (see `packages/remote/src/server/artifacts.ts`).

## Verifying a downloaded binary

```sh
cd /path/where/you/downloaded/the/release
shasum -a 256 -c llamactl-agent-darwin-arm64.sha256
```

Output: `llamactl-agent-darwin-arm64: OK` — the binary you have is
byte-identical to what CI built from the tagged commit.

(Cosign keyless signing lands in a follow-up — see
`plans/infra-supply-chain.md` I.5.3. Until then, SHA-256 is the
only integrity check.)

## Installing a downloaded binary

Drop the binary under your central's artifacts directory:

```sh
chmod +x llamactl-agent-darwin-arm64
mkdir -p ~/.llamactl/artifacts/agent/darwin-arm64
mv llamactl-agent-darwin-arm64 ~/.llamactl/artifacts/agent/darwin-arm64/llamactl-agent
```

Central then serves that exact file from
`GET /artifacts/agent/darwin-arm64` (see
`packages/remote/src/server/artifacts.ts`). The `install-agent.sh`
curl-pipe-sh flow picks it up automatically.

`llamactl artifacts fetch --version=v0.4.0 --target=darwin-arm64`
(landing in I.5.2) automates the download + drop.

## Rehearsing a build without cutting a release

The workflow accepts `workflow_dispatch` too — run it manually from
the GitHub Actions UI. That re-runs the build matrix against
current HEAD and uploads the binaries as workflow artifacts but
does NOT publish a Release. Useful after a CI config change.

## If CI fails

Build failures look like one matrix cell red in the Actions tab. The
`release` job won't run — no Release is published. Fix the
underlying issue, re-tag (`git tag -d vX.Y.Z; git tag vX.Y.Z; git
push --force origin vX.Y.Z`), and the workflow re-runs.

Never force-push a tag that already has a Release — the binaries
won't match the new tag's commit and operators who already fetched
will silently have stale bytes. Prefer bumping to `vX.Y.Z+1` when
anyone else might have downloaded.

## What's not yet automated

- **`llamactl artifacts fetch`** — downloads the release + writes it
  to the artifacts dir. (Plan I.5.2.)
- **Cosign keyless signing** — verifiable "this binary came from a
  GitHub Actions run on this repo." (Plan I.5.3.)
- **`artifacts prune`** — retains last N versions locally. (Plan
  I.5.4.)
- **Private-repo releases** — the workflow assumes a public repo; a
  private repo needs a paid GitHub plan or a self-hosted runner for
  the free CI minutes.
