import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocket, type RawData } from 'ws'
import { UNDERSCORE_MESSAGE } from './deck.js'
import { cleanNickname, closeGameServer, createGameServer, listen, parsePort } from './server.js'

const sampleDecksDir = fileURLToPath(new URL('../../decks', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

test('cleanNickname trims, collapses spaces, and limits the length', () => {
  assert.equal(cleanNickname('  Alex   Rider  '), 'Alex Rider')
  assert.equal(cleanNickname('A'.repeat(40)), 'A'.repeat(24))
  assert.equal(cleanNickname(' \n Sam \t '), 'Sam')
  assert.equal(cleanNickname('   '), '')
})

test('parsePort accepts empty values and rejects out-of-range ports', () => {
  assert.equal(parsePort(undefined), 3000)
  assert.equal(parsePort('  '), 3000)
  assert.equal(parsePort('8080'), 8080)
  assert.throws(() => parsePort('70000'), /Invalid PORT/)
  assert.throws(() => parsePort('abc'), /Invalid PORT/)
})

function track(socket: WebSocket) {
  const messages: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []

  socket.on('message', (data: RawData) => {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString()
    const message: unknown = JSON.parse(text)
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else messages.push(message)
  })

  return {
    next(): Promise<unknown> {
      const queued = messages.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
    send(message: unknown) {
      socket.send(JSON.stringify(message))
    },
  }
}

async function until(client: ReturnType<typeof track>, type: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const message = await client.next()
    if (isRecord(message) && message.type === type) return message
  }
  throw new Error(`Timed out waiting for ${type}`)
}

test('createGameServer serves the client and accepts a websocket', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  const decksDir = mkdtempSync(join(tmpdir(), 'cah-decks-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')

  const gameServer = createGameServer(clientDir, decksDir)
  const port = await listen(gameServer, 0)

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Cards Against Humanity/)

    const head = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')

    const missing = await fetch(`http://127.0.0.1:${port}/missing.js`)
    assert.equal(missing.status, 404)

    const rejected = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })
    assert.equal(rejected.status, 405)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const client = track(socket)
    const connected = await client.next()
    assert.equal(isRecord(connected) && connected.type, 'connected')
    assert.deepEqual(await client.next(), { type: 'decks', decks: [] })
    socket.close()
  } finally {
    await closeGameServer(gameServer)
  }
})

test('a built-in deck without an underscore is reported to the client', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  const decksDir = mkdtempSync(join(tmpdir(), 'cah-decks-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const missing = "Why can't I sleep at night?"
  writeFileSync(
    join(decksDir, 'broken.json'),
    JSON.stringify({ name: 'Broken', black: [missing], white: ['an answer'] }),
  )

  const gameServer = createGameServer(clientDir, decksDir)
  const port = await listen(gameServer, 0)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const client = track(socket)

  try {
    await until(client, 'connected')
    assert.deepEqual(await client.next(), { type: 'decks', decks: [] })
    assert.deepEqual(await client.next(), { type: 'error', message: UNDERSCORE_MESSAGE, cards: [missing] })
  } finally {
    socket.close()
    await closeGameServer(gameServer)
  }
})

test('an empty room closes after its grace period', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const gameServer = createGameServer(clientDir, sampleDecksDir, 40)
  const port = await listen(gameServer, 0)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const client = track(socket)

  try {
    await until(client, 'connected')
    await until(client, 'decks')
    client.send({ type: 'create_room', nickname: 'Alex' })
    const created = await until(client, 'room')
    const code = typeof created.code === 'string' ? created.code : ''
    await new Promise((resolve) => {
      socket.once('close', resolve)
      socket.close()
    })
    await new Promise((resolve) => setTimeout(resolve, 80))

    const lateSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const late = track(lateSocket)
    await until(late, 'connected')
    await until(late, 'decks')
    late.send({ type: 'join_room', code, nickname: 'Sam' })
    assert.deepEqual(await until(late, 'error'), { type: 'error', message: `No room with code ${code}.` })
    lateSocket.close()
  } finally {
    socket.close()
    await closeGameServer(gameServer)
  }
})

