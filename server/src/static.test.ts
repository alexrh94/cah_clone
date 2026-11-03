import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { contentTypeFor, resolveClientFile, safeStaticPath } from './static.js'

test('contentTypeFor maps known extensions and falls back for the rest', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8')
  assert.equal(contentTypeFor('app.JS'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('file.bin'), 'application/octet-stream')
})

test('safeStaticPath keeps requests inside the client directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'cah-static-'))
  assert.equal(safeStaticPath(root, '/'), join(root, 'index.html'))
  assert.equal(safeStaticPath(root, '/assets/app.js?cache=1'), join(root, 'assets', 'app.js'))
  assert.equal(safeStaticPath(root, '/../package.json'), null)
  assert.equal(safeStaticPath(root, '/%'), null)
})

test('resolveClientFile serves files, directory indexes, and the spa fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'cah-client-'))
  writeFileSync(join(root, 'index.html'), '<h1>Cards Against Humanity</h1>')
  mkdirSync(join(root, 'nested'))
  writeFileSync(join(root, 'nested', 'index.html'), 'nested')
  writeFileSync(join(root, 'app.js'), 'console.log(1)')

  const rootFile = resolveClientFile(root, '/')
  assert.equal(rootFile.ok, true)
  if (rootFile.ok) assert.equal(rootFile.filePath, join(root, 'index.html'))

  const nested = resolveClientFile(root, '/nested')
  assert.equal(nested.ok, true)
  if (nested.ok) assert.equal(nested.filePath, join(root, 'nested', 'index.html'))

  const script = resolveClientFile(root, '/app.js')
  assert.equal(script.ok, true)
  if (script.ok) assert.equal(script.filePath, join(root, 'app.js'))

  const fallback = resolveClientFile(root, '/room/ABCD')
  assert.equal(fallback.ok, true)
  if (fallback.ok) assert.equal(fallback.filePath, join(root, 'index.html'))

  assert.deepEqual(resolveClientFile(root, '/missing.js'), { ok: false, status: 404 })
  assert.deepEqual(resolveClientFile(root, '/../secret'), { ok: false, status: 400 })
})
