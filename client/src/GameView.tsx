import { useEffect, useState } from 'react'
import type { PublicSubmission, RoomPlayer, RoomState, TableState } from './useGameServer'

export function GameView({
  room,
  playerId,
  table,
  notice,
  onSubmit,
  onConfirm,
  onNextTurn,
  onReturnToLobby,
  onLeave,
}: {
  room: RoomState
  playerId: string
  table: TableState
  notice: string
  onSubmit: (cardIds: string[]) => boolean
  onConfirm: (submissionId: string) => boolean
  onNextTurn: () => boolean
  onReturnToLobby: () => boolean
  onLeave: () => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [choice, setChoice] = useState<string | null>(null)
  const isTzar = table.tzarId === playerId
  const isHost = room.hostId === playerId
  const readyToPlay = selected.length === table.black.pick
  const winner = table.lastWinnerId ? playerName(room, table.lastWinnerId, playerId) : null
  const showHand = !isTzar && table.phase === 'picking' && !table.submitted
  const showTzarHand = isTzar && table.phase === 'picking'
  const spread = table.phase === 'judging' || table.phase === 'reveal'

  useEffect(() => {
    setSelected([])
    setChoice(null)
  }, [table.black.text, table.phase])

  function toggle(cardId: string) {
    setSelected((current) => {
      const pick = table.black.pick
      const index = current.indexOf(cardId)
      if (index >= 0) {
        if (current.length < pick || index === current.length - 1) return current.filter((id) => id !== cardId)
        return [...current.slice(0, index), ...current.slice(index + 1), cardId]
      }
      if (current.length < pick) return [...current, cardId]
      return [...current.slice(0, -1), cardId]
    })
  }

  return (
    <div className={spread ? 'table-screen is-spread' : 'table-screen'}>
      <aside className="scoreboard" aria-label="Scores">
        <p className="scoreboard-title">Scores</p>
        <ol>
          {table.scores.map((seat) => {
            const name = playerName(room, seat.id, playerId)
            const tzar = seat.id === table.tzarId
            return (
              <li key={seat.id} className={tzar ? 'is-tzar' : undefined}>
                <span>{name}</span>
                <span className="points">
                  {seat.score}
                  {tzar ? <em> Card Tzar</em> : null}
                </span>
              </li>
            )
          })}
        </ol>
        <button type="button" className="leave" onClick={isHost ? onReturnToLobby : onLeave}>
          {isHost ? 'Return to lobby' : 'Leave'}
        </button>
      </aside>

      <section className="stage">
        {table.phase === 'reveal' && winner && <p className="round-winner">{winner} won this round.</p>}
        <article className="black-card" aria-label="Black card">
          <Prompt text={table.black.text} />
          {table.black.pick > 1 && <p className="pick-count">Play {table.black.pick} cards</p>}
        </article>
        {table.phase === 'picking' && winner && <p className="last-winner">{winner} won the last round.</p>}
        {(table.phase === 'judging' || table.phase === 'reveal') && table.submissions && (
          <div className="submissions">
            {table.submissions.map((submission, index) => (
              <SubmissionCard
                key={submission.id}
                submission={submission}
                index={index}
                text={table.black.text}
                highlighted={isTzar && table.phase === 'judging' && submission.id === choice}
                winner={table.phase === 'reveal' && submission.id === table.highlightedId}
                selectable={isTzar && table.phase === 'judging'}
                onChoose={setChoice}
              />
            ))}
          </div>
        )}
        {table.phase === 'picking' && (
          <p className="ready">
            {table.readyCount} of {table.neededCount} players have chosen.
          </p>
        )}
        {notice && (
          <p className="table-notice" role="status">
            {notice}
          </p>
        )}
      </section>

      <section className={isTzar && table.phase === 'judging' ? 'hand-bar is-docked' : 'hand-bar'} aria-label="Your hand">
        {showTzarHand && (
          <div className="hand is-locked">
            {table.you.hand.map((card) => (
              <div key={card.id} className="white-card">
                {card.text}
              </div>
            ))}
          </div>
        )}
        {showHand ? (
          <>
            <div className="hand">
              {table.you.hand.map((card) => {
                const order = selected.indexOf(card.id)
                const chosen = order >= 0
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={chosen ? 'white-card selected' : 'white-card'}
                    aria-pressed={chosen}
                    onClick={() => toggle(card.id)}
                  >
                    {chosen && <span className="order">{order + 1}</span>}
                    {card.text}
                  </button>
                )
              })}
            </div>
            <button type="button" className="confirm" disabled={!readyToPlay} onClick={() => onSubmit(selected)}>
              {readyToPlay ? 'Play' : `${selected.length} of ${table.black.pick}`}
            </button>
          </>
        ) : isTzar && table.phase === 'judging' ? (
          <>
            <p className="tzar-note">You are the Card Tzar</p>
            <button
              type="button"
              className="confirm"
              disabled={choice === null}
              onClick={() => {
                if (choice) onConfirm(choice)
              }}
            >
              Confirm
            </button>
          </>
        ) : isTzar && table.phase === 'reveal' ? (
          <button type="button" className="confirm" onClick={() => onNextTurn()}>
            Next Turn
          </button>
        ) : (
          <p className="tzar-note">
            {isTzar
              ? 'You are the Card Tzar'
              : table.phase === 'reveal'
                ? 'Waiting for the next turn.'
                : table.phase === 'judging'
                  ? 'Waiting for the Card Tzar.'
                  : 'Waiting for the other players.'}
          </p>
        )}
      </section>
    </div>
  )
}

function SubmissionCard({
  submission,
  index,
  text,
  highlighted,
  winner,
  selectable,
  onChoose,
}: {
  submission: PublicSubmission
  index: number
  text: string
  highlighted: boolean
  winner: boolean
  selectable: boolean
  onChoose: (submissionId: string) => void
}) {
  const className = winner ? 'submission is-winner' : highlighted ? 'submission is-choice' : 'submission'
  const body = <Prompt text={text} fills={submission.cards} />
  if (!selectable) {
    return (
      <article className={className} aria-label={winner ? `Winning set ${index + 1}` : `Set ${index + 1}`}>
        {body}
      </article>
    )
  }
  return (
    <button
      type="button"
      className={className}
      aria-pressed={highlighted}
      aria-label={`Choose set ${index + 1}`}
      onClick={() => onChoose(submission.id)}
    >
      {body}
    </button>
  )
}

function Prompt({ text, fills }: { text: string; fills?: string[] }) {
  const parts = text.split('_')
  return (
    <p className="prompt">
      {parts.map((part, index) => {
        const blank = index < parts.length - 1
        const fill = fills?.[index]
        return (
          <span key={index}>
            {part}
            {blank && (fill ? <span className="filled">{fill}</span> : <span className="blank" />)}
          </span>
        )
      })}
    </p>
  )
}

function playerName(room: RoomState, id: string, playerId: string): string {
  const index = room.players.findIndex((player) => player.id === id)
  const player: RoomPlayer | undefined = index >= 0 ? room.players[index] : undefined
  if (player && player.nickname !== '') return player.id === playerId ? `${player.nickname} (you)` : player.nickname
  if (id === playerId) return 'You'
  return `Player ${index >= 0 ? index + 1 : room.players.length + 1}`
}
