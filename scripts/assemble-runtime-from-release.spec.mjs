import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import process from 'node:process'

const run = promisify(execFile)
const script = resolve(import.meta.dirname, 'assemble-runtime-from-release.mjs')

/** 造一个假的 release 资产：内容只要够读出 dsh 版本、gitHead 与内置插件即可。 */
async function fakeAsset(directory, assetName, { pluginVersion = '0.6.7' } = {}) {
  const staging = await mkdtemp(join(directory, 'staging-'))
  await mkdir(join(staging, 'node_modules/@deepseek-ai/dsh'), { recursive: true })
  await mkdir(join(staging, 'node_modules/dsh-tauri'), { recursive: true })
  await writeFile(
    join(staging, 'node_modules/@deepseek-ai/dsh/package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1', gitHead: '9d55f38abcdef' }),
  )
  await writeFile(
    join(staging, 'node_modules/dsh-tauri/package.json'),
    JSON.stringify({ name: 'dsh-tauri', version: pluginVersion }),
  )
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'harness-runtime' }))
  const asset = join(directory, assetName)
  await run('zip', ['-qr', asset, 'node_modules', 'package.json'], { cwd: staging })
  await rm(staging, { recursive: true, force: true })
  return asset
}

test('assembles a release asset into the same upload tree as the local build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assemble-runtime-'))
  try {
    await fakeAsset(root, 'deepseek-harness-pkg-macos-arm64.zip')
    await fakeAsset(root, 'deepseek-harness-pkg-linux.zip')

    await run(process.execPath, [
      script,
      '--packages', root,
      '--version', '0.1.7-rc.1',
      '--build-id', '20260923.1200',
      '--output', join(root, 'out'),
      '--allow-partial',
    ])

    const payload = join(root, 'out', 'upload', 'harness')
    const releaseDir = join(payload, 'releases', '0.1.7-rc.1', '20260923.1200')
    const manifest = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.version, '0.1.7-rc.1')
    assert.equal(manifest.buildId, '20260923.1200')
    assert.equal(manifest.sourceCommit, '9d55f38abcdef')
    assert.equal(manifest.sourceDirty, false)
    assert.equal(manifest.nodeVersion, '22.22.0')
    assert.deepEqual(manifest.bundledPlugins, ['dsh-tauri@0.6.7'])
    assert.equal(manifest.minimumDesktopVersion, '0.6.8')
    assert.deepEqual(Object.keys(manifest.assets).sort(), ['linux-x64', 'macos-arm64'])
    for (const asset of Object.values(manifest.assets)) {
      assert.match(asset.path, /^\/harness\/releases\/0\.1\.7-rc\.1\/20260923\.1200\/deepseek-harness-runtime-/)
      assert.match(asset.sha256, /^[0-9a-f]{64}$/)
    }

    // 渠道清单与 release 目录里的清单必须逐字节一致。
    assert.equal(
      await readFile(join(payload, 'channels/stable/latest.json'), 'utf8'),
      await readFile(join(releaseDir, 'manifest.json'), 'utf8'),
    )
    // 资产按运行时命名落盘，名字与 metadata.filename 一致。
    const archived = (await readdir(releaseDir)).filter(name => name.endsWith('.zip')).sort()
    assert.deepEqual(archived, [
      'deepseek-harness-runtime-linux-x64.zip',
      'deepseek-harness-runtime-macos-arm64.zip',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses a partial platform set unless --allow-partial is passed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assemble-runtime-partial-'))
  try {
    await fakeAsset(root, 'deepseek-harness-pkg-macos-arm64.zip')
    await assert.rejects(
      run(process.execPath, [script, '--packages', root, '--version', '0.1.7-rc.1', '--output', join(root, 'out')]),
      /missing platform archives/,
    )
    // 本地构建只出当前平台，因此 --allow-partial 必须放行。
    await run(process.execPath, [
      script,
      '--packages', root,
      '--version', '0.1.7-rc.1',
      '--output', join(root, 'out'),
      '--allow-partial',
    ])
    const manifest = JSON.parse(
      await readFile(join(root, 'out', 'upload', 'harness', 'channels', 'stable', 'latest.json'), 'utf8'),
    )
    assert.deepEqual(Object.keys(manifest.assets), ['macos-arm64'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
