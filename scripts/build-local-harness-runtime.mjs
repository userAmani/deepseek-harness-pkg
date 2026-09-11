#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

const packageRoot = resolve(import.meta.dirname, '..')
const platform = resolvePlatform(process.platform, process.arch)
const bundledPlugins = [
  {
    name: 'dsh-tauri',
    version: '0.6.7',
    tarball: 'https://registry.npmjs.org/dsh-tauri/-/dsh-tauri-0.6.7.tgz',
    sha512: 'uWr7BmekXYcBv4Xnkr3uYAF381SdZtnbC7o5g23kl3XY+sqPpmoZi308MgfM5ltEP/fHkWXNeKr32bzVGmCyAg==',
    webBundle: true,
  },
]

function fail(message) {
  throw new Error(`LOCAL_HARNESS_BUILD_INVALID: ${message}`)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!argument.startsWith('--')) fail(`unexpected argument ${argument}`)
    const [inlineName, inlineValue] = argument.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      options[inlineName] = inlineValue
      continue
    }
    if (['skip-install', 'skip-build'].includes(inlineName)) {
      options[inlineName] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`--${inlineName} requires a value`)
    options[inlineName] = value
    index += 1
  }
  return options
}

function required(options, name) {
  const value = options[name]?.trim()
  if (!value) fail(`--${name} is required`)
  return value
}

function validateSemver(value, name) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    fail(`--${name} must be a SemVer version`)
  }
  return value
}

function resolvePlatform(nodePlatform, architecture) {
  const key = `${nodePlatform}-${architecture}`
  const platforms = {
    'win32-x64': ['windows-x64', 'deepseek-harness-runtime-windows-x64.zip'],
    'darwin-arm64': ['macos-arm64', 'deepseek-harness-runtime-macos-arm64.zip'],
    'darwin-x64': ['macos-x64', 'deepseek-harness-runtime-macos-x64.zip'],
    'linux-x64': ['linux-x64', 'deepseek-harness-runtime-linux-x64.zip'],
  }
  const resolved = platforms[key]
  if (resolved === undefined) fail(`unsupported build platform ${key}`)
  return { key: resolved[0], archive: resolved[1] }
}

async function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(' ')}`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: 'true' }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} failed with ${code === null ? `signal ${signal}` : `exit ${code}`}`))
    })
  })
}

function pnpmInvocation(args) {
  const entrypoint = process.env.npm_execpath?.trim()
  if (entrypoint) {
    const extension = extname(entrypoint).toLowerCase()
    if (['.js', '.cjs', '.mjs'].includes(extension)) {
      return [process.execPath, [entrypoint, ...args]]
    }
  }
  const pnpmHome = process.env.PNPM_HOME?.trim()
  if (pnpmHome) {
    const packageBin = resolve(pnpmHome, '..', 'pnpm', 'bin')
    for (const filename of ['pnpm.mjs', 'pnpm.cjs']) {
      const candidate = resolve(packageBin, filename)
      if (existsSync(candidate)) return [process.execPath, [candidate, ...args]]
    }
  }
  if (process.platform === 'win32') {
    fail('run this script through pnpm so Windows can resolve the pnpm JavaScript entrypoint')
  }
  return ['pnpm', args]
}

async function runPnpm(args, cwd) {
  const [command, invocationArgs] = pnpmInvocation(args)
  await run(command, invocationArgs, cwd)
}

async function restoreLegacyHoists(harnessRoot, staging) {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
  const sourceNodeModules = join(harnessRoot, 'python', 'sdk-runtime', 'node_modules')
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) fail(`deployed dependency ${dependency} is missing from the runtime closure`)
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
  }
}

