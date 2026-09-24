#!/usr/bin/env node
//
// 用 GitHub Release 里现成的平台包，组装出与本地 `build-runtime.sh` 相同的上传目录。
//
// 背景：私有 Harness 源码构建（build-local-harness-runtime.mjs，本地或
// build-private-harness.yml）很慢，但如果没有改过 Harness 源码，CI 发布的
// `deepseek-harness-pkg-<平台>.zip` 内容与自建产物是同一形态（都是 deploy 后的
// `node_modules/ + package.json`，都打过同一份 dsh-web-app 补丁、都做过瘦身）。
//
// 因此这里只做「构建」那一步的等价替换：
//   1. 把 release 资产按平台改名成 `deepseek-harness-runtime-<平台>.zip`；
//   2. 补上 generate-local-release.mjs 需要的同名 `.zip.json` 元数据
//      （platform / filename / version / sha256 / sourceCommit / sourceDirty /
//        nodeVersion / bundledPlugins）；
//   3. 复用 scripts/generate-local-release.mjs 生成 releases/<版本>/<buildId>/
//      与 channels/stable/latest.json —— 与 CI、与本地构建产物逐字段一致。
//
// 用法：
//   # 零参数直接跑：取最新 release、自己下载（校验官方 sha256）并组装
//   node scripts/assemble-runtime-from-release.mjs
//
//   # 需要指定版本 / 只取部分平台 / 用本地已下好的包时：
//   node scripts/assemble-runtime-from-release.mjs --version 0.1.7-rc.1 --platforms macos-arm64
//   node scripts/assemble-runtime-from-release.mjs --packages ~/Downloads/release
//
// 常用参数（都有默认值，通常不用传）：
//   --version <SemVer|latest>  dsh 版本，默认 latest（自动读出真实版本号）
//   --download                 下载 release 资产；不给 --packages 时默认开启
//   --platforms a,b            只处理指定平台，默认全部四个
//   --platforms a,b            只处理指定平台（默认全部）
//   --list-releases            列出仓库里可用的发布版本后退出
//   --download-dir <目录>      下载落盘目录，默认 <output>/packages
//   --harness ../deepseek-harness
//   --build-id / --minimum-desktop-version / --node-version / --prefix / --output / --allow-partial
//
// 参数与 build-runtime.sh / build-private-harness.yml 对齐，默认值保持一致。

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

/** 平台 → release 资产名 / 运行时包名。资产名与 release.yml 的 matrix 一致。 */
const platforms = {
  'windows-x64': {
    asset: 'deepseek-harness-pkg-windows.zip',
    archive: 'deepseek-harness-runtime-windows-x64.zip',
  },
  'macos-arm64': {
    asset: 'deepseek-harness-pkg-macos-arm64.zip',
    archive: 'deepseek-harness-runtime-macos-arm64.zip',
  },
  'macos-x64': {
    asset: 'deepseek-harness-pkg-macos-x64.zip',
    archive: 'deepseek-harness-runtime-macos-x64.zip',
  },
  'linux-x64': {
    asset: 'deepseek-harness-pkg-linux.zip',
    archive: 'deepseek-harness-runtime-linux-x64.zip',
  },
}

const releaseApi = 'https://api.github.com/repos/dsh-tauri/deepseek-harness-pkg/releases'

/** 自建运行时会打进包里的插件。缺失时只提示，不阻断（桌面端自带这些插件）。 */
const bundledPluginCandidates = ['dsh-tauri']

function fail(message) {
  throw new Error(`ASSEMBLE_RUNTIME_INVALID: ${message}`)
}

