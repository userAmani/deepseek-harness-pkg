import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const script = resolve(import.meta.dirname, 'generate-local-release.mjs')

test('generates a manually uploadable partial release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-release-'))
  try {
    const artifacts = join(root, 'artifacts')
    const output = join(root, 'output')
    const filename = 'deepseek-harness-runtime-macos-arm64.zip'
    await mkdir(artifacts)
    await writeFile(join(artifacts, filename), 'archive')
    await writeFile(join(artifacts, `${filename}.json`), `${JSON.stringify({
      schemaVersion: 1,
      platform: 'macos-arm64',
      filename,
      version: '1.2.3',
      nodeVersion: '22.22.0',
      sourceCommit: 'abcdef123456',
      sourceDirty: true,
      sha256: 'a'.repeat(64),
    })}\n`)

    await run([
      '--',
      '--artifacts', artifacts,
      '--output', output,
      '--version', '1.2.3',
      '--build-id', '20260831.1',
      '--minimum-desktop-version', '0.6.8',
      '--prefix', '/harness',
      '--allow-partial',
    ])

    const manifest = JSON.parse(await readFile(
      join(output, 'harness', 'channels', 'stable', 'latest.json'),
      'utf8',
    ))
    assert.equal(manifest.sourceDirty, true)
    assert.deepEqual(manifest.assets['macos-arm64'], {
      path: '/harness/releases/1.2.3/20260831.1/deepseek-harness-runtime-macos-arm64.zip',
      sha256: 'a'.repeat(64),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`generator exited with ${code}`)))
  })
}
