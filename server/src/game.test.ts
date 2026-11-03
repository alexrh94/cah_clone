import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Deck } from './deck.js'
import { confirmWinner, createGame, nextTurn, removePlayer, requiredCards, submitCards, tzarId, viewFor } from './game.js'

const steady = () => 0.999999

function deck(black: string[], white: string[]): Deck {
  return {
    name: 'Test',
    black: black.map((text) => ({ text, pick: [...text].filter((character) => character === '_').length })),
    white,
  }
}

const whites = Array.from({ length: 20 }, (_, index) => `w${index}`)

test('requiredCards scales with the number of players', () => {
  assert.deepEqual(requiredCards(1), { white: 10, black: 2 })
  assert.deepEqual(requiredCards(3), { white: 30, black: 6 })
  assert.deepEqual(requiredCards(5), { white: 50, black: 10 })
})

test('createGame deals a shared hand and refuses a deck that cannot cover the largest pick', () => {
  const players = ['host', 'a', 'b']
  const created = createGame(players, 'host', deck(['one _', 'two _'], whites), 7, steady)
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.game.handSize, 6)
  assert.equal(created.game.hands.get('host')?.length, 6)
  assert.equal(tzarId(created.game), 'host')
  assert.equal(created.game.whiteDraw.length, 2)

  const short = createGame(players, 'host', deck(['__'], ['only', 'two', 'three']), 7, steady)
  assert.equal(short.ok, false)
  assert.equal(createGame(['host', 'a'], 'host', deck(['a _'], whites), 7, steady).ok, false)
})

test('players submit in order, then the Card Tzar picks an anonymous set', () => {
  const players = ['host', 'a', 'b']
  const created = createGame(players, 'host', deck(['one _', 'two _'], whites), 7, steady)
  assert.equal(created.ok, true)
  if (!created.ok) return
  const game = created.game
  const handA = game.hands.get('a') ?? []
  const handB = game.hands.get('b') ?? []
  const playedA = handA[0]?.text ?? ''
  const playedB = handB[0]?.text ?? ''

  assert.equal(submitCards(game, 'host', [game.hands.get('host')?.[0]?.id ?? '']).ok, false)
  assert.equal(submitCards(game, 'a', []).ok, false)
  assert.equal(submitCards(game, 'a', ['missing']).ok, false)
  assert.equal(submitCards(game, 'a', [handA[0]?.id ?? '', handA[0]?.id ?? '']).ok, false)

  const first = submitCards(game, 'a', [handA[0]?.id ?? ''])
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.judging, false)
  assert.equal(viewFor(game, 'b').submissions, null)

  const second = submitCards(game, 'b', [handB[0]?.id ?? ''])
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.judging, true)

  const view = viewFor(game, 'host')
  assert.equal(view.submissions?.length, 2)
  for (const submission of view.submissions ?? []) {
    assert.deepEqual(Object.keys(submission).sort(), ['cards', 'id'])
  }
  assert.equal(view.submissions?.some((submission) => submission.cards[0] === playedA), true)
  assert.equal(view.submissions?.some((submission) => submission.cards[0] === playedB), true)

  const winner = view.submissions?.[0]
  assert.ok(winner)
  assert.equal(viewFor(game, 'host').highlightedId, null)
  assert.equal(viewFor(game, 'b').highlightedId, null)
  assert.equal(confirmWinner(game, 'a', winner?.id ?? '').ok, false)
  assert.equal(confirmWinner(game, 'host', 'missing').ok, false)
  assert.equal(game.scores.get('a'), 0)
  assert.equal(game.scores.get('b'), 0)

  const confirmed = confirmWinner(game, 'host', winner?.id ?? '')
  assert.equal(confirmed.ok, true)
  if (!confirmed.ok) return
  assert.equal(game.phase, 'reveal')
  assert.equal(viewFor(game, 'b').highlightedId, winner?.id)
  assert.equal(viewFor(game, 'host').highlightedId, winner?.id)
  assert.equal(game.scores.get(confirmed.winnerId), 1)
  assert.equal(tzarId(game), 'host')
  assert.equal(game.currentBlack.text, 'one _')

  assert.equal(nextTurn(game, 'a').ok, false)
  const advanced = nextTurn(game, 'host')
  assert.equal(advanced.ok, true)
  if (!advanced.ok) return
  assert.equal(advanced.finished, false)
  assert.equal(tzarId(game), 'a')
  assert.equal(game.currentBlack.text, 'two _')
  assert.equal(game.phase, 'picking')
  assert.deepEqual(game.whiteDraw, [playedA, playedB])
})

test('a score limit ends the game', () => {
  const created = createGame(['host', 'a', 'b'], 'host', deck(['one _'], whites), 1, steady)
  assert.equal(created.ok, true)
  if (!created.ok) return
  const game = created.game
  assert.equal(submitCards(game, 'a', [game.hands.get('a')?.[0]?.id ?? '']).ok, true)
  assert.equal(submitCards(game, 'b', [game.hands.get('b')?.[0]?.id ?? '']).ok, true)
  const submissionId = viewFor(game, 'host').submissions?.[0]?.id ?? ''
  assert.equal(viewFor(game, 'a').highlightedId, null)
  assert.equal(confirmWinner(game, 'host', '').ok, false)
  const confirmed = confirmWinner(game, 'host', submissionId)
  assert.equal(confirmed.ok, true)
  if (!confirmed.ok) return
  assert.equal(game.phase, 'reveal')
  assert.equal(game.scores.get(confirmed.winnerId), 1)
  const advanced = nextTurn(game, 'host')
  assert.equal(advanced.ok, true)
  if (!advanced.ok) return
  assert.equal(advanced.finished, true)
})

test('neighbouring underscores require that many white cards', () => {
  const created = createGame(['host', 'a', 'b'], 'host', deck(['__'], Array.from({ length: 12 }, (_, index) => `n${index}`)), 7, steady)
  assert.equal(created.ok, true)
  if (!created.ok) return
  const game = created.game
  assert.equal(game.currentBlack.pick, 2)
  const hand = game.hands.get('a') ?? []
  assert.equal(submitCards(game, 'a', [hand[0]?.id ?? '']).ok, false)
  assert.equal(submitCards(game, 'a', [hand[0]?.id ?? '', hand[1]?.id ?? '']).ok, true)
})

test('removePlayer returns cards to the deck and ends the game below three players', () => {
  const created = createGame(['host', 'a', 'b', 'c'], 'host', deck(['one _'], Array.from({ length: 40 }, (_, index) => `p${index}`)), 7, steady)
  assert.equal(created.ok, true)
  if (!created.ok) return
  const game = created.game
  const leaving = game.hands.get('c')?.map((card) => card.text) ?? []
  const removed = removePlayer(game, 'c')
  assert.equal(removed.abort, false)
  assert.equal(game.order.includes('c'), false)
  for (const text of leaving) assert.equal(game.whiteDraw.includes(text), true)

  assert.equal(removePlayer(game, 'b').abort, true)
})
