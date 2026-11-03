import type { Deck } from './deck.js'
import { isValidRoomCode } from './roomCode.js'

export const DEFAULT_SCORE_LIMIT = 7
export const MIN_SCORE_LIMIT = 1
export const MAX_SCORE_LIMIT = 20

export interface CustomDeckSummary {
  id: string
  name: string
  blackCount: number
  whiteCount: number
}

export interface PublicRoom {
  code: string
  hostId: string
  deckIds: string[]
  scoreLimit: number
  playerIds: string[]
  customDecks: CustomDeckSummary[]
}

export interface RoomChange {
  code: string
  room: PublicRoom | null
}

export type RoomResult =
  | { ok: true; room: PublicRoom; previous: RoomChange | null }
  | { ok: false; error: string }

export interface RoomStore {
  create(hostId: string, code: string): RoomResult
  join(playerId: string, code: string): RoomResult
  selectDecks(playerId: string, deckIds: readonly string[], knownDeckIds: ReadonlySet<string>): RoomResult
  setScoreLimit(playerId: string, scoreLimit: number): RoomResult
  addCustomDeck(playerId: string, id: string, deck: Deck): RoomResult
  getCustomDeck(code: string, id: string): Deck | undefined
  leave(playerId: string): RoomChange | null
  drop(code: string): boolean
  get(code: string): PublicRoom | undefined
  has(code: string): boolean
  codeFor(playerId: string): string | undefined
}

interface InternalRoom {
  code: string
  hostId: string
  deckIds: string[]
  scoreLimit: number
  playerIds: string[]
  customDecks: Map<string, Deck>
}

function customSummaries(room: InternalRoom): CustomDeckSummary[] {
  return [...room.customDecks.entries()]
    .map(([id, deck]) => ({ id, name: deck.name, blackCount: deck.black.length, whiteCount: deck.white.length }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function snapshot(room: InternalRoom): PublicRoom {
  return {
    code: room.code,
    hostId: room.hostId,
    deckIds: [...room.deckIds],
    scoreLimit: room.scoreLimit,
    playerIds: [...room.playerIds],
    customDecks: customSummaries(room),
  }
}

function copyDeck(deck: Deck): Deck {
  return {
    name: deck.name,
    black: deck.black.map((card) => ({ text: card.text, pick: card.pick })),
    white: [...deck.white],
  }
}

export function createRoomStore(): RoomStore {
  const rooms = new Map<string, InternalRoom>()
  const membership = new Map<string, string>()

  function removePlayer(playerId: string): RoomChange | null {
    const code = membership.get(playerId)
    if (!code) return null

    membership.delete(playerId)
    const room = rooms.get(code)
    if (!room) return { code, room: null }

    room.playerIds = room.playerIds.filter((id) => id !== playerId)
    if (room.playerIds.length === 0) {
      room.hostId = ''
      return { code, room: snapshot(room) }
    }

    if (room.hostId === playerId) {
      room.hostId = room.playerIds[0] ?? room.hostId
    }

    return { code, room: snapshot(room) }
  }

  function roomFor(playerId: string): InternalRoom | undefined {
    const code = membership.get(playerId)
    return code ? rooms.get(code) : undefined
  }

  return {
    has(code) {
      return rooms.has(code)
    },

    get(code) {
      const room = rooms.get(code)
      return room ? snapshot(room) : undefined
    },

    create(hostId, code) {
      if (!isValidRoomCode(code)) {
        return { ok: false, error: 'Room codes are four letters, like ABCD.' }
      }
      if (rooms.has(code)) {
        return { ok: false, error: 'That room code is already in use.' }
      }

      const previous = removePlayer(hostId)
      const room: InternalRoom = {
        code,
        hostId,
        deckIds: [],
        scoreLimit: DEFAULT_SCORE_LIMIT,
        playerIds: [hostId],
        customDecks: new Map(),
      }
      rooms.set(code, room)
      membership.set(hostId, code)
      return { ok: true, room: snapshot(room), previous }
    },

    join(playerId, code) {
      const normalized = code.trim().toUpperCase()
      if (!isValidRoomCode(normalized)) {
        return { ok: false, error: 'Room codes are four letters, like ABCD.' }
      }

      const room = rooms.get(normalized)
      if (!room) {
        return { ok: false, error: `No room with code ${normalized}.` }
      }

      if (membership.get(playerId) === normalized) {
        return { ok: true, room: snapshot(room), previous: null }
      }

      const previous = removePlayer(playerId)
      if (room.playerIds.length === 0) room.hostId = playerId
      room.playerIds.push(playerId)
      membership.set(playerId, normalized)
      return { ok: true, room: snapshot(room), previous }
    },

    selectDecks(playerId, deckIds, knownDeckIds) {
      const room = roomFor(playerId)
      if (!room) {
        return { ok: false, error: 'Join a room before choosing a deck.' }
      }
      if (room.hostId !== playerId) {
        return { ok: false, error: 'Only the host can choose the deck.' }
      }

      const unique: string[] = []
      for (const deckId of deckIds) {
        if (unique.includes(deckId)) continue
        if (!knownDeckIds.has(deckId)) {
          return { ok: false, error: 'That deck is not available.' }
        }
        unique.push(deckId)
      }

      room.deckIds = unique
      return { ok: true, room: snapshot(room), previous: null }
    },

    setScoreLimit(playerId, scoreLimit) {
      const room = roomFor(playerId)
      if (!room) {
        return { ok: false, error: 'Join a room before setting the score limit.' }
      }
      if (room.hostId !== playerId) {
        return { ok: false, error: 'Only the host can set the score limit.' }
      }
      if (!Number.isInteger(scoreLimit) || scoreLimit < MIN_SCORE_LIMIT || scoreLimit > MAX_SCORE_LIMIT) {
        return { ok: false, error: 'Score limit must be a whole number from 1 to 20.' }
      }

      room.scoreLimit = scoreLimit
      return { ok: true, room: snapshot(room), previous: null }
    },

    addCustomDeck(playerId, id, deck) {
      const room = roomFor(playerId)
      if (!room) {
        return { ok: false, error: 'Join a room before uploading a deck.' }
      }
      if (room.hostId !== playerId) {
        return { ok: false, error: 'Only the host can upload a deck.' }
      }
      if (!id.startsWith('custom:')) {
        return { ok: false, error: 'That deck is not available.' }
      }

      room.customDecks.set(id, copyDeck(deck))
      return { ok: true, room: snapshot(room), previous: null }
    },

    getCustomDeck(code, id) {
      const deck = rooms.get(code)?.customDecks.get(id)
      return deck ? copyDeck(deck) : undefined
    },

    leave(playerId) {
      return removePlayer(playerId)
    },

    drop(code) {
      const room = rooms.get(code)
      if (!room || room.playerIds.length > 0) return false
      rooms.delete(code)
      return true
    },

    codeFor(playerId) {
      return membership.get(playerId)
    },
  }
}
