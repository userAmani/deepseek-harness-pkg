#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'

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
    if (name === 'allow-partial') {
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

function normalizePrefix(value) {
  const segments = value.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    fail('--prefix must contain a safe URL path')
  }
  return `/${segments.join('/')}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const artifacts = resolve(options.artifacts ?? 'dist/local-runtime/artifacts')
  const output = resolve(options.output ?? 'dist/local-runtime/upload')
  const version = required(options, 'version')
  const buildId = required(options, 'build-id')
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
  const channelDir = join(output, 'harness', 'channels', 'stable')
  await mkdir(releaseDir, { recursive: true })
  await mkdir(channelDir, { recursive: true })
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
    sourceCommit: [...sourceCommits][0],
    sourceDirty: metadata.some(value => value.sourceDirty),
    nodeVersion: [...nodeVersions][0],
    bundledPlugins: JSON.parse([...bundledPluginSets][0]),
    minimumDesktopVersion,
    assets,
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(releaseDir, 'manifest.json'), json)
  await writeFile(join(channelDir, 'latest.json'), json)
  console.log(`Upload the contents of ${join(output, 'harness')} to the server /harness path.`)
  console.log(`Desktop manifest: ${prefix}/channels/stable/latest.json`)
  console.log(`Included archives: ${metadata.map(value => basename(value.filename)).join(', ')}`)
}

await main()
