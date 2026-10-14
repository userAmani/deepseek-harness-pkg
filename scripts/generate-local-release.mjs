#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { compareSemver, runtimeChannel } from './resolve-latest-dsh-version.mjs'

const platformFiles = {
  'windows-x64': 'deepseek-harness-runtime-windows-x64.zip',
  'macos-arm64': 'deepseek-harness-runtime-macos-arm64.zip',
  'macos-x64': 'deepseek-harness-runtime-macos-x64.zip',
  'linux-x64': 'deepseek-harness-runtime-linux-x64.zip',
}

function fail(message) {
  throw new Error(`LOCAL_HARNESS_RELEASE_INVALID: ${message}`)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!argument.startsWith('--')) fail(`unexpected argument ${argument}`)
    const name = argument.slice(2)
    if (name === 'allow-partial' || name === 'reindex') {
      options[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`--${name} requires a value`)
    options[name] = value
    index += 1
  }
  return options
}

function required(options, name) {
  const value = options[name]?.trim()
  if (!value) fail(`--${name} is required`)
  return value
}

/**
 * 清单里的发布日期：显式 `--release-date YYYY-MM-DD` 优先，否则从 buildId（`YYYYMMDD.HHMM`）
 * 推导。桌面端「关于」对话框优先读业务清单的这个字段，缺了就只能回退上游 GitHub。
 */
function releaseDateOf(source) {
  const raw = String(source ?? '').trim()
  const match = /^(\d{4})(\d{2})(\d{2})(?:\.|$)/.exec(raw)
  const date = match
    ? `${match[1]}-${match[2]}-${match[3]}`
    : raw
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(`--release-date must be YYYY-MM-DD or a buildId starting with YYYYMMDD: ${raw}`)
  }
  return date
}

function normalizePrefix(value) {
  const segments = value.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    fail('--prefix must contain a safe URL path')
  }
  return `/${segments.join('/')}`
}

async function generateCatalog(output) {
  const harness = join(output, 'harness')
  const releasesDir = join(harness, 'releases')
  const releases = []
  for (const versionDir of await readdir(releasesDir, { withFileTypes: true })) {
    if (!versionDir.isDirectory()) continue
    for (const buildDir of await readdir(join(releasesDir, versionDir.name), { withFileTypes: true })) {
      if (!buildDir.isDirectory()) continue
      const manifestPath = join(releasesDir, versionDir.name, buildDir.name, 'manifest.json')
      let body
      try {
        body = await readFile(manifestPath, 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      const manifest = JSON.parse(body)
      if (manifest.schemaVersion !== 1 || manifest.version !== versionDir.name || manifest.buildId !== buildDir.name) {
        fail(`release manifest does not match its directory: ${manifestPath}`)
      }
      runtimeChannel(manifest.version)
      releases.push(manifest)
    }
  }
  if (releases.length === 0) fail(`no release manifests found in ${releasesDir}`)
  releases.sort((left, right) => compareSemver(right.version, left.version)
    || (left.buildId < right.buildId ? 1 : left.buildId > right.buildId ? -1 : 0))
  const json = value => `${JSON.stringify(value, null, 2)}\n`
  await writeFile(join(releasesDir, 'index.json'), json({ schemaVersion: 1, releases }))
  for (const channel of ['stable', 'preview']) {
    const latest = releases.find(release => runtimeChannel(release.version) === channel)
    const channelDir = join(harness, 'channels', channel)
    if (latest) {
      await mkdir(channelDir, { recursive: true })
      await writeFile(join(channelDir, 'latest.json'), json(latest))
      console.log(`${channel}: ${latest.version} (${latest.buildId})`)
    } else {
      await rm(join(channelDir, 'latest.json'), { force: true })
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const artifacts = resolve(options.artifacts ?? 'dist/local-runtime/artifacts')
  const output = resolve(options.output ?? 'dist/local-runtime/upload')
  if (options.reindex) {
    await generateCatalog(output)
    return
  }
  const version = required(options, 'version')
  const channel = runtimeChannel(version)
  const buildId = required(options, 'build-id')
  const releaseDate = releaseDateOf(options['release-date'] ?? buildId)
  const minimumDesktopVersion = required(options, 'minimum-desktop-version')
  const prefix = normalizePrefix(options.prefix ?? '/harness')
  if (!/^[0-9A-Za-z._]+$/.test(buildId)) fail('--build-id may contain letters, digits, dot and underscore')

  const available = new Set(await readdir(artifacts))
  const selected = Object.entries(platformFiles).filter(([, filename]) => available.has(filename))
  if (selected.length === 0) fail(`no runtime archives found in ${artifacts}`)
  if (!options['allow-partial'] && selected.length !== Object.keys(platformFiles).length) {
    const missing = Object.values(platformFiles).filter(filename => !available.has(filename))
    fail(`missing platform archives: ${missing.join(', ')}`)
  }

  const metadata = []
  for (const [platform, filename] of selected) {
    const value = JSON.parse(await readFile(join(artifacts, `${filename}.json`), 'utf8'))
    if (value.platform !== platform || value.filename !== filename || value.version !== version) {
      fail(`metadata does not match ${filename}`)
    }
    metadata.push(value)
  }
  const sourceCommits = new Set(metadata.map(value => value.sourceCommit))
  const nodeVersions = new Set(metadata.map(value => value.nodeVersion))
  const bundledPluginSets = new Set(metadata.map(value => JSON.stringify(value.bundledPlugins ?? [])))
  if (sourceCommits.size !== 1) fail('platform archives were built from different Harness commits')
  if (nodeVersions.size !== 1) fail('platform archives target different Node.js versions')
  if (bundledPluginSets.size !== 1) fail('platform archives contain different bundled plugins')

  const releaseDir = join(output, 'harness', 'releases', version, buildId)
  await mkdir(releaseDir, { recursive: true })
  const assets = {}
  for (const value of metadata) {
    await copyFile(join(artifacts, value.filename), join(releaseDir, value.filename))
    assets[value.platform] = {
      path: `${prefix}/releases/${version}/${buildId}/${value.filename}`,
      sha256: value.sha256,
    }
  }
  const manifest = {
    schemaVersion: 1,
    version,
    buildId,
    releaseDate,
    sourceCommit: [...sourceCommits][0],
    sourceDirty: metadata.some(value => value.sourceDirty),
    nodeVersion: [...nodeVersions][0],
    bundledPlugins: JSON.parse([...bundledPluginSets][0]),
    minimumDesktopVersion,
    assets,
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(releaseDir, 'manifest.json'), json)
  await generateCatalog(output)
  console.log(`Upload the contents of ${join(output, 'harness')} to the server /harness path.`)
  console.log(`Desktop manifest: ${prefix}/channels/${channel}/latest.json`)
  console.log(`Release catalog: ${prefix}/releases/index.json`)
  console.log(`Included archives: ${metadata.map(value => basename(value.filename)).join(', ')}`)
}

await main()
