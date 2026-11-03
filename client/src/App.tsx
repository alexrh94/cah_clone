import { useState, type FormEvent } from 'react'
import { UNDERSCORE_MESSAGE, validateDeck } from './deck'
import { GameView } from './GameView'
import {
  readNickname,
  useGameServer,
  type Connection,
  type DeckChoice,
  type DeckIssue,
  type RoomPlayer,
  type RoomState,
} from './useGameServer'

const ROOM_CODE = /^[A-Z]{4}$/

export function App() {
  const game = useGameServer()
  const playing = Boolean(game.room && game.playerId && game.table)

  return (
    <main className={playing ? 'table' : 'lobby'}>
      {!playing && (
        <div className="cards" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      {game.room && game.playerId && game.table ? (
        <GameView
          room={game.room}
          playerId={game.playerId}
          table={game.table}
          notice={game.notice}
          onSubmit={game.submitCards}
          onHighlight={game.highlightWinner}
          onConfirm={game.confirmWinner}
          onNextTurn={game.nextTurn}
          onLeave={game.leaveRoom}
        />
      ) : game.room && game.playerId ? (
        <RoomView
          room={game.room}
          playerId={game.playerId}
          decks={game.decks}
          notice={game.notice}
          deckIssue={game.deckIssue}
          onSelectDeck={game.selectDeck}
          onScoreLimit={game.setScoreLimit}
          onUpload={game.uploadDeck}
          onStart={game.startGame}
          onLeave={game.leaveRoom}
        />
      ) : (
        <LobbyView
          notice={game.notice}
          connection={game.connection}
          deckIssue={game.deckIssue}
          onCreate={game.createRoom}
          onJoin={game.joinRoom}
        />
      )}
    </main>
  )
}

function LobbyView({
  notice,
  connection,
  deckIssue,
  onCreate,
  onJoin,
}: {
  notice: string
  connection: Connection
  deckIssue: DeckIssue | null
  onCreate: (nickname: string) => void
  onJoin: (code: string, nickname: string) => void
}) {
  const [nickname, setNickname] = useState(readNickname)
  const [roomCode, setRoomCode] = useState('')
  const [localMessage, setLocalMessage] = useState<string | null>(null)
  const connected = connection === 'open'
  const message = connected ? (localMessage ?? notice) : notice

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = roomCode.trim().toUpperCase()
    if (!ROOM_CODE.test(code)) {
      setLocalMessage('Room codes are four letters, like ABCD.')
      return
    }
    setLocalMessage(null)
    onJoin(code, nickname)
  }

  return (
    <>
      <h1>Cards Against Humanity</h1>
      <form className="join" onSubmit={handleSubmit}>
        <label htmlFor="nickname">Nickname</label>
        <input
          id="nickname"
          className="name"
          name="nickname"
          value={nickname}
          autoComplete="nickname"
          maxLength={24}
          placeholder="Enter your nickname"
          onChange={(event) => setNickname(event.target.value)}
        />
        <label htmlFor="room-code">Room code</label>
        <div className="join-row">
          <input
            id="room-code"
            className="code"
            name="roomCode"
            value={roomCode}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={4}
            placeholder="ABCD"
            onChange={(event) => {
              setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))
            }}
          />
          <button type="submit" disabled={!connected}>
            Join room
          </button>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setLocalMessage(null)
            onCreate(nickname)
          }}
          disabled={!connected}
        >
          Create room
        </button>
        <p className="status" role="status">
          {message}
        </p>
        {deckIssue && <DeckIssueView issue={deckIssue} />}
      </form>
    </>
  )
}