function parseArgs(argv) {
  const options = { packages: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!argument.startsWith('--')) fail(`unexpected argument ${argument}`)
    const name = argument.slice(2)
    if (name === 'allow-partial' || name === 'download' || name === 'list-releases') {
      options[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`--${name} requires a value`)
    if (name === 'packages') options.packages.push(value)
    else options[name] = value
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

/** 与 build-runtime.sh 的 `date +%Y%m%d.%H%M` 对齐（本地时区）。 */
function defaultBuildId(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `${date}.${pad(now.getHours())}${pad(now.getMinutes())}`
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 收集 `--packages` 指向的 zip：目录则展开，文件则直接用。 */
async function collectCandidates(paths) {
  const files = []
  for (const path of paths) {
    const resolved = resolve(path)
    if (await isDirectory(resolved)) {
      for (const entry of await readdir(resolved)) {
        if (extname(entry).toLowerCase() === '.zip') files.push(join(resolved, entry))
      }
      continue
    }
    if (extname(resolved).toLowerCase() !== '.zip') fail(`not a zip: ${resolved}`)
    files.push(resolved)
  }
  if (files.length === 0) fail('--packages did not yield any .zip')
  return files
}

function matchPlatform(file) {
  const name = basename(file)
  const hit = Object.entries(platforms).find(([, value]) => value.asset === name)
  if (hit === undefined) {
    fail(`unrecognized release asset ${name}；期望 ${Object.values(platforms).map(v => v.asset).join(', ')}`)
  }
  return hit
}

/**
 * 兜底解析 sourceCommit：npm 装出来的 `@deepseek-ai/dsh/package.json` 通常不带
 * `gitHead`（实测 0.1.7-rc.1 就是），所以再拿 Harness 源码里的同名 tag 反查一次
 * （`dsh-v<版本>` / `v<版本>`）。桌面端要求该字段非空。
 */
async function commitFromHarnessTags(harnessDir, version) {
  for (const tag of [`dsh-v${version}`, `v${version}`]) {
    try {
      const output = await run('git', ['rev-parse', tag], { capture: true, cwd: harnessDir })
      const commit = output.trim()
      if (commit) return commit
    } catch { /* 换下一个 tag */ }
  }
  return undefined
}

function githubArgs(url, token, extra = []) {
  const args = ['-sS', '-L', '--fail', '-H', 'Accept: application/vnd.github+json', ...extra]
  if (token) args.push('-H', `Authorization: Bearer ${token}`)
  return [...args, url]
}

async function githubJson(url, token) {
  return JSON.parse(await run('curl', githubArgs(url, token), { capture: true }))
}

/** tag 形如 `dsh-<版本>-<run_id>`、标题形如 `Release-<版本>`；重跑会有多条，取最新一条。 */
async function findRelease(version, token) {
  if (version === 'latest') return githubJson(`${releaseApi}/latest`, token)
  const releases = await githubJson(`${releaseApi}?per_page=100`, token)
  const matches = releases.filter(release => (
    release.name === `Release-${version}`
    || String(release.tag_name ?? '').startsWith(`dsh-${version}-`)
  ))
  if (matches.length === 0) {
    const known = releases.map(release => String(release.name ?? '').replace(/^Release-/, '')).filter(Boolean)
    fail(`找不到版本 ${version} 的 release；可用：${known.slice(0, 12).join(', ')}`)
  }
  return matches.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0]
}

/** 下载 release 资产：已存在且 sha256 与官方摘要一致时跳过，下载后逐字节复核。 */
async function downloadAssets(release, directory, { selected, token }) {
  await mkdir(directory, { recursive: true })
  const files = []
  for (const [platform, value] of Object.entries(platforms)) {
    if (selected !== undefined && !selected.has(platform)) continue
    const asset = (release.assets ?? []).find(candidate => candidate.name === value.asset)
    if (asset === undefined) fail(`release ${release.tag_name} 里没有资产 ${value.asset}`)
    const target = join(directory, value.asset)
    const expected = String(asset.digest ?? '').replace(/^sha256:/, '')
    if (expected && await sha256Of(target).catch(() => undefined) === expected) {
      console.log(`  已存在且校验通过：${value.asset}`)
      files.push(target)
      continue
    }
    console.log(`  下载 ${value.asset}（${(asset.size / 1048576).toFixed(1)} MiB）`)
    await run('curl', githubArgs(asset.browser_download_url, token, [
      '--progress-bar', '-C', '-', '-o', target, '--retry', '3', '--retry-delay', '2',
    ]))
    const actual = await sha256Of(target)
    if (expected && actual !== expected) {
      fail(`${value.asset} 校验失败：官方 ${expected}，实际 ${actual}（删掉该文件后重试）`)
    }
    files.push(target)
  }
  return files
}

async function sha256Of(path) {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

/** 从 zip 里读一个 JSON（用系统 unzip；读不到就返回 undefined）。 */
async function readJsonInside(zip, entry) {
  try {
    const output = await run(process.env.UNZIP ?? 'unzip', ['-p', zip, entry], { capture: true })
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

function run(command, args, { capture = false, cwd } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' })
    let stdout = ''
    if (capture) child.stdout.on('data', chunk => { stdout += chunk })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(`${command} exited with ${code}`))
    })
  })
}

