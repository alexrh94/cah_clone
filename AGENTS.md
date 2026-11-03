This repo is a personal online version of Cards Against Humanity. Black cards are prompts. Each `_` is one blank, including underscores that sit next to each other, and every black card must contain at least one. Players fill those blanks from a hand of white cards. One player is the Card Tzar and chooses the winning set. The first player to the room's score limit wins, and the room returns to the pregame lobby.

Players join a room with a four-letter code such as `ABCD`. The host picks the decks and the score limit.

## Architecture

The repo is one npm package at the root (`"type": "module"`). It needs Node.js 22.12 or newer. The client is built locally with Vite and the Node.js server serves that build. The client and server have separate TypeScript configs, so do not import server modules into the client. Deck validation is duplicated in `server/src/deck.ts` and `client/src/deck.ts` and the two copies must stay in step.

- `client/` is the React and TypeScript UI. Vite's root is this directory (`client/vite.config.ts`), and `npm run build` writes the production files to `dist/client`. The dev server listens on port 5173 and proxies `/ws` to `http://localhost:3000`. `App.tsx` is the home screen and the pregame room. `GameView.tsx` is the table. `useGameServer.ts` owns the WebSocket.
- `server/` is the Node.js HTTP and WebSocket server, using the `ws` package. `server/src/index.ts` serves `dist/client`, reads `decks/`, and listens on `PORT`, which defaults to 3000.
  - `server.ts` creates the HTTP server and a WebSocket server on `/ws`. It turns socket messages into room and game changes and is the only place that knows which socket belongs to which player. A dropped socket keeps that player's seat for 10 seconds.
  - `static.ts` resolves client files inside the build directory, blocks paths that escape it, and falls back to `index.html` for application routes such as `/room/ABCD`.
  - `deck.ts` validates a deck object, loads one from disk, lists the decks in a directory, and concatenates selected decks. A deck needs a name, at least one black card, and at least one white card. Black and white cards are strings. A black card with no `_` is invalid. The pick count is the number of `_` characters. `listDecks` uses each `*.json` file name without the extension as the id (`sample.json` becomes `sample`) and the deck's own name as the label, and includes `blackCount` and `whiteCount`. A non-JSON file is ignored. An invalid built-in deck is left off the list and reported to the client.
  - `roomCode.ts` generates and checks room codes made of four uppercase letters. The server generates the code when a room is created and skips codes that are already taken, including rooms waiting out their empty-room grace period.
  - `rooms.ts` keeps membership, the selected deck ids, the score limit, and custom decks uploaded into that room. Nicknames live on the socket in `server.ts`, not in the room store.
  - `game.ts` deals hands, collects submissions, reveals them without player ids, awards a point, recycles played white cards to the bottom of the white deck, and rotates the Card Tzar.
- `decks/` holds the built-in JSON decks. `decks/sample.json` is the original sample deck of 10 black cards and 40 white cards. Deck files are not served as static HTTP files. The client only hears about them over the socket. Custom uploads are not written into this directory.

## Rooms

The home screen has a nickname box above the room code. Both are optional to start: an empty nickname is allowed, and Join is what checks the code. Creating a room or joining one sends the current nickname. The client stores it in `sessionStorage` under `cah-nickname`. The server trims it, collapses whitespace, strips control characters, and keeps at most 24 characters. Duplicate nicknames are allowed. On the room screen a blank name is shown as "You" or "Player N"; a set name is shown as typed, with "(you)" on your own row and ", host" on the host.

The player who creates the room is the host. Only the host can choose decks, set the score limit, upload a deck, or start. The score limit is a whole number from 1 to 20 and starts at 7. A game needs at least three players. The host can select any number of built-in and uploaded decks. A new upload shows up in that list and stays unselected until the host turns it on.

A player is in at most one room: creating or joining another room removes them from the previous one and tells whoever is left. If the host leaves, the next player in join order becomes host. When the last player leaves, the room stays open for 15 seconds. After that the room, including any uploaded decks, is deleted.

The browser address is `/room/` plus the code. The socket client joins that code on connect, using the stored nickname. The client stores the player id in `sessionStorage` under `cah-player-id`. Both Vite and the static server serve `index.html` for that path. A refresh of that path sends `resume` with the stored id. The server keeps the dropped seat, including that player's hand and the current turn, for 10 seconds so the refresh can reclaim it. Closing the tab does not resume, and the seat is removed when that window ends. An explicit leave removes the seat immediately. Joining as a new player is rejected while a game is in progress.

## Decks

```json
{
  "name": "Sample",
  "black": ["My plan for the weekend: _.", "_ + _ = _."],
  "white": ["A disappointing birthday party."]
}
```

Every `_` is one blank. `__` needs two white cards. A black card with no underscore is rejected with `{ "type": "error", "message": "Black card must contain at least one underscore.", "cards": ["..."] }`. `cards` lists the exact offending strings. The client highlights them. The same check runs in the browser before upload. Uploaded decks are kept only in that room, under an id shaped like `custom:<uuid>`, and are capped at 500 black cards, 2000 white cards, and a 512 KB message.

