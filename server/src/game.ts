import type { BlackCard, Deck } from './deck.js'

export const TARGET_HAND_SIZE = 10
export const MIN_PLAYERS = 3

export interface HandCard {
  id: string
  text: string
}

export interface Submission {
  id: string
  playerId: string
  cards: HandCard[]
}

export interface PublicSubmission {
  id: string
  cards: string[]
}

export interface ScoreSeat {
  id: string
  score: number
}

export interface GameView {
  phase: 'picking' | 'judging' | 'reveal'
  scoreLimit: number
  black: BlackCard
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

export interface GameState {
  phase: 'picking' | 'judging' | 'reveal'
  scoreLimit: number
  handSize: number
  blackDraw: BlackCard[]
  blackDiscard: BlackCard[]
  whiteDraw: string[]
  hands: Map<string, HandCard[]>
  scores: Map<string, number>
  order: string[]
  tzarIndex: number
  currentBlack: BlackCard
  submissions: Map<string, Submission>
  judgingOrder: Submission[]
  highlightedId: string | null
  lastWinnerId: string | null
  random: () => number
  nextId: number
}

export type GameResult<T> = { ok: true } & T | { ok: false; error: string }

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const current = copy[index]
    copy[index] = copy[swap] as T
    copy[swap] = current as T
  }
  return copy
}

function takeId(game: GameState, prefix: string): string {
  game.nextId += 1
  return `${prefix}${game.nextId}`
}

export function tzarId(game: GameState): string {
  return game.order[game.tzarIndex] ?? ''
}

function pickers(game: GameState): string[] {
  const judge = tzarId(game)
  return game.order.filter((id) => id !== judge)
}

function allSubmitted(game: GameState): boolean {
  const waiting = pickers(game)
  return waiting.length > 0 && waiting.every((id) => game.submissions.has(id))
}

function beginJudging(game: GameState): void {
  game.judgingOrder = shuffle([...game.submissions.values()], game.random)
  game.highlightedId = null
  game.phase = 'judging'
}

function drawBlack(game: GameState): boolean {
  if (game.blackDraw.length === 0) {
    if (game.blackDiscard.length === 0) return false
    game.blackDraw = shuffle(game.blackDiscard, game.random)
    game.blackDiscard = []
  }
  const next = game.blackDraw.shift()
  if (!next) return false
  game.currentBlack = next
  return true
}

function refillHands(game: GameState): void {
  for (const playerId of game.order) {
    const hand = game.hands.get(playerId) ?? []
    while (hand.length < game.handSize) {
      const text = game.whiteDraw.shift()
      if (text === undefined) break
      hand.push({ id: takeId(game, 'c'), text })
    }
    game.hands.set(playerId, hand)
  }
}

function releaseTzarSubmission(game: GameState): void {
  const judge = tzarId(game)
  const submission = game.submissions.get(judge)
  if (!submission) return
  const hand = game.hands.get(judge) ?? []
  hand.push(...submission.cards)
  game.hands.set(judge, hand)
  game.submissions.delete(judge)
  game.judgingOrder = game.judgingOrder.filter((entry) => entry.playerId !== judge)
}

