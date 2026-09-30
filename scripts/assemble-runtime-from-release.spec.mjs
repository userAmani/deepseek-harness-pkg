import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
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

test('replaces an oversized stale release asset instead of resuming it', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'assemble-runtime-stale-'))
  try {
    const assetName = 'deepseek-harness-pkg-windows.zip'
    const source = await fakeAsset(root, assetName)
    const sourceBuffer = await readFile(source)
    const expected = createHash('sha256').update(sourceBuffer).digest('hex')
    const packages = join(root, 'packages')
    await mkdir(packages)
    const downloaded = join(packages, assetName)
    await writeFile(downloaded, Buffer.alloc((await stat(source)).size + 1))

    const bin = join(root, 'bin')
    await mkdir(bin)
    const curl = join(bin, 'curl')
    await writeFile(curl, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const url = args.at(-1)
if (url.startsWith('https://api.github.com/')) {
  // 列表接口（?per_page=…）在真实世界返回数组，/latest 返回单个对象 —— 假 curl 也照此区分。
  const payload = JSON.parse(process.env.FAKE_RELEASE_JSON)
  process.stdout.write(url.includes('per_page') ? JSON.stringify([payload]) : JSON.stringify(payload))
} else {
  const output = args[args.indexOf('-o') + 1]
  const source = process.env.FAKE_ASSET_PATH
  const offset = fs.existsSync(output) ? fs.statSync(output).size : 0
  if (!args.includes('-C') || offset < fs.statSync(source).size) fs.copyFileSync(source, output)
}
`)
    await chmod(curl, 0o755)
    const release = {
      name: 'Release-0.1.7-rc.1',
      tag_name: 'dsh-0.1.7-rc.1-test',
      assets: [{
        name: assetName,
        size: sourceBuffer.length,
        digest: `sha256:${expected}`,
        browser_download_url: 'https://github.com/example/release.zip',
      }],
    }
    await run(process.execPath, [
      script,
      '--platforms', 'windows-x64',
      '--allow-partial',
      '--download-dir', packages,
      '--output', join(root, 'out'),
    ], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_RELEASE_JSON: JSON.stringify(release),
        FAKE_ASSET_PATH: source,
      },
    })

    assert.equal(createHash('sha256').update(await readFile(downloaded)).digest('hex'), expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('forwards --proxy to curl for both the API call and the asset download', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'assemble-runtime-proxy-'))
  try {
    const assetName = 'deepseek-harness-pkg-windows.zip'
    const source = await fakeAsset(root, assetName)
    const argvLog = join(root, 'curl-argv.log')

    const bin = join(root, 'bin')
    await mkdir(bin)
    const curl = join(bin, 'curl')
    // 每次调用都把 argv 落盘，这样"代理有没有真的传给 curl"是可断言的，而不是靠盯着日志看。
    await writeFile(curl, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CURL_ARGV_LOG, args.join(' ') + '\\n')
const url = args.at(-1)
if (url.startsWith('https://api.github.com/')) {
  const payload = JSON.parse(process.env.FAKE_RELEASE_JSON)
  process.stdout.write(url.includes('per_page') ? JSON.stringify([payload]) : JSON.stringify(payload))
} else {
  fs.copyFileSync(process.env.FAKE_ASSET_PATH, args[args.indexOf('-o') + 1])
}
`)
    await chmod(curl, 0o755)

    await run(process.execPath, [
      script,
      '--platforms', 'windows-x64',
      '--allow-partial',
      '--proxy', '127.0.0.1:7890',
      '--download-dir', join(root, 'packages'),
      '--output', join(root, 'out'),
    ], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_ASSET_PATH: source,
        FAKE_CURL_ARGV_LOG: argvLog,
        FAKE_RELEASE_JSON: JSON.stringify({
          name: 'Release-0.2.0-rc.1',
          tag_name: 'dsh-0.2.0-rc.1-36424634893',
          draft: false,
          assets: [{
            name: assetName,
            browser_download_url: `https://github.com/dsh-tauri/deepseek-harness-pkg/releases/download/x/${assetName}`,
            size: (await stat(source)).size,
          }],
        }),
      },
    })

    const withProxy = (await readFile(argvLog, 'utf8'))
      .split('\n')
      .filter(line => line.includes('--proxy'))
    assert.equal(withProxy.length, 2, 'API 请求与资产下载各应带一次 --proxy')
    assert.ok(withProxy.every(line => line.includes('--proxy http://127.0.0.1:7890')), '缺 scheme 的写法要补成 http://')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizes proxy values and reads them from the environment', async () => {
  const { normalizeProxy, resolveProxy, isProxyReachable } = await import(pathToFileURL(script).href)
  assert.equal(normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxy('  127.0.0.1:7890 '), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxy('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
  assert.equal(normalizeProxy('http://user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890')
  assert.equal(normalizeProxy(''), undefined)
  assert.equal(normalizeProxy(undefined), undefined)

  // 优先级：--proxy > --no-proxy > 环境变量 > 内置默认代理。
  const reachable = async () => true
  const unreachable = async () => false
  assert.equal(await resolveProxy({}, {}, reachable), 'http://127.0.0.1:7890', '默认走本机 7890')
  assert.equal(await resolveProxy({}, {}, unreachable), undefined, '默认代理没开时直连，不阻断下载')
  assert.equal(
    await resolveProxy({ 'no-proxy': true }, { HTTPS_PROXY: '127.0.0.1:8888' }, reachable),
    undefined,
    '--no-proxy 压过环境变量',
  )
  assert.equal(
    await resolveProxy({}, { ASSEMBLE_RUNTIME_PROXY: '127.0.0.1:9999' }, unreachable),
    'http://127.0.0.1:9999',
    '环境变量次之，且不探测',
  )
  let probed = false
  assert.equal(
    await resolveProxy({ proxy: 'socks5://127.0.0.1:1080' }, { HTTPS_PROXY: '127.0.0.1:8888' }, async () => {
      probed = true
      return false
    }),
    'socks5://127.0.0.1:1080',
    '--proxy 最优先',
  )
  assert.equal(probed, false, '显式指定不做可达性探测')

  // 探测本身：未监听的端口判为不可达，非法值直接 false。
  assert.equal(await isProxyReachable('http://127.0.0.1:9'), false)
  assert.equal(await isProxyReachable('not-a-url'), false)
})

// 「最新」取 semver 最高的已发布版本，而不是 GitHub 的 latest 标记：那个标记由维护者显式
// 指定，实测会停在旧线上（0.2.0-rc.1 已发布、latest 仍指向 0.1.7-rc.2），导致一直下 0.1。
test('picks the semver-highest published release, not GitHub’s latest flag', async () => {
  const { pickLatestRelease, versionOf } = await import(pathToFileURL(script).href)

  // 标题带 dsh- 前缀的旧发布：退回 tag 推断版本号。
  assert.equal(
    versionOf({ name: 'Release-dsh-0.1.6-alpha.1', tag_name: 'dsh-0.1.6-alpha.1-34932890432' }),
    '0.1.6-alpha.1',
  )

  const releases = [
    { name: 'Release-0.1.7-rc.2', tag_name: 'dsh-0.1.7-rc.2-36024748146', draft: false },
    { name: 'Release-0.2.0-rc.1', tag_name: 'dsh-0.2.0-rc.1-36424634893', draft: false },
    { name: 'Release-0.1.7-rc.1', tag_name: 'dsh-0.1.7-rc.1-35871708301', draft: false },
  ]
  assert.equal(pickLatestRelease(releases).tag_name, 'dsh-0.2.0-rc.1-36424634893')

  // 草稿不参与；正式版高于同号 rc。
  assert.equal(
    pickLatestRelease([...releases, { name: 'Release-0.9.9', tag_name: 'dsh-0.9.9-1', draft: true }]).tag_name,
    'dsh-0.2.0-rc.1-36424634893',
  )
  assert.equal(
    pickLatestRelease([...releases, { name: 'Release-0.2.0', tag_name: 'dsh-0.2.0-999', draft: false }]).tag_name,
    'dsh-0.2.0-999',
  )
})
