import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const UNDERSCORE_MESSAGE = 'Black card must contain at least one underscore.'
export const MAX_BLACK_CARDS = 500
export const MAX_WHITE_CARDS = 2000
export const MAX_DECK_BYTES = 512 * 1024

export interface BlackCard {
  text: string
  pick: number
}

export interface Deck {
  name: string
  black: BlackCard[]
  white: string[]
}

export interface DeckSummary {
  id: string
  name: string
}

export interface DeckList {
  decks: DeckSummary[]
  cards: string[]
  errors: string[]
}

export type DeckValidation =
  | { ok: true; deck: Deck }
  | { ok: false; errors: string[]; cards: string[] }

export function countBlanks(text: string): number {
  let count = 0
  for (const character of text) {
    if (character === '_') count += 1
  }
  return count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readName(value: unknown, errors: string[]): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push('Deck name must be a non-empty string')
    return null
  }
  return value.trim()
}

function readCards(value: unknown, label: string, errors: string[], offending: string[]): string[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be a list of strings`)
    return null
  }

  const cards: string[] = []
  let valid = true
  for (const [index, card] of value.entries()) {
    if (typeof card !== 'string' || card.trim() === '') {
      errors.push(`${label} card ${index + 1} must be a non-empty string`)
      valid = false
      continue
    }
    cards.push(card.trim())
  }

  if (label === 'Black') {
    for (const card of value) {
      if (typeof card === 'string' && card.trim() !== '' && !card.includes('_')) {
        offending.push(card)
      }
    }
    if (offending.length > 0 && !errors.includes(UNDERSCORE_MESSAGE)) {
      errors.push(UNDERSCORE_MESSAGE)
    }
  }

  if (!valid) return null
  if (cards.length === 0) {
    errors.push(`Deck must include at least one ${label.toLowerCase()} card`)
    return null
  }
  if (label === 'Black' && cards.length > MAX_BLACK_CARDS) {
    errors.push('That deck is too large.')
    return null
  }
  if (label === 'White' && cards.length > MAX_WHITE_CARDS) {
    errors.push('That deck is too large.')
    return null
  }
  if (offending.length > 0) return null
  return cards
}

export function validateDeck(input: unknown): DeckValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: ['Deck must be a JSON object'], cards: [] }
  }

  const errors: string[] = []
  const cards: string[] = []
  const name = readName(input.name, errors)
  const black = readCards(input.black, 'Black', errors, cards)
  const white = readCards(input.white, 'White', errors, cards)

  if (!name || !black || !white) {
    return { ok: false, errors, cards }
  }

  return {
    ok: true,
    deck: {
      name,
      black: black.map((text) => ({ text, pick: countBlanks(text) })),
      white,
    },
  }
}

export function loadDeck(filePath: string): Deck {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    throw new Error(`Invalid deck at ${filePath}`)
  }

  const result = validateDeck(raw)
  if (!result.ok) {
    const detail = result.cards.length > 0 ? `${UNDERSCORE_MESSAGE} ${result.cards.join('; ')}` : result.errors.join('; ')
    throw new Error(`Invalid deck at ${filePath}: ${detail}`)
  }
  return result.deck
}

export function listDecks(decksDir: string): DeckList {
  const decks: DeckSummary[] = []
  const cards: string[] = []
  const errors: string[] = []

  for (const entry of readdirSync(decksDir)) {
    if (!entry.toLowerCase().endsWith('.json')) continue

    const filePath = join(decksDir, entry)
    if (!statSync(filePath).isFile()) continue

    const id = entry.slice(0, -'.json'.length)
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      errors.push(`${entry} has an invalid deck id`)
      continue
    }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      errors.push(`Invalid deck at ${filePath}`)
      continue
    }

    const result = validateDeck(raw)
    if (!result.ok) {
      cards.push(...result.cards)
      if (result.cards.length === 0) errors.push(`Invalid deck at ${filePath}: ${result.errors.join('; ')}`)
      continue
    }
    decks.push({ id, name: result.deck.name })
  }

  decks.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return { decks, cards, errors }
}
