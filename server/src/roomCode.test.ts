import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateRoomCode, generateUniqueRoomCode, isValidRoomCode } from './roomCode.js'

test('generateRoomCode builds a four-letter code from the random source', () => {
  assert.equal(generateRoomCode(() => 0), 'AAAA')
  assert.equal(generateRoomCode(() => 0.999), 'ZZZZ')
  assert.equal(isValidRoomCode(generateRoomCode()), true)
})

test('generateUniqueRoomCode skips a code that is already used', () => {
  const letters = [0, 0, 0, 0, 1, 0, 0, 0]
  let call = 0
  const random = () => {
    const index = letters[call] ?? 0
    call += 1
    return (index + 0.5) / 26
  }

  assert.equal(
    generateUniqueRoomCode((code) => code === 'AAAA', random),
    'BAAA',
  )
})

test('generateUniqueRoomCode gives up when every code is taken', () => {
  assert.equal(
    generateUniqueRoomCode(() => true, () => 0),
    null,
  )
})

test('isValidRoomCode accepts only four uppercase letters', () => {
  assert.equal(isValidRoomCode('ABCD'), true)
  assert.equal(isValidRoomCode('abcd'), false)
  assert.equal(isValidRoomCode('ABC'), false)
  assert.equal(isValidRoomCode('ABCDE'), false)
  assert.equal(isValidRoomCode('AB12'), false)
})
