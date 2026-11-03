import { useEffect, useState } from 'react'
import type { PublicSubmission, RoomPlayer, RoomState, TableState } from './useGameServer'

export function GameView({
  room,
  playerId,
  table,
  notice,
  onSubmit,
  onHighlight,
  onConfirm,
  onNextTurn,
  onLeave,
}: {
  room: RoomState
  playerId: string
  table: TableState
  notice: string
  onSubmit: (cardIds: string[]) => boolean
  onHighlight: (submissionId: string) => boolean
  onConfirm: () => boolean
  onNextTurn: () => boolean
  onLeave: () => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const isTzar = table.tzarId === playerId
  const readyToPlay = selected.length === table.black.pick
  const winner = table.lastWinnerId ? playerName(room, table.lastWinnerId, playerId) : null
  const showHand = !isTzar && table.phase === 'picking' && !table.submitted

  useEffect(() => {
    setSelected([])
  }, [table.black.text, table.phase])

  function toggle(cardId: string) {
    setSelected((current) => {
      if (current.includes(cardId)) return current.filter((id) => id !== cardId)
      if (current.length >= table.black.pick) return current
      return [...current, cardId]
    })
  }

  return (
    <div className="table-screen">
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
        <button type="button" className="leave" onClick={onLeave}>
          Leave
        </button>
      </aside>

      <section className="stage">
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
                highlighted={submission.id === table.highlightedId}
                selectable={isTzar && table.phase === 'judging'}
                onHighlight={onHighlight}
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

      <section className="hand-bar" aria-label="Your hand">
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
            <button type="button" className="confirm" disabled={table.highlightedId === null} onClick={() => onConfirm()}>
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
  selectable,
  onHighlight,
}: {
  submission: PublicSubmission
  index: number
  text: string
  highlighted: boolean
  selectable: boolean
  onHighlight: (submissionId: string) => boolean
}) {
  const className = highlighted ? 'submission is-winner' : 'submission'
  const body = <Prompt text={text} fills={submission.cards} />
  if (!selectable) {
    return (
      <article className={className} aria-label={highlighted ? `Winning set ${index + 1}` : `Set ${index + 1}`}>
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
      onClick={() => onHighlight(submission.id)}
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