export function createGame(
  playerIds: string[],
  hostId: string,
  deck: Deck,
  scoreLimit: number,
  random: () => number = Math.random,
): GameResult<{ game: GameState }> {
  if (playerIds.length < MIN_PLAYERS) {
    return { ok: false, error: 'At least three players are needed to start.' }
  }
  if (!playerIds.includes(hostId)) {
    return { ok: false, error: 'The host needs to be in the room.' }
  }
  if (deck.black.length === 0) {
    return { ok: false, error: 'The deck does not have enough black cards.' }
  }

  const maxPick = deck.black.reduce((max, card) => Math.max(max, card.pick), 1)
  const perPlayer = Math.floor(deck.white.length / playerIds.length)
  if (perPlayer < maxPick) {
    return { ok: false, error: 'This deck does not have enough white cards for this many players.' }
  }

  const handSize = Math.min(TARGET_HAND_SIZE, perPlayer)
  const whiteDraw = shuffle([...deck.white], random)
  const blackDraw = shuffle(
    deck.black.map((card) => ({ text: card.text, pick: card.pick })),
    random,
  )
  const hands = new Map<string, HandCard[]>()
  const scores = new Map<string, number>()
  const game: GameState = {
    phase: 'picking',
    scoreLimit,
    handSize,
    blackDraw,
    blackDiscard: [],
    whiteDraw,
    hands,
    scores,
    order: [...playerIds],
    tzarIndex: Math.max(0, playerIds.indexOf(hostId)),
    currentBlack: blackDraw[0] as BlackCard,
    submissions: new Map(),
    judgingOrder: [],
    highlightedId: null,
    lastWinnerId: null,
    random,
    nextId: 0,
  }

  for (const playerId of playerIds) {
    const hand: HandCard[] = []
    for (let index = 0; index < handSize; index += 1) {
      const text = game.whiteDraw.shift()
      if (text === undefined) {
        return { ok: false, error: 'This deck does not have enough white cards for this many players.' }
      }
      hand.push({ id: takeId(game, 'c'), text })
    }
    hands.set(playerId, hand)
    scores.set(playerId, 0)
  }

  if (!drawBlack(game)) {
    return { ok: false, error: 'The deck does not have enough black cards.' }
  }

  return { ok: true, game }
}

export function submitCards(game: GameState, playerId: string, cardIds: string[]): GameResult<{ judging: boolean }> {
  if (game.phase !== 'picking') {
    return { ok: false, error: 'Cards cannot be changed after everyone has chosen.' }
  }
  if (!game.order.includes(playerId)) {
    return { ok: false, error: 'You are not in this game.' }
  }
  if (playerId === tzarId(game)) {
    return { ok: false, error: 'The Card Tzar does not play a white card this turn.' }
  }
  if (game.submissions.has(playerId)) {
    return { ok: false, error: 'You have already chosen.' }
  }
  if (new Set(cardIds).size !== cardIds.length || cardIds.length !== game.currentBlack.pick) {
    return { ok: false, error: 'Play the right number of white cards.' }
  }

  const hand = game.hands.get(playerId) ?? []
  const chosen: HandCard[] = []
  for (const cardId of cardIds) {
    const card = hand.find((entry) => entry.id === cardId)
    if (!card) return { ok: false, error: 'Those cards are not in your hand.' }
    chosen.push(card)
  }

  game.hands.set(
    playerId,
    hand.filter((card) => !cardIds.includes(card.id)),
  )
  game.submissions.set(playerId, { id: takeId(game, 's'), playerId, cards: chosen })
  const judging = allSubmitted(game)
  if (judging) beginJudging(game)
  return { ok: true, judging }
}

export function highlightWinner(game: GameState, playerId: string, submissionId: string): GameResult<{ highlightedId: string }> {
  if (game.phase !== 'judging') {
    return { ok: false, error: 'Wait until everyone has chosen.' }
  }
  if (playerId !== tzarId(game)) {
    return { ok: false, error: 'Only the Card Tzar can choose the winner.' }
  }
  if (!game.judgingOrder.some((entry) => entry.id === submissionId)) {
    return { ok: false, error: 'That set is not on the table.' }
  }

  game.highlightedId = submissionId
  return { ok: true, highlightedId: submissionId }
}

export function confirmWinner(game: GameState, playerId: string): GameResult<{ winnerId: string }> {
  if (game.phase !== 'judging') {
    return { ok: false, error: 'Wait until everyone has chosen.' }
  }
  if (playerId !== tzarId(game)) {
    return { ok: false, error: 'Only the Card Tzar can choose the winner.' }
  }

  const winning = game.judgingOrder.find((entry) => entry.id === game.highlightedId)
  if (!winning) return { ok: false, error: 'Choose a set before confirming.' }

  const score = (game.scores.get(winning.playerId) ?? 0) + 1
  game.scores.set(winning.playerId, score)
  game.lastWinnerId = winning.playerId
  game.phase = 'reveal'
  return { ok: true, winnerId: winning.playerId }
}

