# Results image API

Bot-only endpoints that render a shareable PNG of guess boards, styled like `game.html`. Both require:

```
Authorization: Bearer <WORDLE_WS_TOKEN>
```

## `GET /api/results-image`

Every player who's made at least one guess on a given day.

| Query  | Required | Default | Notes                 |
|--------|----------|---------|------------------------|
| `date` | No       | today   | `YYYY-MM-DD`           |

Layout: ≤2 players renders as big vertical "spotlight" cards, 3+ switches to a compact horizontal grid.

**Responses**
- `200` `image/png`
- `401` missing/invalid token
- `500` render failure

## `GET /api/player-image`

One player's board for today only.

| Query       | Required | Notes       |
|-------------|----------|-------------|
| `discordId` | Yes      |             |

**Responses**
- `200` `image/png`
- `400` missing `discordId`
- `401` missing/invalid token
- `404` player hasn't played today
- `500` render failure
