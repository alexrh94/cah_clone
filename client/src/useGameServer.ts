import { useCallback, useEffect, useRef, useState } from 'react'

export interface DeckChoice {
  id: string
  name: string
  blackCount: number
  whiteCount: number
}

export interface RoomPlayer {
  id: string
  nickname: string
}

export interface RoomState {
  code: string
  deckIds: string[]
  scoreLimit: number
  hostId: string
  players: RoomPlayer[]
  customDecks: DeckChoice[]
}

export interface HandCard {
  id: string
  text: string
}

export interface PublicSubmission {
  id: string
  cards: string[]
}

export interface ScoreSeat {
  id: string
  score: number
}

export interface TableState {
  phase: 'picking' | 'judging' | 'reveal'
  scoreLimit: number
  black: { text: string; pick: number }
  tzarId: string
  scores: ScoreSeat[]
  you: { hand: HandCard[] }
  submitted: boolean
  readyCount: number
  neededCount: number
  submissions: PublicSubmission[] | null
  highlightedId: string | null
  lastWinnerId: string | null
}

export interface DeckIssue {
  message: string
  cards: string[]
}

export type Connection = 'connecting' | 'open' | 'closed'

const NICKNAME_KEY = 'cah-nickname'

export function readNickname(): string {
  try {
    return sessionStorage.getItem(NICKNAME_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeNickname(nickname: string) {
  try {
    sessionStorage.setItem(NICKNAME_KEY, nickname)
  } catch {
    // The nickname still goes to the server for this visit.
  }
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

function roomCodeFromPath(pathname: string): string | null {
  const match = /^\/room\/([A-Za-z]{4})\/?$/.exec(pathname)
  return match?.[1] ? match[1].toUpperCase() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDeckChoice(value: unknown): value is DeckChoice {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isCount(value.blackCount) &&
    isCount(value.whiteCount)
  )
}

function isRoomPlayer(value: unknown): value is RoomPlayer {
  return isRecord(value) && typeof value.id === 'string' && typeof value.nickname === 'string'
}

function isHandCard(value: unknown): value is HandCard {
  return isRecord(value) && typeof value.id === 'string' && typeof value.text === 'string'
}

function isScore(value: unknown): value is ScoreSeat {
  return isRecord(value) && typeof value.id === 'string' && typeof value.score === 'number' && Number.isInteger(value.score)
}

function isSubmission(value: unknown): value is PublicSubmission {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.cards) &&
    value.cards.every((card) => typeof card === 'string') &&
    !('playerId' in value)
  )
}

function readRoom(value: unknown): RoomState | null {
  if (!isRecord(value) || value.type !== 'room') return null
  if (typeof value.code !== 'string' || typeof value.hostId !== 'string') return null
  if (!Array.isArray(value.deckIds) || !value.deckIds.every((deckId) => typeof deckId === 'string')) return null
  if (typeof value.scoreLimit !== 'number' || !Number.isInteger(value.scoreLimit)) return null
  if (!Array.isArray(value.players) || !value.players.every(isRoomPlayer)) return null
  if (!Array.isArray(value.customDecks) || !value.customDecks.every(isDeckChoice)) return null
  return {
    code: value.code,
    deckIds: value.deckIds,
    scoreLimit: value.scoreLimit,
    hostId: value.hostId,
    players: value.players,
    customDecks: value.customDecks,
  }
}

function readTable(value: unknown): TableState | null {
  if (!isRecord(value) || value.type !== 'game') return null
  if (value.phase !== 'picking' && value.phase !== 'judging' && value.phase !== 'reveal') return null
  if (typeof value.scoreLimit !== 'number' || !Number.isInteger(value.scoreLimit)) return null
  if (!isRecord(value.black) || typeof value.black.text !== 'string' || typeof value.black.pick !== 'number') return null
  if (!Number.isInteger(value.black.pick) || value.black.pick < 1) return null
  if (typeof value.tzarId !== 'string') return null
  if (!Array.isArray(value.scores) || !value.scores.every(isScore)) return null
  if (!isRecord(value.you) || !Array.isArray(value.you.hand) || !value.you.hand.every(isHandCard)) return null
  if (typeof value.submitted !== 'boolean') return null
  if (typeof value.readyCount !== 'number' || typeof value.neededCount !== 'number') return null
  if (typeof value.highlightedId !== 'string' && value.highlightedId !== null) return null
  if (typeof value.lastWinnerId !== 'string' && value.lastWinnerId !== null) return null

  let submissions: PublicSubmission[] | null
  if (value.submissions === null) submissions = null
  else if (Array.isArray(value.submissions) && value.submissions.every(isSubmission)) submissions = value.submissions
  else return null

  return {
    phase: value.phase,
    scoreLimit: value.scoreLimit,
    black: { text: value.black.text, pick: value.black.pick },
    tzarId: value.tzarId,
    scores: value.scores,
    you: { hand: value.you.hand.map((card) => ({ id: card.id, text: card.text })) },
    submitted: value.submitted,
    readyCount: value.readyCount,
    neededCount: value.neededCount,
    submissions,
    highlightedId: value.highlightedId,
    lastWinnerId: value.lastWinnerId,
  }
}

function readCards(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((card): card is string => typeof card === 'string')
}

export function useGameServer() {
  const [connection, setConnection] = useState<Connection>('connecting')
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [decks, setDecks] = useState<DeckChoice[]>([])
  const [room, setRoom] = useState<RoomState | null>(null)
  const [table, setTable] = useState<TableState | null>(null)
  const [notice, setNotice] = useState('Connecting to the game server…')
  const [deckIssue, setDeckIssue] = useState<DeckIssue | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const roomRef = useRef<RoomState | null>(null)
  const acceptRoomRef = useRef(true)
  const stickyNoticeRef = useRef(false)

  const rememberRoom = useCallback((next: RoomState | null) => {
    roomRef.current = next
    setRoom(next)
  }, [])

  const send = useCallback((message: object) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice('The game server is not connected.')
      return false
    }
    socket.send(JSON.stringify(message))
    return true
  }, [])

  useEffect(() => {
    const socket = new WebSocket(socketUrl())
    socketRef.current = socket
    let active = true

    socket.addEventListener('open', () => {
      if (!active) return
      setConnection('open')
      const code = roomCodeFromPath(window.location.pathname)
      if (code) {
        acceptRoomRef.current = true
        setNotice(`Joining room ${code}…`)
        socket.send(JSON.stringify({ type: 'join_room', code, nickname: readNickname() }))
        return
      }
      setNotice('Ask the host for a four-letter code, or create a room.')
    })

    socket.addEventListener('message', (event) => {
      if (!active) return
      let message: unknown
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!isRecord(message) || typeof message.type !== 'string') return

      if (message.type === 'connected' && typeof message.playerId === 'string') {
        setPlayerId(message.playerId)
        return
      }

      if (message.type === 'decks' && Array.isArray(message.decks)) {
        setDecks(message.decks.filter(isDeckChoice))
        return
      }

      const nextRoom = readRoom(message)
      if (nextRoom) {
        if (!acceptRoomRef.current) return
        if (roomRef.current?.code !== nextRoom.code) setTable(null)
        rememberRoom(nextRoom)
        setDeckIssue(null)
        const path = `/room/${nextRoom.code}`
        if (window.location.pathname !== path) window.history.pushState(null, '', path)
        if (!stickyNoticeRef.current) setNotice('')
        return
      }

      if (message.type === 'game') {
        const tableState = readTable(message)
        if (tableState && acceptRoomRef.current) {
          setTable(tableState)
          setNotice('')
        }
        return
      }

      if (message.type === 'notice' && typeof message.message === 'string') {
        stickyNoticeRef.current = true
        setTable(null)
        setNotice(message.message)
        return
      }

      if (message.type === 'error' && typeof message.message === 'string') {
        const cards = readCards(message.cards)
        stickyNoticeRef.current = false
        if (cards.length > 0) setDeckIssue({ message: message.message, cards })
        setNotice(message.message)
        if (!roomRef.current && roomCodeFromPath(window.location.pathname)) {
          window.history.replaceState(null, '', '/')
        }
      }
    })

    socket.addEventListener('close', () => {
      if (!active) return
      setConnection('closed')
      rememberRoom(null)
      setTable(null)
      setNotice('The game server disconnected.')
      if (window.location.pathname !== '/') window.history.replaceState(null, '', '/')
    })

    return () => {
      active = false
      if (socketRef.current === socket) socketRef.current = null
      socket.close()
    }
  }, [rememberRoom])

  useEffect(() => {
    function onPopState() {
      const code = roomCodeFromPath(window.location.pathname)
      if (code) {
        acceptRoomRef.current = true
        setNotice(`Joining room ${code}…`)
        send({ type: 'join_room', code, nickname: readNickname() })
        return
      }
      acceptRoomRef.current = false
      send({ type: 'leave_room' })
      rememberRoom(null)
      setTable(null)
      setNotice('Ask the host for a four-letter code, or create a room.')
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [rememberRoom, send])

  const createRoom = useCallback(
    (nickname: string) => {
      const name = nickname.trim()
      writeNickname(name)
      acceptRoomRef.current = true
      if (!send({ type: 'create_room', nickname: name })) return
      setNotice('Creating a room…')
    },
    [send],
  )

  const joinRoom = useCallback(
    (code: string, nickname: string) => {
      const name = nickname.trim()
      writeNickname(name)
      acceptRoomRef.current = true
      if (!send({ type: 'join_room', code, nickname: name })) return
      setNotice(`Joining room ${code}…`)
    },
    [send],
  )

  const selectDecks = useCallback(
    (deckIds: string[]) => {
      if (!send({ type: 'select_decks', deckIds })) return
      setNotice('')
    },
    [send],
  )

  const setScoreLimit = useCallback(
    (scoreLimit: number) => {
      if (!send({ type: 'set_score_limit', scoreLimit })) return
      setNotice('')
    },
    [send],
  )

  const uploadDeck = useCallback(
    (deck: { name: string; black: string[]; white: string[] }) => {
      if (!send({ type: 'upload_deck', deck })) return false
      setNotice('')
      return true
    },
    [send],
  )

  const leaveRoom = useCallback(() => {
    acceptRoomRef.current = false
    stickyNoticeRef.current = false
    send({ type: 'leave_room' })
    rememberRoom(null)
    setTable(null)
    if (window.location.pathname !== '/') window.history.pushState(null, '', '/')
    setNotice('Ask the host for a four-letter code, or create a room.')
  }, [rememberRoom, send])

  const startGame = useCallback(() => {
    stickyNoticeRef.current = false
    if (!send({ type: 'start_game' })) return false
    setNotice('')
    return true
  }, [send])

  const submitCards = useCallback(
    (cardIds: string[]) => {
      if (!send({ type: 'submit_cards', cardIds })) return false
      setNotice('')
      return true
    },
    [send],
  )

  const confirmWinner = useCallback(
    (submissionId: string) => {
      if (!send({ type: 'confirm_winner', submissionId })) return false
      setNotice('')
      return true
    },
    [send],
  )

  const nextTurn = useCallback(() => {
    if (!send({ type: 'next_turn' })) return false
    setNotice('')
    return true
  }, [send])

  const returnToLobby = useCallback(() => {
    if (!send({ type: 'return_to_lobby' })) return false
    return true
  }, [send])

  return {
    connection,
    playerId,
    decks,
    room,
    table,
    notice,
    deckIssue,
    createRoom,
    joinRoom,
    selectDecks,
    setScoreLimit,
    uploadDeck,
    leaveRoom,
    startGame,
    submitCards,
    confirmWinner,
    nextTurn,
    returnToLobby,
  }
}
