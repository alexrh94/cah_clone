import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { listDecks, loadDeck, MAX_DECK_BYTES, UNDERSCORE_MESSAGE, validateDeck, type Deck, type DeckList } from './deck.js'
import { confirmWinner, createGame, highlightWinner, nextTurn, removePlayer, submitCards, viewFor, type GameState } from './game.js'
import { generateUniqueRoomCode } from './roomCode.js'
import { createRoomStore, type PublicRoom, type RoomChange } from './rooms.js'
import { contentTypeFor, resolveClientFile } from './static.js'

const EMPTY_ROOM_MS = 15_000
const NICKNAME_LIMIT = 24

export interface GameServer {
  httpServer: http.Server
  wss: WebSocketServer
}

export function parsePort(value: string | undefined, fallback = 3000): number {
  if (value === undefined || value.trim() === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`)
  }
  return port
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ClientMessage =
  | { type: 'create_room'; nickname: string }
  | { type: 'join_room'; code: string; nickname: string }
  | { type: 'select_deck'; deckId: string }
  | { type: 'set_score_limit'; scoreLimit: number }
  | { type: 'upload_deck'; deck: unknown }
  | { type: 'start_game' }
  | { type: 'submit_cards'; cardIds: string[] }
  | { type: 'highlight_winner'; submissionId: string }
  | { type: 'confirm_winner' }
  | { type: 'next_turn' }
  | { type: 'leave_room' }

export function cleanNickname(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NICKNAME_LIMIT)
}

function readNickname(value: unknown): string {
  return typeof value === 'string' ? cleanNickname(value) : ''
}

function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'create_room') return { type: 'create_room', nickname: readNickname(value.nickname) }
  if (value.type === 'leave_room') return { type: 'leave_room' }
  if (value.type === 'start_game') return { type: 'start_game' }
  if (value.type === 'join_room' && typeof value.code === 'string') {
    return { type: 'join_room', code: value.code, nickname: readNickname(value.nickname) }
  }
  if (value.type === 'select_deck' && typeof value.deckId === 'string') {
    return { type: 'select_deck', deckId: value.deckId }
  }
  if (value.type === 'set_score_limit' && typeof value.scoreLimit === 'number') {
    return { type: 'set_score_limit', scoreLimit: value.scoreLimit }
  }
  if (value.type === 'upload_deck') return { type: 'upload_deck', deck: value.deck }
  if (value.type === 'submit_cards' && Array.isArray(value.cardIds) && value.cardIds.every((id) => typeof id === 'string')) {
    return { type: 'submit_cards', cardIds: value.cardIds }
  }
  if (value.type === 'highlight_winner' && typeof value.submissionId === 'string') {
    return { type: 'highlight_winner', submissionId: value.submissionId }
  }
  if (value.type === 'confirm_winner') return { type: 'confirm_winner' }
  if (value.type === 'next_turn') return { type: 'next_turn' }
  return null
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

export function createGameServer(
  clientDir: string,
  decksDir: string,
  emptyRoomMs = EMPTY_ROOM_MS,
  random: () => number = Math.random,
): GameServer {
  const rooms = createRoomStore()
  const games = new Map<string, GameState>()
  const sockets = new Map<string, WebSocket>()
  const nicknames = new Map<string, string>()
  const expirations = new Map<string, NodeJS.Timeout>()

  const httpServer = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    const resolved = resolveClientFile(clientDir, req.url ?? '/')
    if (!resolved.ok) {
      res.writeHead(resolved.status)
      res.end(resolved.status === 400 ? 'Bad request' : 'Not found')
      return
    }

    res.writeHead(200, { 'Content-Type': contentTypeFor(resolved.filePath) })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(resolved.filePath).pipe(res)
  })

  httpServer.on('close', () => {
    for (const timer of expirations.values()) clearTimeout(timer)
    expirations.clear()
  })

  function send(socket: WebSocket, message: object): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function sendError(socket: WebSocket, message: string, cards?: string[]): void {
    if (cards && cards.length > 0) send(socket, { type: 'error', message, cards })
    else send(socket, { type: 'error', message })
  }

  function displayName(playerId: string): string {
    const nickname = nicknames.get(playerId) ?? ''
    return nickname === '' ? 'A player' : nickname
  }

  function notify(room: PublicRoom, message: string): void {
    for (const playerId of room.playerIds) {
      const socket = sockets.get(playerId)
      if (socket) send(socket, { type: 'notice', message })
    }
  }

  function publish(room: PublicRoom | null): void {
    if (!room) return
    cancelExpiry(room.code)
    const message = {
      type: 'room',
      code: room.code,
      deckId: room.deckId,
      scoreLimit: room.scoreLimit,
      hostId: room.hostId,
      playerIds: room.playerIds,
      players: room.playerIds.map((id) => ({ id, nickname: nicknames.get(id) ?? '' })),
      customDecks: room.customDecks,
    }
    for (const playerId of room.playerIds) {
      const socket = sockets.get(playerId)
      if (socket) send(socket, message)
    }

    const game = games.get(room.code)
    if (!game) return
    for (const playerId of room.playerIds) {
      if (!game.order.includes(playerId)) continue
      const socket = sockets.get(playerId)
      if (socket) send(socket, { type: 'game', ...viewFor(game, playerId) })
    }
  }

  function cancelExpiry(code: string): void {
    const timer = expirations.get(code)
    if (!timer) return
    clearTimeout(timer)
    expirations.delete(code)
  }

  function scheduleExpiry(code: string): void {
    cancelExpiry(code)
    const timer = setTimeout(() => {
      expirations.delete(code)
      rooms.drop(code)
    }, emptyRoomMs)
    timer.unref()
    expirations.set(code, timer)
  }

  function applyMembership(change: RoomChange | null): void {
    if (!change?.room) return
    if (change.room.playerIds.length === 0) {
      games.delete(change.code)
      scheduleExpiry(change.code)
      return
    }

    const game = games.get(change.code)
    if (game) {
      for (const playerId of [...game.order]) {
        if (change.room.playerIds.includes(playerId)) continue
        const removed = removePlayer(game, playerId)
        if (removed.abort) {
          games.delete(change.code)
          notify(change.room, 'Not enough players to continue.')
          break
        }
      }
    }
    cancelExpiry(change.code)
    publish(change.room)
  }

  function readBuiltInDecks(): DeckList | null {
    try {
      return listDecks(decksDir)
    } catch {
      return null
    }
  }

  function knownDeckIds(code: string): Set<string> | null {
    const listed = readBuiltInDecks()
    if (!listed) return null
    const ids = new Set(listed.decks.map((deck) => deck.id))
    const room = rooms.get(code)
    for (const deck of room?.customDecks ?? []) ids.add(deck.id)
    return ids
  }

  function resolveDeck(code: string, deckId: string): { ok: true; deck: Deck } | { ok: false; error: string } {
    if (deckId.startsWith('custom:')) {
      const custom = rooms.getCustomDeck(code, deckId)
      return custom ? { ok: true, deck: custom } : { ok: false, error: 'That deck is not available.' }
    }
    if (!/^[A-Za-z0-9_-]+$/.test(deckId)) return { ok: false, error: 'That deck is not available.' }

    const listed = readBuiltInDecks()
    if (!listed) return { ok: false, error: 'The deck list could not be read.' }
    if (!listed.decks.some((deck) => deck.id === deckId)) return { ok: false, error: 'That deck is not available.' }

    try {
      return { ok: true, deck: loadDeck(join(decksDir, `${deckId}.json`)) }
    } catch {
      return { ok: false, error: 'That deck is not available.' }
    }
  }

  function sendDeckList(socket: WebSocket): void {
    const listed = readBuiltInDecks()
    if (!listed) {
      sendError(socket, 'The deck list could not be read.')
      send(socket, { type: 'decks', decks: [] })
      return
    }
    send(socket, { type: 'decks', decks: listed.decks })
    if (listed.cards.length > 0) sendError(socket, UNDERSCORE_MESSAGE, listed.cards)
    for (const message of listed.errors) sendError(socket, message)
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wss.on('connection', (socket: WebSocket) => {
    const playerId = randomUUID()
    sockets.set(playerId, socket)
    send(socket, { type: 'connected', playerId })
    sendDeckList(socket)

    socket.on('message', (data) => {
      const text = rawDataToString(data)
      if (text.length > MAX_DECK_BYTES) {
        sendError(socket, 'That deck is too large.')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        sendError(socket, 'Unreadable message.')
        return
      }

      const message = parseClientMessage(parsed)
      if (!message) {
        sendError(socket, 'Unreadable message.')
        return
      }

      if (message.type === 'create_room') {
        const code = generateUniqueRoomCode((candidate) => rooms.has(candidate), random)
        if (!code) {
          sendError(socket, 'Could not create a room. Try again.')
          return
        }
        const result = rooms.create(playerId, code)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        nicknames.set(playerId, message.nickname)
        applyMembership(result.previous)
        publish(result.room)
        return
      }

      if (message.type === 'join_room') {
        const normalized = message.code.trim().toUpperCase()
        if (games.has(normalized)) {
          sendError(socket, 'The game has already started.')
          return
        }
        const result = rooms.join(playerId, message.code)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        nicknames.set(playerId, message.nickname)
        applyMembership(result.previous)
        publish(result.room)
        return
      }

      if (message.type === 'select_deck' || message.type === 'set_score_limit' || message.type === 'upload_deck') {
        const currentCode = rooms.codeFor(playerId)
        if (currentCode && games.has(currentCode)) {
          sendError(socket, 'The game has already started.')
          return
        }
      }

      if (message.type === 'select_deck') {
        const code = rooms.codeFor(playerId)
        if (!code) {
          sendError(socket, 'Join a room before choosing a deck.')
          return
        }
        const known = knownDeckIds(code)
        if (!known) {
          sendError(socket, 'The deck list could not be read.')
          return
        }
        const result = rooms.selectDeck(playerId, message.deckId, known)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        publish(result.room)
        return
      }

      if (message.type === 'set_score_limit') {
        const result = rooms.setScoreLimit(playerId, message.scoreLimit)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        publish(result.room)
        return
      }

      if (message.type === 'upload_deck') {
        const result = validateDeck(message.deck)
        if (!result.ok) {
          if (result.cards.length > 0) sendError(socket, UNDERSCORE_MESSAGE, result.cards)
          else sendError(socket, result.errors.join(' '))
          return
        }
        const added = rooms.addCustomDeck(playerId, `custom:${randomUUID()}`, result.deck)
        if (!added.ok) {
          sendError(socket, added.error)
          return
        }
        publish(added.room)
        return
      }

      if (message.type === 'start_game') {
        const code = rooms.codeFor(playerId)
        const current = code ? rooms.get(code) : undefined
        if (!current || !code) {
          sendError(socket, 'Join a room before starting a game.')
          return
        }
        if (current.hostId !== playerId) {
          sendError(socket, 'Only the host can start the game.')
          return
        }
        if (games.has(code)) {
          sendError(socket, 'The game has already started.')
          return
        }
        if (current.playerIds.length < 3) {
          sendError(socket, 'At least three players are needed to start.')
          return
        }
        if (!current.deckId) {
          sendError(socket, 'Choose a deck before starting.')
          return
        }
        const loaded = resolveDeck(code, current.deckId)
        if (!loaded.ok) {
          sendError(socket, loaded.error)
          return
        }
        const created = createGame(current.playerIds, current.hostId, loaded.deck, current.scoreLimit, random)
        if (!created.ok) {
          sendError(socket, created.error)
          return
        }
        games.set(code, created.game)
        publish(current)
        return
      }

      if (message.type === 'submit_cards') {
        const code = rooms.codeFor(playerId)
        const game = code ? games.get(code) : undefined
        if (!game || !code) {
          sendError(socket, 'The game has not started.')
          return
        }
        const result = submitCards(game, playerId, message.cardIds)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        const room = rooms.get(code)
        if (room) publish(room)
        return
      }

      if (message.type === 'highlight_winner' || message.type === 'confirm_winner') {
        const code = rooms.codeFor(playerId)
        const game = code ? games.get(code) : undefined
        if (!game || !code) {
          sendError(socket, 'The game has not started.')
          return
        }
        const result =
          message.type === 'highlight_winner'
            ? highlightWinner(game, playerId, message.submissionId)
            : confirmWinner(game, playerId)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        const room = rooms.get(code)
        if (room) publish(room)
        return
      }

      if (message.type === 'next_turn') {
        const code = rooms.codeFor(playerId)
        const game = code ? games.get(code) : undefined
        if (!game || !code) {
          sendError(socket, 'The game has not started.')
          return
        }
        const result = nextTurn(game, playerId)
        if (!result.ok) {
          sendError(socket, result.error)
          return
        }
        const room = rooms.get(code)
        if (!room) return
        if (result.finished) {
          notify(room, `${displayName(result.winnerId)} reached ${game.scoreLimit} and wins.`)
          games.delete(code)
        }
        publish(room)
        return
      }

      applyMembership(rooms.leave(playerId))
    })

    socket.on('close', () => {
      sockets.delete(playerId)
      nicknames.delete(playerId)
      applyMembership(rooms.leave(playerId))
    })
  })

  return { httpServer, wss }
}

export function listen(gameServer: GameServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      gameServer.httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      gameServer.httpServer.off('error', onError)
      const address = gameServer.httpServer.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    gameServer.httpServer.once('error', onError)
    gameServer.httpServer.once('listening', onListening)
    gameServer.httpServer.listen(port)
  })
}

export function closeGameServer(gameServer: GameServer): Promise<void> {
  for (const client of gameServer.wss.clients) client.close()
  return new Promise((resolve, reject) => {
    gameServer.wss.close((websocketError) => {
      gameServer.httpServer.close((httpError) => {
        const error = websocketError ?? httpError
        if (error) reject(error)
        else resolve()
      })
    })
  })
}