test('the host can set a score limit and upload a deck', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const gameServer = createGameServer(clientDir, sampleDecksDir)
  const port = await listen(gameServer, 0)
  const url = `ws://127.0.0.1:${port}/ws`
  const hostSocket = new WebSocket(url)
  const guestSocket = new WebSocket(url)
  const host = track(hostSocket)
  const guest = track(guestSocket)

  try {
    await until(host, 'connected')
    await until(guest, 'connected')
    await until(host, 'decks')
    await until(guest, 'decks')

    host.send({ type: 'create_room', nickname: 'Alex' })
    const created = await until(host, 'room')
    const code = typeof created.code === 'string' ? created.code : ''
    assert.equal(created.scoreLimit, 7)

    host.send({ type: 'set_score_limit', scoreLimit: 5 })
    const scored = await until(host, 'room')
    assert.equal(scored.scoreLimit, 5)

    const missing = "Why can't I sleep at night?"
    host.send({ type: 'upload_deck', deck: { name: 'Broken', black: [missing], white: ['an answer'] } })
    assert.deepEqual(await until(host, 'error'), { type: 'error', message: UNDERSCORE_MESSAGE, cards: [missing] })

    host.send({
      type: 'upload_deck',
      deck: { name: 'Custom', black: ['Bring me _.'], white: ['a polite seagull'] },
    })
    const uploaded = await until(host, 'room')
    assert.equal(Array.isArray(uploaded.customDecks) && uploaded.customDecks.length, 1)
    const custom = Array.isArray(uploaded.customDecks) ? uploaded.customDecks[0] : null
    assert.equal(isRecord(custom) && custom.name, 'Custom')

    guest.send({ type: 'join_room', code, nickname: 'Sam' })
    const guestRoom = await until(guest, 'room')
    assert.equal(guestRoom.scoreLimit, 5)
    assert.equal(Array.isArray(guestRoom.customDecks) && guestRoom.customDecks.length, 1)

    guest.send({
      type: 'upload_deck',
      deck: { name: 'Nope', black: ['Not _ yours.'], white: ['nope'] },
    })
    const denied = await until(guest, 'error')
    assert.equal(denied.message, 'Only the host can upload a deck.')
  } finally {
    hostSocket.close()
    guestSocket.close()
    await closeGameServer(gameServer)
  }
})

test('a round awards a point and the score limit returns the room to the lobby', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const gameServer = createGameServer(clientDir, sampleDecksDir)
  const port = await listen(gameServer, 0)
  const url = `ws://127.0.0.1:${port}/ws`
  const sockets = [new WebSocket(url), new WebSocket(url), new WebSocket(url)]
  const clients = sockets.map(track)
  const host = clients[0]
  const others = clients.slice(1)
  if (!host) throw new Error('missing host')

  try {
    const ids: string[] = []
    for (const client of clients) {
      const connected = await until(client, 'connected')
      ids.push(typeof connected.playerId === 'string' ? connected.playerId : '')
      await until(client, 'decks')
    }

    host.send({ type: 'create_room', nickname: 'Alex' })
    const created = await until(host, 'room')
    const code = typeof created.code === 'string' ? created.code : ''
    others[0]?.send({ type: 'join_room', code, nickname: 'Sam' })
    others[1]?.send({ type: 'join_room', code, nickname: 'Jo' })
    await until(host, 'room')
    await until(others[0] as ReturnType<typeof track>, 'room')
    await until(others[1] as ReturnType<typeof track>, 'room')

    host.send({ type: 'select_deck', deckId: 'sample' })
    host.send({ type: 'set_score_limit', scoreLimit: 1 })
    host.send({ type: 'start_game' })

    const views = []
    for (const client of clients) views.push(await until(client, 'game'))
    const hostView = views[0]
    assert.equal(hostView?.tzarId, ids[0])
    assert.equal(hostView?.phase, 'picking')
    assert.equal(hostView?.submissions, null)

    for (const [index, client] of clients.entries()) {
      const view = views[index]
      if (!view || view.tzarId === ids[index]) continue
      const hand = isRecord(view.you) && Array.isArray(view.you.hand) ? view.you.hand : []
      const pick = isRecord(view.black) && typeof view.black.pick === 'number' ? view.black.pick : 1
      const cardIds = hand.slice(0, pick).map((card) => (isRecord(card) && typeof card.id === 'string' ? card.id : ''))
      client.send({ type: 'submit_cards', cardIds })
    }

    let judging = await until(host, 'game')
    if (judging.phase !== 'judging') judging = await until(host, 'game')
    assert.equal(judging.phase, 'judging')
    const submission = Array.isArray(judging.submissions) ? judging.submissions[0] : null
    const submissionId = isRecord(submission) && typeof submission.id === 'string' ? submission.id : ''
    host.send({ type: 'highlight_winner', submissionId })
    host.send({ type: 'confirm_winner' })
    host.send({ type: 'next_turn' })

    const notice = await until(host, 'notice')
    assert.match(String(notice.message), /reached 1 and wins/)
    const lobby = await until(host, 'room')
    assert.equal(lobby.code, code)
    assert.equal(lobby.deckId, 'sample')
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})