async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    const metadata = await lstat(entryPath)
    if (metadata.isSymbolicLink()) return entryPath
    if (metadata.isDirectory()) {
      const nested = await findSymlink(entryPath)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeLinks(staging) {
  const nodeModules = join(staging, 'node_modules')
  let link = await findSymlink(nodeModules)
  while (link !== undefined) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
    } else {
      const source = await realpath(link)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(link, { recursive: true, force: true })
      await cp(source, link, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
    }
    link = await findSymlink(nodeModules)
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function installBundledPlugin(staging, outputRoot, plugin) {
  const response = await fetch(plugin.tarball)
  if (!response.ok) fail(`failed to download ${plugin.name}@${plugin.version}: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha512').update(archive).digest('base64')
  if (actual !== plugin.sha512) fail(`integrity mismatch for ${plugin.name}@${plugin.version}`)

  const pluginId = `${plugin.name}-${plugin.version}`.replaceAll('/', '__')
  const pluginRoot = join(outputRoot, 'bundled-plugins', pluginId)
  const archivePath = `${pluginRoot}.tgz`
  await rm(pluginRoot, { recursive: true, force: true })
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(archivePath, archive)
  const archivePathFromPluginRoot = relative(pluginRoot, archivePath)
  await run('tar', ['-xzf', archivePathFromPluginRoot], pluginRoot)

  const source = join(pluginRoot, 'package')
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (manifest.name !== plugin.name || manifest.version !== plugin.version) {
    fail(`downloaded package identity does not match ${plugin.name}@${plugin.version}`)
  }
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !existsSync(join(source, patch))) {
    fail(`${plugin.name}@${plugin.version} does not contain a valid dsh bundle`)
  }

  const destination = join(staging, 'node_modules', ...plugin.name.split('/'))
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
  await rm(archivePath, { force: true })
  await rm(pluginRoot, { recursive: true, force: true })
}

async function gitOutput(harnessRoot, args) {
  let stdout = ''
  await new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd: harnessRoot, stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`git ${args.join(' ')} failed`)))
  })
  return stdout.trim()
}

async function createArchive(staging, archive) {
  await rm(archive, { force: true })
  if (process.platform === 'win32') {
    await run('7z', ['a', '-tzip', archive, 'node_modules', 'package.json'], staging)
  } else {
    await run('zip', ['-qr', archive, 'node_modules', 'package.json'], staging)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const harnessRoot = resolve(options.harness ?? join(packageRoot, '..', 'deepseek-harness'))
  const outputRoot = resolve(options.output ?? join(packageRoot, 'dist', 'local-runtime'))
  const version = validateSemver(required(options, 'version'), 'version')
  const nodeVersion = validateSemver(options['node-version'] ?? '22.22.0', 'node-version')
  const harnessManifest = join(harnessRoot, 'package.json')
  if (!existsSync(harnessManifest) || !existsSync(join(harnessRoot, 'python', 'sdk-runtime', 'package.json'))) {
    fail(`--harness does not point to a DeepSeek Harness workspace: ${harnessRoot}`)
  }

  const artifacts = join(outputRoot, 'artifacts')
  const staging = join(outputRoot, 'staging', platform.key)
  const archive = join(artifacts, platform.archive)
  await mkdir(artifacts, { recursive: true })
  await rm(staging, { recursive: true, force: true })

  if (!options['skip-install']) await runPnpm(['install', '--frozen-lockfile'], harnessRoot)
  if (!options['skip-build']) {
    await runPnpm(['run', 'clean'], harnessRoot)
    await runPnpm(['run', 'build:official'], harnessRoot)
  }
  await runPnpm(['run', 'verify-runtime-closure'], harnessRoot)
  await runPnpm([
    '--filter',
    'dsh-python-runtime-closure',
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    staging,
  ], harnessRoot)
  await restoreLegacyHoists(harnessRoot, staging)
  await materializeLinks(staging)

  for (const plugin of bundledPlugins) {
    await installBundledPlugin(staging, outputRoot, plugin)
  }

  await writeFile(join(staging, 'package.json'), `${JSON.stringify({
    name: 'deepseek-harness-desktop-runtime',
    version,
    private: true,
    type: 'module',
    dsh: {
      desktop: {
        webBundles: bundledPlugins.filter(plugin => plugin.webBundle).map(plugin => plugin.name),
      },
    },
  }, null, 2)}\n`)
  await run(process.execPath, [
    join(packageRoot, 'scripts', 'apply-dsh-web-app-patch.mjs'),
    `--file=${join(staging, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'lib', 'startup.js')}`,
  ], packageRoot)

  const entry = join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) fail(`runtime entry is missing: ${entry}`)
  await run(process.execPath, [entry, '--version'], staging)
  await run(process.execPath, [entry, 'web', '--help'], staging)
  await createArchive(staging, archive)

  const sourceCommit = await gitOutput(harnessRoot, ['rev-parse', 'HEAD'])
  const sourceDirty = (await gitOutput(harnessRoot, ['status', '--porcelain'])).length > 0
  const metadata = {
    schemaVersion: 1,
    platform: platform.key,
    filename: platform.archive,
    version,
    nodeVersion,
    sourceCommit,
    sourceDirty,
    bundledPlugins: bundledPlugins.map(plugin => `${plugin.name}@${plugin.version}`),
    sha256: await sha256(archive),
  }
  await writeFile(`${archive}.json`, `${JSON.stringify(metadata, null, 2)}\n`)
  console.log(`\nRuntime archive: ${archive}`)
  console.log(`Metadata: ${archive}.json`)
}

await main()