At the start of a game the selected decks are concatenated, including cards whose text matches another deck, and everyone is dealt the same hand of 10. Starting requires at least 10 white cards for every player in the room, and black cards equal to at least 20% of that white minimum, rounded up. Five players need 50 white cards and 10 black cards. A shorter selection is refused. The Card Tzar counts as a player. `requiredCards` in `server/src/game.ts` and `client/src/deck.ts` must stay in step.

## Play

The Card Tzar starts as the host and moves to the next player in join order after each round. The Tzar does not play a white card. Everyone else submits exactly `pick` cards from their hand, in the order that fills the blanks from left to right. Submissions stay hidden until everyone has chosen, then they are shuffled and sent as `{ "id", "cards" }` with no player id. The Tzar selects a set on their own screen, then confirms it. Until then nobody else sees a highlight. Confirming awards the point, shows that set to everyone, and names the winner. The highlighted set bounces until the Tzar starts the next turn. Played white cards then go to the bottom of the white deck, hands are drawn back to size, and the used black card is discarded. An empty black deck is rebuilt by shuffling the discards. If the score limit was reached, the next turn ends the game instead.

When a score reaches the limit, the game state is cleared and a `notice` names the winner. The room keeps its decks and score limit. Scores start at zero on the next game. The host can return everyone to that pregame lobby from the scoreboard. That clears the game and keeps the players in the room. If a player leaves and fewer than three remain, the game returns to the lobby. Their hand and any submission go to the bottom of the white deck.

## WebSocket messages

A new socket receives `{ "type": "connected", "playerId": "..." }` and then `{ "type": "decks", "decks": [{ "id": "sample", "name": "Sample", "blackCount": 10, "whiteCount": 40 }] }`. A bad built-in deck also produces the underscore `error`. Custom deck summaries use the same `blackCount` and `whiteCount` fields. A resumed connection receives `connected` again with the original player id, then the current room and, when a game is running, that player's game view.

Client messages:

| Message | Meaning |
| --- | --- |
| `{ "type": "create_room", "nickname": "Alex" }` | Open a room. The server picks the code. |
| `{ "type": "join_room", "code": "ABCD", "nickname": "Sam" }` | Join a room. The code is trimmed and uppercased. |
| `{ "type": "resume", "playerId": "...", "code": "ABCD", "nickname": "Sam" }` | Reclaim a dropped seat. The id must still be in that room. |
| `{ "type": "select_decks", "deckIds": ["sample"] }` | Host replaces the selected decks. An empty list clears the selection. |
| `{ "type": "set_score_limit", "scoreLimit": 7 }` | Host sets the winning score. |
| `{ "type": "upload_deck", "deck": { "name", "black", "white" } }` | Host uploads a custom deck for this room. |
| `{ "type": "start_game" }` | Host deals the combined selected decks when they meet the card minimum. |
| `{ "type": "submit_cards", "cardIds": ["c1"] }` | A non-Tzar locks in that many cards, in blank order. |
| `{ "type": "confirm_winner", "submissionId": "s1" }` | The Card Tzar locks that set in, awards the point, and shows the winner to everyone. |
| `{ "type": "next_turn" }` | The Card Tzar starts the next round, or ends the game at the score limit. |
| `{ "type": "return_to_lobby" }` | Host ends the current game and returns the room to the pregame lobby. |
| `{ "type": "leave_room" }` | Leave the current room. |

A room update is `{ "type": "room", "code", "deckIds", "scoreLimit", "hostId", "playerIds", "players", "customDecks" }`. A game update is `{ "type": "game", ... }` and is different for each player: it includes that player's hand and, while judging or revealing, the anonymous submissions. `highlightedId` stays null until the Card Tzar confirms, then every player sees the winning set. Failures are `{ "type": "error", "message": "..." }`. The underscore failure also includes `cards`. `{ "type": "notice", "message": "..." }` clears the table and is how a finished game sends everyone back to the lobby.

## Tests

Unit tests cover server logic only. They live beside the server modules as `server/src/*.test.ts` and run with `node:test` through `tsx`. Test every server function with at least one test. `npm test` lists those files explicitly, so a new test file has to be added to the `test` script in `package.json`. The valid-deck tests load `decks/sample.json`.

## Commands

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev:client` | Vite dev server on port 5173, proxying `/ws` to the game server |
| `npm run dev:server` | Game server with reload, on port 3000 |
| `npm run build` | Typecheck and compile the client into `dist/client` |
| `npm run build:client` | Same as `npm run build` |
| `npm start` | Serve the built client over HTTP and WebSocket |
| `npm test` | Server unit tests |
| `npm run typecheck` | Typecheck the client and the server without emitting files |
