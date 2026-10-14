import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { pickLatestRelease } from './assemble-runtime-from-release.mjs'

const run = promisify(execFile)
const generator = resolve(import.meta.dirname, 'generate-local-release.mjs')

test('default release selection ignores alpha and beta even when GitHub labels them stable', () => {
  const releases = [
    { name: 'Release-0.2.1-alpha.2', tag_name: 'dsh-0.2.1-alpha.2-20', prerelease: false },
    { name: 'Release-0.2.2-beta.1', tag_name: 'dsh-0.2.2-beta.1-21', prerelease: false },
    { name: 'Release-0.2.0-rc.1', tag_name: 'dsh-0.2.0-rc.1-10' },
    { name: 'Release-0.2.0-rc.2', tag_name: 'dsh-0.2.0-rc.2-11', prerelease: true },
  ]
  assert.equal(pickLatestRelease(releases).tag_name, 'dsh-0.2.0-rc.2-11')
  assert.equal(pickLatestRelease(releases, 'preview').tag_name, 'dsh-0.2.2-beta.1-21')
})

test('default release selection rejects a catalog containing only previews', () => {
  assert.throws(() => pickLatestRelease([
    { name: 'Release-0.2.1-alpha.2', tag_name: 'dsh-0.2.1-alpha.2-20' },
  ]), /no.*stable|stable.*release/i)
})

async function publish(root, version, buildId) {
  const artifacts = join(root, 'artifacts')
  const output = join(root, 'upload')
  const filename = 'deepseek-harness-runtime-windows-x64.zip'
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, filename), `archive-${version}`)
  await writeFile(join(artifacts, `${filename}.json`), JSON.stringify({
    schemaVersion: 1,
    platform: 'windows-x64',
    filename,
    version,
    nodeVersion: '22.22.0',
    sourceCommit: 'abcdef123456',
    sourceDirty: false,
    bundledPlugins: [],
    sha256: 'a'.repeat(64),
  }))
  await run(process.execPath, [generator,
    '--artifacts', artifacts, '--output', output,
    '--version', version, '--build-id', buildId,
    '--minimum-desktop-version', '0.6.8', '--allow-partial',
  ], { timeout: 10_000 })
  return output
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('publishing alpha preserves the newest RC and exposes both in the release catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-channels-'))
  try {
    const output = await publish(root, '0.2.0-rc.2', '20261010.1200')
    await publish(root, '0.2.1-alpha.2', '20261011.1200')
    const harness = join(output, 'harness')
    const stable = await readJson(join(harness, 'channels/stable/latest.json'))
    assert.equal(stable.version, '0.2.0-rc.2')
    const preview = await readJson(join(harness, 'channels/preview/latest.json'))
    assert.equal(preview.version, '0.2.1-alpha.2')
    const catalog = await readJson(join(harness, 'releases/index.json'))
    assert.equal(catalog.schemaVersion, 1)
    assert.deepEqual(catalog.releases.map(release => release.version), ['0.2.1-alpha.2', '0.2.0-rc.2'])
    assert.deepEqual(catalog.releases, [preview, stable])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('assembling an older RC cannot move the stable channel backwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-order-'))
  try {
    const output = await publish(root, '0.2.0-rc.2', '20261010.1200')
    await publish(root, '0.2.0-rc.1', '20261012.1200')
    assert.equal((await readJson(join(output, 'harness/channels/stable/latest.json'))).version, '0.2.0-rc.2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reindexing repairs a legacy alpha stable pointer without rebuilding archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-reindex-'))
  try {
    const output = await publish(root, '0.2.0-rc.2', '20261010.1200')
    await publish(root, '0.2.1-alpha.2', '20261011.1200')
    const harness = join(output, 'harness')
    const alpha = await readFile(join(harness, 'releases/0.2.1-alpha.2/20261011.1200/manifest.json'))
    await writeFile(join(harness, 'channels/stable/latest.json'), alpha)
    await rm(join(harness, 'releases/index.json'), { force: true })
    await run(process.execPath, [generator, '--output', output, '--reindex'], { timeout: 10_000 })
    assert.equal((await readJson(join(harness, 'channels/stable/latest.json'))).version, '0.2.0-rc.2')
    assert.equal((await readJson(join(harness, 'releases/index.json'))).releases.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
