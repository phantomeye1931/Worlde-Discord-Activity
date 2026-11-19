# Results API

Bot-only endpoints: two render a shareable PNG of guess boards, styled like `game.html` (always exactly 16:9, content centered), and one returns a day's raw results as JSON. All require:

```
Authorization: Bearer <WORDLE_WS_TOKEN or WORDLE_IMAGE_TOKEN>
```

`WORDLE_IMAGE_TOKEN` is read-only: it can't authenticate on `/ws/bot`. Give it to bots (e.g. a beta bot) that need images but must not take over the bot bridge, since the last bot to authenticate there replaces the previous one.

Players are sorted by score: solved players first (fewer guesses ranks higher), then anyone still playing, then anyone who lost.

Avatars prefer the player's per-server avatar over their global one when `guildId` is given and that player has one set.

## `GET /api/results-image`

Every player who's made at least one guess on a given day.

| Query     | Required | Default | Notes         |
|-----------|----------|---------|---------------|
| `date`    | No       | today   | `YYYY-MM-DD`  |
| `guildId` | No       | —       |               |

Layout: ≤4 players renders side by side as big vertical "spotlight" cards; 5+ switches to a compact horizontal-card grid, with the column count picked to best fill the 16:9 frame.

**Responses**
- `200` `image/png`
- `401` missing/invalid token
- `500` render failure

## `GET /api/results`

The raw results for a day, the same records `/api/results-image` draws: every player who's made at least one guess. Guess counts only, never the guessed words.

| Query  | Required | Default | Notes        |
|--------|----------|---------|--------------|
| `date` | No       | today   | `YYYY-MM-DD` |

```json
{
  "date": "2026-11-18",
  "wordleNumber": 1617,
  "players": [
    { "discordId": "123", "displayName": "Name", "guesses": 4, "gameOver": true, "won": true }
  ]
}
```

`wordleNumber` is `null` on days that fell back to a random word. A player with `gameOver: false` is still playing, or closed the game without finishing.

**Responses**
- `200` `application/json`
- `401` missing/invalid token
- `500` read failure

## `GET /api/player-image`

One player's board for today. Always renders — an all-empty board if they haven't guessed yet.

| Query             | Required | Notes                                                        |
|--------------------|----------|---------------------------------------------------------------|
| `discordId`        | Yes      |                                                                 |
| `guildId`          | No       |                                                                 |
| `displayName`      | No       | Fallback only, used when the player has no record for today   |
| `avatarHash`       | No       | Fallback only                                                  |
| `guildAvatarHash`  | No       | Fallback only                                                  |

**Responses**
- `200` `image/png`
- `400` missing `discordId`
- `401` missing/invalid token
- `500` render failure
