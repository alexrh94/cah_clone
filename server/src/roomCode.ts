const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ROOM_CODE_PATTERN = /^[A-Z]{4}$/
const ALLOCATION_ATTEMPTS = 50

export function generateRoomCode(random: () => number = Math.random): string {
  let code = ''
  for (let index = 0; index < 4; index += 1) {
    const letterIndex = Math.floor(random() * LETTERS.length)
    code += LETTERS[letterIndex] ?? LETTERS[0]
  }
  return code
}

export function generateUniqueRoomCode(
  isTaken: (code: string) => boolean,
  random: () => number = Math.random,
): string | null {
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode(random)
    if (!isTaken(code)) return code
  }
  return null
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code)
}
