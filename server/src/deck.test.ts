import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { countBlanks, listDecks, loadDeck, UNDERSCORE_MESSAGE, validateDeck } from './deck.js'

const sampleDeckPath = fileURLToPath(new URL('../../decks/sample.json', import.meta.url))

test('countBlanks counts every underscore, including neighbours', () => {
  assert.equal(countBlanks('a _ b'), 1)
  assert.equal(countBlanks('__'), 2)
  assert.equal(countBlanks('a__b_c'), 3)
  assert.equal(countBlanks('no blanks here'), 0)
})

test('validateDeck accepts the string-list format and stores a pick count', () => {
  const result = validateDeck({
    name: '  House rules  ',
    black: ['  a _ b  ', 'x__y'],
    white: [' one ', 'two'],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.deck.name, 'House rules')
  assert.deepEqual(result.deck.black, [
    { text: 'a _ b', pick: 1 },
    { text: 'x__y', pick: 2 },
  ])
  assert.deepEqual(result.deck.white, ['one', 'two'])
})

test('validateDeck reports every black card that has no underscore', () => {
  const first = "Why can't I sleep at night?"
  const second = 'Also missing a blank'
  const result = validateDeck({
    name: 'Broken',
    black: [first, 'has _ one', second],
    white: ['an answer'],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors.includes(UNDERSCORE_MESSAGE), true)
  assert.deepEqual(result.cards, [first, second])
})

test('validateDeck rejects malformed decks', () => {
  assert.deepEqual(validateDeck(null), { ok: false, errors: ['Deck must be a JSON object'], cards: [] })
  assert.equal(validateDeck({ name: ' ', black: ['a _'], white: ['b'] }).ok, false)
  assert.equal(validateDeck({ name: 'Ok', black: [], white: ['b'] }).ok, false)
  assert.equal(validateDeck({ name: 'Ok', black: ['a _'], white: [] }).ok, false)
  assert.equal(validateDeck({ name: 'Ok', black: ['a _', 4], white: ['b'] }).ok, false)
})

test('loadDeck reads the sample deck', () => {
  const deck = loadDeck(sampleDeckPath)
  assert.equal(deck.name, 'Sample')
  assert.equal(deck.black.length, 10)
  assert.equal(deck.white.length, 40)
  assert.equal(
    deck.black.every((card) => card.pick >= 1 && card.text.includes('_')),
    true,
  )
  const password = deck.black.find((card) => card.text === 'The password is __.')
  assert.equal(password?.pick, 2)
})

test('listDecks reads the sample deck and skips other files', () => {
  const decks = listDecks(dirname(sampleDeckPath))
  assert.ok(decks.cards.length === 0)
  assert.ok(decks.decks.some((deck) => deck.id === 'sample' && deck.name === 'Sample'))
})

test('listDecks reports black cards that have no underscore', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cah-decks-'))
  const missing = 'Why can I not sleep at night?'
  writeFileSync(join(directory, 'notes.txt'), 'ignore me')
  mkdirSync(join(directory, 'nested.json'))
  writeFileSync(
    join(directory, 'broken.json'),
    JSON.stringify({ name: 'Broken', black: [missing, 'still _ fine'], white: ['an answer'] }),
  )
  writeFileSync(join(directory, 'not-json.json'), '{')

  const listed = listDecks(directory)
  assert.deepEqual(listed.decks, [])
  assert.deepEqual(listed.cards, [missing])
  assert.equal(listed.errors.length, 1)
})
