#!/usr/bin/env node
// Resolve the highest published version of @deepseek-ai/dsh to sync, instead of
// trusting a single npm dist-tag. Upstream sometimes tags a new rc under `next`
// while `latest` still points at an older rc (e.g. 0.1.0-rc.8 was published
// under `next` while `latest` remained 0.1.0-rc.7), which made the old
// `npm view <pkg> version`-based sync miss the newest release. Taking the
// semver-highest of ALL published versions is a superset of every dist-tag's
// version, so it covers `latest`, `next`, and any other tag.
//
// Usage: node scripts/resolve-latest-dsh-version.mjs [--package <name>]
//   Prints the winning version to stdout; logs dist-tags to stderr.
//   Exits non-zero (fails loudly) when the version list cannot be resolved —
//   never silently falls back to a single dist-tag.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Compare two semver strings per the semver spec. Returns <0 / 0 / >0.
// Numeric prerelease identifiers compare numerically, alphanumeric ones
// lexically; a release without a prerelease sorts after the same release with
// one (e.g. 0.1.0 > 0.1.0-rc.9).
export function compareSemver(a, b) {
  const [ra, rb] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i]
  }
  return comparePrerelease(ra[3], rb[3])
}

// Return the semver-highest version; input order is irrelevant.
export function maxSemver(versions) {
  return versions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max))
}

function parse(v) {
  const [release, prerelease = ''] = v.replace(/^v/i, '').split('-')
  const [major, minor, patch] = release.split('.').map((n) => Number(n))
  return [major, minor, patch, prerelease.split('.').filter(Boolean)]
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // release > prerelease
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1 // shorter prerelease sorts first when prefix-equal
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) - Number(y)
    if (xNumeric) return -1 // numeric identifiers < alphanumeric ones
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}

// Windows 上 npm 是 npm.cmd；Linux/macOS 上是 npm。注意 .cmd 不能直接 spawn：
// Node 自 CVE-2024-27980 起对 .cmd/.bat 抛 EINVAL（spawnSync npm.cmd EINVAL），
// 必须经 shell；这里用单字符串形式避开 DEP0190，pkg/field 都是受控字面量或
// npm 包名（不含空白与 shell 元字符）。
function npmView(pkg, field) {
  const viewArgs = ['view', pkg, field, '--json']
  if (process.platform === 'win32') {
    return execFileSync(`npm.cmd ${viewArgs.join(' ')}`, {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return execFileSync('npm', viewArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function main() {
  const pkgArg = process.argv.find((arg) => arg.startsWith('--package='))
  const pkg = pkgArg ? pkgArg.slice('--package='.length) : '@deepseek-ai/dsh'
  try {
    const distTags = JSON.parse(npmView(pkg, 'dist-tags'))
    const versions = JSON.parse(npmView(pkg, 'versions'))
    const candidates = (Array.isArray(versions) ? versions : [versions]).filter(
      (v) => typeof v === 'string',
    )
    if (candidates.length === 0) throw new Error(`no published versions found for ${pkg}`)
    const winner = maxSemver(candidates)
    console.error(
      `[resolve-latest-dsh-version] ${pkg} dist-tags: ${JSON.stringify(distTags)} -> picked ${winner} (semver max of ${candidates.length} published versions)`,
    )
    console.log(winner)
  } catch (err) {
    console.error(`[resolve-latest-dsh-version] failed to resolve ${pkg}: ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