export function nextTurn(game: GameState, playerId: string): GameResult<{ finished: boolean; winnerId: string }> {
  if (game.phase !== 'reveal') {
    return { ok: false, error: 'Confirm a winner before the next turn.' }
  }
  if (playerId !== tzarId(game)) {
    return { ok: false, error: 'Only the Card Tzar can start the next turn.' }
  }

  const winnerId = game.lastWinnerId ?? ''
  if ([...game.scores.values()].some((score) => score >= game.scoreLimit)) {
    return { ok: true, finished: true, winnerId }
  }

  for (const submission of game.judgingOrder) {
    game.whiteDraw.push(...submission.cards.map((card) => card.text))
  }
  game.blackDiscard.push(game.currentBlack)
  if (!drawBlack(game)) {
    return { ok: false, error: 'The black deck is empty.' }
  }

  game.submissions.clear()
  game.judgingOrder = []
  game.highlightedId = null
  game.phase = 'picking'
  game.tzarIndex = (game.tzarIndex + 1) % game.order.length
  refillHands(game)
  return { ok: true, finished: false, winnerId }
}

export function removePlayer(game: GameState, playerId: string): { abort: boolean } {
  if (!game.order.includes(playerId)) return { abort: game.order.length < MIN_PLAYERS }

  const hand = game.hands.get(playerId) ?? []
  game.whiteDraw.push(...hand.map((card) => card.text))
  game.hands.delete(playerId)
  game.scores.delete(playerId)

  const submission = game.submissions.get(playerId)
  if (submission) {
    game.whiteDraw.push(...submission.cards.map((card) => card.text))
    game.submissions.delete(playerId)
    game.judgingOrder = game.judgingOrder.filter((entry) => entry.playerId !== playerId)
    if (game.highlightedId === submission.id) game.highlightedId = null
  }

  const judge = tzarId(game)
  game.order = game.order.filter((id) => id !== playerId)
  if (game.order.length < MIN_PLAYERS) return { abort: true }

  const nextJudge = judge === playerId ? game.order[game.tzarIndex % game.order.length] : judge
  game.tzarIndex = Math.max(0, game.order.indexOf(nextJudge ?? game.order[0] ?? ''))
  releaseTzarSubmission(game)

  if (game.phase === 'judging' && game.judgingOrder.length === 0) {
    game.phase = 'picking'
    game.submissions.clear()
    refillHands(game)
  } else if (game.phase === 'picking' && allSubmitted(game)) {
    beginJudging(game)
  } else if (game.phase === 'picking') {
    refillHands(game)
  }

  return { abort: false }
}

export function viewFor(game: GameState, playerId: string): GameView {
  const judge = tzarId(game)
  const waiting = pickers(game)
  const hand = game.hands.get(playerId) ?? []
  return {
    phase: game.phase,
    scoreLimit: game.scoreLimit,
    black: { text: game.currentBlack.text, pick: game.currentBlack.pick },
    tzarId: judge,
    scores: game.order.map((id) => ({ id, score: game.scores.get(id) ?? 0 })),
    you: { hand: hand.map((card) => ({ id: card.id, text: card.text })) },
    submitted: game.submissions.has(playerId),
    readyCount: waiting.filter((id) => game.submissions.has(id)).length,
    neededCount: waiting.length,
    submissions:
      game.phase === 'judging' || game.phase === 'reveal'
        ? game.judgingOrder.map((entry) => ({
            id: entry.id,
            cards: entry.cards.map((card) => card.text),
          }))
        : null,
    highlightedId: game.highlightedId,
    lastWinnerId: game.lastWinnerId,
  }
}