function RoomView({
  room,
  playerId,
  decks,
  notice,
  deckIssue,
  onSelectDeck,
  onScoreLimit,
  onUpload,
  onStart,
  onLeave,
}: {
  room: RoomState
  playerId: string
  decks: DeckChoice[]
  notice: string
  deckIssue: DeckIssue | null
  onSelectDeck: (deckId: string) => void
  onScoreLimit: (scoreLimit: number) => void
  onUpload: (deck: { name: string; black: string[]; white: string[] }) => boolean
  onStart: () => void
  onLeave: () => void
}) {
  const [localIssue, setLocalIssue] = useState<DeckIssue | null>(null)
  const isHost = room.hostId === playerId
  const options = [...decks, ...room.customDecks]
  const canStart = isHost && room.players.length >= 3 && room.deckId !== null
  const hint = !room.deckId
    ? isHost
      ? 'Choose a deck for this room.'
      : 'Waiting for the host to choose a deck.'
    : room.players.length < 3
      ? 'Waiting for at least three players.'
      : isHost
        ? 'Everyone is here. Start the game when you are ready.'
        : 'Waiting for the host to start the game.'
  const issue = localIssue ?? deckIssue
  const message = issue ? '' : notice || hint

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const cards: string[] = []
    const messages: string[] = []
    for (const file of files) {
      let parsed: unknown
      try {
        parsed = JSON.parse(await file.text())
      } catch {
        messages.push(`${file.name} is not valid JSON.`)
        continue
      }
      const result = validateDeck(parsed)
      if (!result.ok) {
        if (result.cards.length > 0) cards.push(...result.cards)
        else messages.push(`${file.name}: ${result.errors.join(' ')}`)
        continue
      }
      onUpload({
        name: result.deck.name,
        black: result.deck.black.map((card) => card.text),
        white: result.deck.white,
      })
    }
    if (cards.length > 0 || messages.length > 0) {
      setLocalIssue({
        message: [cards.length > 0 ? UNDERSCORE_MESSAGE : null, ...messages].filter((entry) => entry !== null).join(' '),
        cards,
      })
      return
    }
    setLocalIssue(null)
  }

  return (
    <>
      <p className="eyebrow">Room code</p>
      <h1 className="room-code">{room.code}</h1>
      <p className="lede">Share this code with the other players. The host chooses the deck and the score limit.</p>
      <section className="join">
        <div className="field">
          <label htmlFor="deck">Deck</label>
          {options.length === 0 ? (
            <p className="status">No decks are available.</p>
          ) : (
            <select
              id="deck"
              name="deck"
              value={room.deckId ?? ''}
              disabled={!isHost}
              onChange={(event) => {
                if (event.target.value) onSelectDeck(event.target.value)
              }}
            >
              <option value="" disabled>
                Select a deck
              </option>
              {options.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="field">
          <label htmlFor="score-limit">Score limit</label>
          <input
            id="score-limit"
            className="score-limit"
            name="scoreLimit"
            type="number"
            min={1}
            max={20}
            step={1}
            value={room.scoreLimit}
            disabled={!isHost}
            onChange={(event) => {
              const scoreLimit = Number(event.target.value)
              if (Number.isInteger(scoreLimit) && scoreLimit >= 1 && scoreLimit <= 20) onScoreLimit(scoreLimit)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="deck-file">Upload a deck</label>
          <input
            id="deck-file"
            name="deckFile"
            type="file"
            accept="application/json,.json"
            multiple
            disabled={!isHost}
            onChange={(event) => {
              void uploadFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>
        {issue && <DeckIssueView issue={issue} />}
        <h2 className="section">Players</h2>
        <ul className="players">
          {room.players.map((player, index) => (
            <li key={player.id}>{playerLabel(player, index, playerId, room.hostId)}</li>
          ))}
        </ul>
        <button type="button" className="start" onClick={() => onStart()} disabled={!canStart}>
          Start game
        </button>
        <button type="button" className="secondary" onClick={onLeave}>
          Leave room
        </button>
        <p className="status" role="status">
          {message}
        </p>
      </section>
    </>
  )
}

export function DeckIssueView({ issue }: { issue: DeckIssue }) {
  return (
    <div className="deck-issue" role="alert">
      <p>{issue.message}</p>
      {issue.cards.length > 0 && (
        <ul>
          {issue.cards.map((card, index) => (
            <li key={`${card}-${index}`}>
              <mark>{card}</mark>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function playerLabel(player: RoomPlayer, index: number, playerId: string, hostId: string): string {
  const named = player.nickname !== ''
  const name = named ? player.nickname : player.id === playerId ? 'You' : `Player ${index + 1}`
  const label = named && player.id === playerId ? `${name} (you)` : name
  return player.id === hostId ? `${label}, host` : label
}
