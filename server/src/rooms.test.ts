import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Deck } from './deck.js'
import { createRoomStore, DEFAULT_SCORE_LIMIT } from './rooms.js'

const decks = new Set(['sample'])

const customDeck: Deck = {
  name: 'Custom',
  black: [{ text: 'Bring me _.', pick: 1 }],
  white: ['a polite seagull'],
}

test('create opens a room hosted by that player', () => {
  const store = createRoomStore()
  const created = store.create('host', 'ABCD')
  assert.equal(created.ok, true)
  if (!created.ok) return

  assert.equal(created.previous, null)
  assert.deepEqual(created.room, {
    code: 'ABCD',
    hostId: 'host',
    deckIds: [],
    scoreLimit: DEFAULT_SCORE_LIMIT,
    playerIds: ['host'],
    customDecks: [],
  })
  assert.equal(store.has('ABCD'), true)
  created.room.playerIds.push('intruder')
  assert.deepEqual(store.get('ABCD')?.playerIds, ['host'])
})

test('create rejects a bad code and a code that is already taken', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ab').ok, false)
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.create('other', 'ABCD').ok, false)
})

test('create moves the host out of the room they were already in', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.join('other', 'ABCD').ok, true)

  const created = store.create('host', 'WXYZ')
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.previous?.code, 'ABCD')
  assert.equal(created.previous?.room?.hostId, 'other')
  assert.deepEqual(store.get('WXYZ')?.playerIds, ['host'])
})

test('join adds a player and normalizes the code', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  const joined = store.join('guest', ' abcd ')
  assert.equal(joined.ok, true)
  if (!joined.ok) return
  assert.deepEqual(joined.room.playerIds, ['host', 'guest'])
  assert.equal(store.join('guest', 'ABCD').ok, true)
  assert.deepEqual(store.get('ABCD')?.playerIds, ['host', 'guest'])
})

test('join rejects an unknown room and reports a player leaving another room', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.join('guest', 'ABCD').ok, true)
  assert.equal(store.create('other', 'WXYZ').ok, true)
  assert.equal(store.join('guest', 'ZZZZ').ok, false)

  const moved = store.join('guest', 'WXYZ')
  assert.equal(moved.ok, true)
  if (!moved.ok) return
  assert.deepEqual(moved.previous?.room?.playerIds, ['host'])
  assert.deepEqual(store.get('WXYZ')?.playerIds, ['other', 'guest'])
})

test('selectDecks lets the host replace the selected set', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.join('guest', 'ABCD').ok, true)
  assert.equal(store.selectDecks('guest', ['sample'], decks).ok, false)
  assert.equal(store.selectDecks('outsider', ['sample'], decks).ok, false)

  const selected = store.selectDecks('host', ['sample', 'sample'], decks)
  assert.equal(selected.ok, true)
  if (!selected.ok) return
  assert.deepEqual(selected.room.deckIds, ['sample'])

  assert.equal(store.selectDecks('host', ['sample', 'missing'], decks).ok, false)
  assert.deepEqual(store.get('ABCD')?.deckIds, ['sample'])

  const cleared = store.selectDecks('host', [], decks)
  assert.equal(cleared.ok, true)
  if (!cleared.ok) return
  assert.deepEqual(cleared.room.deckIds, [])
})

test('setScoreLimit accepts a host value from 1 to 20', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.join('guest', 'ABCD').ok, true)
  assert.equal(store.setScoreLimit('guest', 5).ok, false)
  assert.equal(store.setScoreLimit('host', 0).ok, false)
  assert.equal(store.setScoreLimit('host', 21).ok, false)
  assert.equal(store.setScoreLimit('outsider', 5).ok, false)

  const updated = store.setScoreLimit('host', 5)
  assert.equal(updated.ok, true)
  if (!updated.ok) return
  assert.equal(updated.room.scoreLimit, 5)
})

test('custom decks stay with the room until it is dropped', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.join('guest', 'ABCD').ok, true)
  assert.equal(store.addCustomDeck('guest', 'custom:1', customDeck).ok, false)

  const added = store.addCustomDeck('host', 'custom:1', customDeck)
  assert.equal(added.ok, true)
  if (!added.ok) return
  assert.deepEqual(added.room.customDecks, [{ id: 'custom:1', name: 'Custom', blackCount: 1, whiteCount: 1 }])
  assert.equal(store.getCustomDeck('ABCD', 'custom:1')?.name, 'Custom')

  assert.equal(store.leave('guest')?.room?.playerIds.length, 1)
  assert.equal(store.leave('host')?.room?.playerIds.length, 0)
  assert.equal(store.getCustomDeck('ABCD', 'custom:1')?.name, 'Custom')
  assert.equal(store.drop('ABCD'), true)
  assert.equal(store.getCustomDeck('ABCD', 'custom:1'), undefined)
  assert.equal(store.has('ABCD'), false)
})

test('leave removes a player and hands the room to the next one', () => {
  const store = createRoomStore()
  assert.equal(store.create('host', 'ABCD').ok, true)
  assert.equal(store.join('guest', 'ABCD').ok, true)
  assert.equal(store.leave('missing'), null)

  const left = store.leave('host')
  assert.equal(left?.room?.hostId, 'guest')
  assert.deepEqual(left?.room?.playerIds, ['guest'])
  assert.equal(store.drop('ABCD'), false)
})
