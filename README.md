<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-pkg">
    <img src="public/favicon.svg" width="112" alt="DeepSeek Harness Pkg" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Pkg</h1>

<p align="center">
  <em>Cross-platform production dependency bundles for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> (<code>dsh</code>) — pinned and auto-synced by GitHub Actions.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/%40deepseek-ai%2Fdsh?style=flat-square&label=dsh" alt="dsh" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.19+" />
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-pkg/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
</p>

> **Developer preview.** Upstream changes rapidly and may break compatibility.

## Quick start

These ZIPs contain production npm dependencies for the `dsh` CLI and web UI, not a Node.js binary or a desktop installer.

**Requirements:** external Node.js `>=22.19.0` on `PATH` (CI uses `22.22.0`); no global pnpm installation is needed to use a ZIP.

Download the matching ZIP from [Releases](https://github.com/dsh-tauri/deepseek-harness-pkg/releases), extract it, and open a terminal in the extracted root.

| Platform | ZIP |

## Repository Structure

```text
.
├── .github/workflows/
│   ├── release.yml                 # npm-based cross-platform build + release
│   ├── release-from-source.yml     # source build + pre-release for GitHub-only versions
│   ├── sync-release.yml            # scheduled npm check that auto-triggers builds
│   └── sync-source-release.yml     # scheduled GitHub Release check for source builds
├── scripts/
│   ├── apply-dsh-web-app-patch.mjs               # idempotent LAN-switch patch (fails loudly if the upstream guard changes)
│   ├── apply-pi-ai-codex-error-patch.mjs         # sanitizes upstream HTML Codex errors
│   ├── check-artifact-size.mjs                   # reports release asset sizes (never blocks)
│   ├── check-dsh-installable.mjs                 # resolves the whole dependency closure before fanning out builds
│   ├── check-workflows.mjs                       # local self-check of .github/workflows/*.yml
│   ├── selftest-check-workflows.mjs              # reverse tests for check-workflows.mjs
│   ├── delete-stale-drafts.mjs                   # clears leftover draft releases so re-runs are idempotent
│   ├── prune-node-modules.mjs                    # slims node_modules before packaging + size report
│   ├── resolve-latest-dsh-version.mjs            # semver-highest published npm version across all dist-tags
│   ├── resolve-latest-github-release-version.mjs # semver-highest upstream GitHub Release version
│   ├── wait-for-npm-version.mjs                  # polls npm until a just-published version's tarball is downloadable
│   └── zip-footprint.mjs                         # size breakdown of a built zip (read-only)
├── public/
│   └── favicon.svg                 # README logo
├── pnpm-workspace.yaml             # nodeLinker / build policy (pnpm 11 settings)
├── package.json                    # pinned @deepseek-ai/dsh version
└── pnpm-lock.yaml                  # lockfile
```

## Local Build

Requirements: Node.js `>=22.19` (recommended 24), pnpm `11.x` (the repo declares `packageManager: pnpm@11.7.0`).

```sh
pnpm install            # install dependencies
pnpm start              # run dsh web directly (http://127.0.0.1:3080)
pnpm build              # produce the prod deployment directory build_dir/
```

## Release

### Build all platforms from the private customized repository

Add an Actions secret named `HARNESS_SOURCE_TOKEN` under Settings → Secrets and variables → Actions. Use a fine-grained personal access token with Contents: Read access limited to `userAmani/deepseek-harness`.

Run **Build private Harness runtimes** manually and provide the Harness repository, branch/tag/commit, runtime SemVer, and minimum desktop version. A full commit SHA is recommended for reproducible releases.

The workflow builds the same Harness commit on Windows x64, macOS arm64, macOS x64, and Linux x64. Download the resulting `harness-server-upload-*` artifact and upload its contents unchanged under the website `/harness/` path. The workflow stores no OSS credentials and performs no server upload.

The runtime pins `dsh-tauri@0.6.7` and verifies the npm tarball SHA-512 during the build. The desktop loads this required message bridge directly from the runtime, so first launch does not fetch it from npm or GitHub. Other community plugins remain optional user installs.

Local integration does not require committing Harness first. When the three repositories share one parent directory, run this repository with:

```sh
pnpm run build:private-harness -- \
  --harness ../deepseek-harness \
  --output dist/private-runtime \
  --version 0.1.2-enterprise.1 \
  --node-version 22.22.0
```

This builds only the current platform. Use **Build private Harness runtimes** for the official four-platform payload.

The final manifest URL must be:

```text
https://web.shuiwujia.com/harness/channels/stable/latest.json
```

### Assemble existing GitHub Release packages

Run from this repository; no Harness compilation is required:

```sh
node scripts/assemble-runtime-from-release.mjs
```

The default source is `userAmani/deepseek-harness-pkg`. The script selects the highest published stable version (final or `rc`), downloads all four platforms, verifies available GitHub SHA-256 digests and the actual engine version, and generates `dist/release-runtime/upload/harness/`. Alpha, beta and other previews never replace the stable channel, even when GitHub marks their releases as non-prerelease.

To add the latest preview for manual selection in the desktop core manager:

```sh
node scripts/assemble-runtime-from-release.mjs --channel preview
```

Use `--version 0.2.1-alpha.2` for a specific preview or `--repository owner/repo` for another release source. Existing `releases/` directories are preserved; both channel pointers and the complete release catalog are regenerated from their manifests, so assembling an older release does not downgrade a channel.

```text
harness/
  channels/
    stable/latest.json
    preview/latest.json
  releases/
    index.json
    0.2.0-rc.2/<buildId>/manifest.json
    0.2.0-rc.2/<buildId>/deepseek-harness-runtime-<platform>.zip
    0.2.1-alpha.2/<buildId>/manifest.json
    0.2.1-alpha.2/<buildId>/deepseek-harness-runtime-<platform>.zip
```

`releases/index.json` has `schemaVersion: 1` and a `releases` array containing the complete manifests for every build, ordered by SemVer and build ID descending. The desktop uses this catalog to select the latest compatible final/RC runtime for first installation and update notifications; the core manager also exposes preview versions for manual download and activation. Compatibility checks include desktop minimum version, bundled Node version, engine minimum version and platform assets. They do not guarantee compatibility with every third-party plugin. A preview-only upload has no stable pointer until a final/RC release is added.

To repair an existing upload tree without downloading or rebuilding packages:

```sh
node scripts/assemble-runtime-from-release.mjs --reindex
```

Upload new `releases/<version>/<buildId>/` directories first, then the generated `channels/` manifests, and replace `releases/index.json` last. Keep the directory structure and previously published versions on the server. JSON manifests use `https://web.shuiwujia.com/harness/`; archives use `https://toutiao.cdn.shuiwujia.com/harness/`. These commands prepare local files and do not upload them to the server.

### Legacy upstream release (not used by the enterprise flow)

Open the repository's Actions page and manually trigger **Build and Release DeepSeek Harness**:

- `dsh_version` (required): the dsh version to package. The Actions form pre-fills the literal default declared in `release.yml`; `package.json` pins the version this repository currently tracks. Use `latest` or another explicit version when needed.

The build creates a GitHub Release named `dsh-<version>-<run_id>` with four platform zips:

| Platform | Artifact || --- | --- |
| Windows | `deepseek-harness-pkg-windows.zip` |
| macOS (Apple Silicon) | `deepseek-harness-pkg-macos-arm64.zip` |
| macOS (Intel) | `deepseek-harness-pkg-macos-x64.zip` |
| Linux (x64) | `deepseek-harness-pkg-linux.zip` |
| Linux (ARM64 / aarch64) | `deepseek-harness-pkg-linux-arm64.zip` |

Windows (PowerShell):

```powershell
.\node_modules\.bin\dsh.cmd web
```

macOS / Linux:

```sh
./node_modules/.bin/dsh web
```

The default address is `http://127.0.0.1:3080`; follow the CLI's authenticated access instructions. Configure a model provider/API key in the UI; see the [upstream docs](https://github.com/deepseek-ai/deepseek-harness).

## Local build

For maintainers: Node.js `>=22.19.0` and pnpm `11.7.0`, as declared in [package.json](<package.json>). The current `@deepseek-ai/dsh` pin is `0.2.1-alpha.1`; the desktop app selects its own compatible core version.

```sh
pnpm install
pnpm start              # Run dsh web using repository dependencies
pnpm build              # Deploy production dependencies to build_dir/
```

`pnpm build` deploys upstream production dependencies to `build_dir/` without rewriting runtime code; `pnpm start` does not run that deployed output. See the [workspace/build policy](<pnpm-workspace.yaml>) for dependency layout and install-script settings.

## Releases and synchronization

Both sync workflows run every **6 hours** and support manual inputs: optional `version` (empty = automatic selection) and `force` (default `false`) to rebuild.

| Workflow | Input / selection | Result |
| --- | --- | --- |
| [release.yml](<.github/workflows/release.yml>) | Required `dsh_version`: an npm version or `latest`; form default `0.1.2-rc.1` is not the current pin. | Five ZIPs; regular release `dsh-<version>-<run_id>` (`<version>` uses the input verbatim). |
| [sync-release.yml](<.github/workflows/sync-release.yml>) | Highest semver among all published npm versions, covering all dist-tags, not only `latest`. | Calls the npm release workflow; updates `main`'s manifest and lockfile only after successful publication. |
| [release-from-source.yml](<.github/workflows/release-from-source.yml>) | Required `dsh_version` without `dsh-v`; clones the exact `dsh-v<version>` tag and builds/deploys its runtime closure. | Five ZIPs; pre-release `dsh-src-<version>-<run_id>`; does not update `main`. |
| [sync-source-release.yml](<.github/workflows/sync-source-release.yml>) | Highest upstream GitHub release version newer than the highest npm version. | Calls the source workflow; skips an existing source pre-release unless forced. |

npm preflight [waits for the actual tarball](<scripts/wait-for-npm-version.mjs>) for up to 10 minutes. It then [installs the complete dependency closure](<scripts/check-dsh-installable.mjs>) with `pnpm install --ignore-scripts` and bounded retries before starting the five-target matrix.

Both release paths [prune the output](<scripts/prune-node-modules.mjs>) and verify five uploaded ZIP assets. [Size reports](<scripts/check-artifact-size.mjs>) are informational, not release gates.

## Linux ARM64 compatibility

Both release paths install and build natively on `ubuntu-24.04-arm` (Ubuntu 24.04, glibc 2.39) with Node.js 22.22.0; they do not cross-compile x64 dependencies. After pruning, they check the architecture, load `koffi`, `sharp`, and `node-pty`, and run the deployed CLI's `web --help` on that runner.

**Kylin V10 / glibc 2.28 is not verified or guaranteed.** Locally compiled native modules inherit the runner's toolchain baseline; upstream prebuilt binaries can have their own glibc / libstdc++ requirements. Installing Node.js alone or rebuilding a single module does not establish compatibility for the whole ZIP. Use a newer supported system, or rebuild and test the complete dependency closure (including prebuilt dependencies) on a matching ARM64/glibc 2.28 environment before deployment. These ZIPs still require an external ARM64 Node.js runtime.

## Runtime compatibility

Local builds and both release paths preserve upstream runtime code. The former LAN override and Codex HTML-error patches have been removed so optional customizations do not block packaging when upstream code changes. Host safety checks and provider error formatting now follow the bundled upstream versions. Codex errors may therefore include raw HTML edge-response bodies; treat error logs as potentially sensitive.

For LAN access, consult the bundled CLI's help for its version-specific flags. Recent upstream releases require one concrete local IPv4 or IPv6 address rather than a wildcard such as `0.0.0.0`; the former LAN opt-in environment variable no longer overrides that policy.

`--trusted-host` limits host trust, not authentication. Keep upstream access credentials private and enable LAN access only on trusted networks.

## Security and use

- For personal learning, research, and testing only; please do not use commercially.
- `dsh` can execute local code: use a trusted, isolated environment and avoid untrusted configurations or plugins.
- LAN exposure increases risk; never expose the service to untrusted networks or share access tokens.
- Developers are not liable for data loss or security issues arising from use.

## Related projects and credits

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream CLI/web/plugin project; [DeepSeek Harness Desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) consumes these bundles as a desktop app.

Thanks to [n8n-pkg](https://github.com/hairyf/n8n-pkg) for the packaging pattern, [pnpm](https://pnpm.io/) for dependency/deploy tooling, and [GitHub Actions](https://github.com/features/actions) for cross-platform builds.