function parsePlatformFilter(value) {
  if (value === undefined) return undefined
  const selected = new Set(value.split(',').map(name => name.trim()).filter(Boolean))
  for (const platform of selected) {
    if (!(platform in platforms)) fail(`unknown platform ${platform}；可选 ${Object.keys(platforms).join(', ')}`)
  }
  return selected
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = options.token?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined

  if (options['list-releases']) {
    const releases = await githubJson(`${releaseApi}?per_page=100`, token)
    for (const release of releases.slice(0, 20)) {
      const name = String(release.name ?? '').replace(/^Release-/, '') || '(未命名)'
      console.log(`  ${name.padEnd(18)} tag=${release.tag_name}  资产=${(release.assets ?? []).length}`)
    }
    return
  }

  let version = options.version?.trim() || 'latest'
  // 默认写到独立目录：build-runtime.sh 的 dist/private-runtime 里可能残留别的版本
// 产物，混在一起会让 generate-local-release.mjs 的版本校验直接失败。
  const output = resolve(options.output ?? 'dist/release-runtime')
  const buildId = options['build-id']?.trim() || defaultBuildId()
  const minimumDesktopVersion = options['minimum-desktop-version']?.trim() ?? '0.6.8'
  const nodeVersion = options['node-version']?.trim() ?? '22.22.0'
  const prefix = normalizePrefix(options.prefix ?? '/harness')
  const harnessDir = resolve(options.harness ?? '../deepseek-harness')
  const explicitCommit = options['source-commit']?.trim()
  const selectedPlatforms = parsePlatformFilter(options.platforms)
  let candidates
  const download = options.download || options.packages.length === 0
  if (download) {
    if (options.packages.length > 0) fail('--download 与 --packages 不能同时用')
    const release = await findRelease(version, token)
    if (version === 'latest') {
      version = String(release.name ?? '').replace(/^Release-/, '')
      if (!version) fail(`无法从 release ${release.tag_name} 推断版本，请显式传 --version`)
    }
    console.log(`发布 ${release.name}（tag ${release.tag_name}）`)
    candidates = await downloadAssets(release, resolve(options['download-dir'] ?? join(output, 'packages')), {
      selected: selectedPlatforms,
      token,
    })
  } else {
    candidates = await collectCandidates(options.packages.length > 0 ? options.packages : [output])
  }

  const artifacts = join(output, 'artifacts')
  await mkdir(artifacts, { recursive: true })

  const selected = new Map()
  for (const file of candidates) {
    const [platform] = matchPlatform(file)
    if (selectedPlatforms !== undefined && !selectedPlatforms.has(platform)) continue
    if (selected.has(platform)) fail(`duplicate release asset for ${platform}`)
    selected.set(platform, file)
  }
  if (!options['allow-partial'] && selected.size !== Object.keys(platforms).length) {
    const missing = Object.entries(platforms)
      .filter(([platform]) => !selected.has(platform))
      .map(([, value]) => value.asset)
    fail(`missing platform archives: ${missing.join(', ')}（只装了部分平台时加 --allow-partial）`)
  }

  const metadata = []
  for (const [platform, source] of selected) {
    const { archive } = platforms[platform]
    const target = join(artifacts, archive)
    await copyFile(source, target)

    const cliManifest = await readJsonInside(source, 'node_modules/@deepseek-ai/dsh/package.json')
    const sourceCommit = explicitCommit
      ?? cliManifest?.gitHead
      ?? await commitFromHarnessTags(harnessDir, version)
    if (!sourceCommit) {
      fail(
        `无法确定 sourceCommit：${basename(source)} 里的 @deepseek-ai/dsh 没有 gitHead，`
        + `也没能在 ${harnessDir} 找到 tag dsh-v${version} / v${version}；请显式传 --source-commit`,
      )
    }
    const bundledPlugins = []
    for (const name of bundledPluginCandidates) {
      const plugin = await readJsonInside(source, `node_modules/${name}/package.json`)
      if (plugin?.version) bundledPlugins.push(`${plugin.name ?? name}@${plugin.version}`)
    }

    const value = {
      schemaVersion: 1,
      platform,
      filename: archive,
      version,
      nodeVersion,
      sourceCommit,
      sourceDirty: false,
      bundledPlugins,
      sha256: await sha256Of(target),
    }
    await writeFile(`${target}.json`, `${JSON.stringify(value, null, 2)}\n`)
    metadata.push(value)
    console.log(`  ${platform}: ${archive}（${bundledPlugins.join(', ') || '无内置插件'}）`)
  }

  const missingBundled = bundledPluginCandidates.filter(
    name => !metadata.some(value => value.bundledPlugins.some(entry => entry.startsWith(`${name}@`))),
  )
  if (missingBundled.length > 0) {
    console.warn(
      `  注意：release 包里没有 ${missingBundled.join(', ')}；自建运行时会内置它们。`
      + '桌面端自带这些插件（内置预设指向应用资源），通常不影响使用。',
    )
  }

  console.log('\n生成上传目录…')
  await run(process.execPath, [
    join(import.meta.dirname, 'generate-local-release.mjs'),
    '--artifacts', artifacts,
    '--output', join(output, 'upload'),
    '--version', version,
    '--build-id', buildId,
    '--minimum-desktop-version', minimumDesktopVersion,
    '--prefix', prefix,
    ...(options['allow-partial'] ? ['--allow-partial'] : []),
  ])

  const payload = join(output, 'upload', 'harness')
  console.log(`\n上传目录: ${payload}`)
  console.log(`  清单 : ${prefix}/channels/stable/latest.json`)
  console.log(`  资产 : ${prefix}/releases/${version}/${buildId}/`)
  console.log('把该目录内容按相同路径上传即可（清单走 web 域名、安装包走 CDN 域名）。')
}

await main()
