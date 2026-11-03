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
    nextWithin(ms: number): Promise<unknown | undefined> {
      const queued = messages.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((resolve) => {
        let settled = false
        const waiter = (message: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(message)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          const index = waiters.indexOf(waiter)
          if (index !== -1) waiters.splice(index, 1)
          resolve(undefined)
        }, ms)
        waiters.push(waiter)
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
  const gameServer = createGameServer(clientDir, sampleDecksDir, 40, 30)
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
    await new Promise((resolve) => setTimeout(resolve, 200))

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
    assert.equal(isRecord(custom) && custom.blackCount, 1)
    assert.equal(isRecord(custom) && custom.whiteCount, 1)

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

test('start rejects a short selection and deals the combined decks', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const gameServer = createGameServer(clientDir, sampleDecksDir)
  const port = await listen(gameServer, 0)
  const url = `ws://127.0.0.1:${port}/ws`
  const sockets = [new WebSocket(url), new WebSocket(url), new WebSocket(url)]
  const clients = sockets.map(track)
  const host = clients[0]
  if (!host) throw new Error('missing host')

  function lines(prefix: string, count: number, blank: boolean): string[] {
    return Array.from({ length: count }, (_, index) => (blank ? `${prefix} ${index} _.` : `${prefix} ${index}`))
  }

  function customId(room: Record<string, unknown>, name: string): string {
    if (!Array.isArray(room.customDecks)) return ''
    const match = room.customDecks.find((deck) => isRecord(deck) && deck.name === name)
    return isRecord(match) && typeof match.id === 'string' ? match.id : ''
  }

  try {
    for (const client of clients) {
      await until(client, 'connected')
      await until(client, 'decks')
    }

    host.send({ type: 'create_room', nickname: 'Alex' })
    let room = await until(host, 'room')
    const code = typeof room.code === 'string' ? room.code : ''
    clients[1]?.send({ type: 'join_room', code, nickname: 'Sam' })
    clients[2]?.send({ type: 'join_room', code, nickname: 'Jo' })
    while (!Array.isArray(room.playerIds) || room.playerIds.length < 3) room = await until(host, 'room')

    host.send({ type: 'start_game' })
    assert.equal((await until(host, 'error')).message, 'Choose a deck before starting.')

    host.send({
      type: 'upload_deck',
      deck: { name: 'Half A', black: lines('A', 3, true), white: lines('a', 15, false) },
    })
    const first = await until(host, 'room')
    const halfA = customId(first, 'Half A')
    host.send({
      type: 'upload_deck',
      deck: { name: 'Half B', black: lines('B', 3, true), white: lines('b', 15, false) },
    })
    const second = await until(host, 'room')
    const halfB = customId(second, 'Half B')
    assert.equal(halfA.startsWith('custom:'), true)
    assert.equal(halfB.startsWith('custom:'), true)

    host.send({ type: 'select_decks', deckIds: [halfA] })
    assert.deepEqual((await until(host, 'room')).deckIds, [halfA])
    host.send({ type: 'start_game' })
    assert.equal((await until(host, 'error')).message, 'Please add more cards to the deck.')

    host.send({ type: 'select_decks', deckIds: [halfA, halfB] })
    assert.deepEqual((await until(host, 'room')).deckIds, [halfA, halfB])
    host.send({ type: 'start_game' })
    const started = await until(host, 'game')
    const hand = isRecord(started.you) && Array.isArray(started.you.hand) ? started.you.hand : []
    assert.equal(hand.length, 10)
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})

test('the host can return a game to the lobby', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const gameServer = createGameServer(clientDir, sampleDecksDir)
  const port = await listen(gameServer, 0)
  const url = `ws://127.0.0.1:${port}/ws`
  const sockets = [new WebSocket(url), new WebSocket(url), new WebSocket(url)]
  const clients = sockets.map(track)
  const host = clients[0]
  const guest = clients[1]
  if (!host || !guest) throw new Error('missing player')

  try {
    for (const client of clients) {
      await until(client, 'connected')
      await until(client, 'decks')
    }

    host.send({ type: 'create_room', nickname: 'Alex' })
    let room = await until(host, 'room')
    const code = typeof room.code === 'string' ? room.code : ''
    guest.send({ type: 'join_room', code, nickname: 'Sam' })
    clients[2]?.send({ type: 'join_room', code, nickname: 'Jo' })
    while (!Array.isArray(room.playerIds) || room.playerIds.length < 3) room = await until(host, 'room')

    host.send({ type: 'select_decks', deckIds: ['sample'] })
    await until(host, 'room')
    host.send({ type: 'start_game' })
    await until(host, 'game')

    guest.send({ type: 'return_to_lobby' })
    assert.equal((await until(guest, 'error')).message, 'Only the host can return to the lobby.')

    host.send({ type: 'return_to_lobby' })
    assert.equal((await until(host, 'notice')).message, 'The host returned the room to the lobby.')
    const lobby = await until(host, 'room')
    assert.equal(lobby.code, code)
    assert.deepEqual(lobby.deckIds, ['sample'])
    assert.equal(Array.isArray(lobby.playerIds) && lobby.playerIds.length, 3)
    assert.equal((await until(guest, 'notice')).message, 'The host returned the room to the lobby.')

    host.send({ type: 'start_game' })
    assert.equal((await until(host, 'game')).phase, 'picking')
  } finally {
    for (const socket of sockets) socket.close()
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

    host.send({ type: 'select_decks', deckIds: ['sample'] })
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
    host.send({ type: 'confirm_winner', submissionId })
    host.send({ type: 'next_turn' })

    const notice = await until(host, 'notice')
    assert.match(String(notice.message), /reached 1 and wins/)
    const lobby = await until(host, 'room')
    assert.equal(lobby.code, code)
    assert.deepEqual(lobby.deckIds, ['sample'])
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})

function handOf(view: Record<string, unknown>): Array<{ id: string; text: string }> {
  const you = view.you
  if (!isRecord(you) || !Array.isArray(you.hand)) return []
  return you.hand.map((card) => ({
    id: isRecord(card) && typeof card.id === 'string' ? card.id : '',
    text: isRecord(card) && typeof card.text === 'string' ? card.text : '',
  }))
}

async function startSampleGame(reconnectMs: number) {
  const clientDir = mkdtempSync(join(tmpdir(), 'cah-serve-'))
  writeFileSync(join(clientDir, 'index.html'), '<h1>Cards Against Humanity</h1>')
  const gameServer = createGameServer(clientDir, sampleDecksDir, 15_000, reconnectMs)
  const sockets: WebSocket[] = []
  try {
    const port = await listen(gameServer, 0)
    const url = `ws://127.0.0.1:${port}/ws`
    const opened = [new WebSocket(url), new WebSocket(url), new WebSocket(url)]
    sockets.push(...opened)
    const clients = opened.map(track)
    const ids: string[] = []
    for (const client of clients) {
      const connected = await until(client, 'connected')
      ids.push(typeof connected.playerId === 'string' ? connected.playerId : '')
      await until(client, 'decks')
    }

    const host = clients[0]
    const guest = clients[1]
    const other = clients[2]
    if (!host || !guest || !other) throw new Error('missing player')
    host.send({ type: 'create_room', nickname: 'Alex' })
    let room = await until(host, 'room')
    const code = typeof room.code === 'string' ? room.code : ''
    guest.send({ type: 'join_room', code, nickname: 'Sam' })
    other.send({ type: 'join_room', code, nickname: 'Jo' })
    while (!Array.isArray(room.playerIds) || room.playerIds.length < 3) room = await until(host, 'room')
    await until(guest, 'room')
    await until(other, 'room')

    host.send({ type: 'select_decks', deckIds: ['sample'] })
    host.send({ type: 'start_game' })
    const views = []
    for (const client of clients) views.push(await until(client, 'game'))
    return { gameServer, port, sockets, clients, ids, code, views }
  } catch (error) {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
    throw error
  }
}

test('a refresh resumes the same hand and turn', async () => {
  const started = await startSampleGame(1_000)
  const { gameServer, port, sockets, clients, ids, code, views } = started
  const host = clients[0]
  const guestView = views[1]
  try {
    const guestSocket = sockets[1]
    if (!host || !guestView || !guestSocket) throw new Error('missing player')
    const hand = handOf(guestView)
    assert.equal(hand.length, 10)
    assert.equal(guestView.phase, 'picking')

    await new Promise((resolve) => {
      guestSocket.once('close', resolve)
      guestSocket.close()
    })
    assert.equal(await host.nextWithin(80), undefined)

    const resumedSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(resumedSocket)
    const resumed = track(resumedSocket)
    const temporary = await until(resumed, 'connected')
    assert.notEqual(temporary.playerId, ids[1])
    await until(resumed, 'decks')
    resumed.send({ type: 'resume', playerId: ids[1], code, nickname: 'Sam' })
    assert.equal((await until(resumed, 'connected')).playerId, ids[1])
    const game = await until(resumed, 'game')
    assert.equal(game.phase, 'picking')
    assert.equal(game.tzarId, ids[0])
    assert.deepEqual(handOf(game), hand)

    const hostRoom = await until(host, 'room')
    assert.deepEqual(hostRoom.playerIds, ids)
    const hostGame = await until(host, 'game')
    assert.equal(hostGame.phase, 'picking')
    assert.equal(hostGame.tzarId, ids[0])
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})

test('a dropped seat leaves after the reconnect window', async () => {
  const started = await startSampleGame(40)
  const { gameServer, port, sockets, clients, ids, code } = started
  const host = clients[0]
  const guestSocket = sockets[1]
  try {
    if (!host || !guestSocket) throw new Error('missing player')
    await new Promise((resolve) => {
      guestSocket.once('close', resolve)
      guestSocket.close()
    })

    assert.equal((await until(host, 'notice')).message, 'Not enough players to continue.')
    const lobby = await until(host, 'room')
    assert.deepEqual(lobby.playerIds, [ids[0], ids[2]])

    const lateSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(lateSocket)
    const late = track(lateSocket)
    await until(late, 'connected')
    await until(late, 'decks')
    late.send({ type: 'resume', playerId: ids[1], code, nickname: 'Sam' })
    assert.deepEqual(await until(late, 'error'), { type: 'error', message: 'Could not rejoin that room.' })
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})

test('leave_room removes the player before the reconnect window', async () => {
  const started = await startSampleGame(5_000)
  const { gameServer, sockets, clients, ids } = started
  const host = clients[0]
  const guest = clients[1]
  try {
    if (!host || !guest) throw new Error('missing player')
    guest.send({ type: 'leave_room' })
    const noticed = await host.nextWithin(200)
    assert.equal(isRecord(noticed) && noticed.type, 'notice')
    assert.equal(isRecord(noticed) && noticed.message, 'Not enough players to continue.')
    const lobby = await until(host, 'room')
    assert.deepEqual(lobby.playerIds, [ids[0], ids[2]])
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})

test('resume rejects an unknown seat and join stays closed during a game', async () => {
  const started = await startSampleGame(5_000)
  const { gameServer, port, sockets, clients, ids, code, views } = started
  const guest = clients[1]
  const guestView = views[1]
  try {
    if (!guest || !guestView) throw new Error('missing player')
    const outsiderSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(outsiderSocket)
    const outsider = track(outsiderSocket)
    await until(outsider, 'connected')
    await until(outsider, 'decks')

    outsider.send({ type: 'resume', playerId: 'missing-player', code, nickname: 'Pat' })
    assert.deepEqual(await until(outsider, 'error'), { type: 'error', message: 'Could not rejoin that room.' })

    outsider.send({ type: 'resume', playerId: ids[1], code: 'ZZZZ', nickname: 'Sam' })
    assert.deepEqual(await until(outsider, 'error'), { type: 'error', message: 'Could not rejoin that room.' })

    outsider.send({ type: 'join_room', code, nickname: 'Pat' })
    assert.deepEqual(await until(outsider, 'error'), { type: 'error', message: 'The game has already started.' })

    const hand = handOf(guestView)
    const pick = isRecord(guestView.black) && typeof guestView.black.pick === 'number' ? guestView.black.pick : 1
    guest.send({ type: 'submit_cards', cardIds: hand.slice(0, pick).map((card) => card.id) })
    const updated = await until(guest, 'game')
    assert.equal(updated.submitted, true)
    assert.deepEqual(
      handOf(updated),
      hand.filter((card) => !hand.slice(0, pick).some((played) => played.id === card.id)),
    )
  } finally {
    for (const socket of sockets) socket.close()
    await closeGameServer(gameServer)
  }
})
