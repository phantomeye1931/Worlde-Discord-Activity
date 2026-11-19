import 'dotenv/config';
import express from 'express';
import { ANSWERS } from './src/words.js';
import { initBotBridge, reportGameFinished, requestStreak } from './src/botBridge.js';
import { initGameBridge } from './src/gameBridge.js';
import { loadToday, setWordleNumber } from './src/playerStore.js';
import { renderResultsImage, renderPlayerImage } from './src/renderResultImage.js';

const app = express();
app.use(express.json());
// The Activity always opens the root URL, serve the game there instead of looking for index.html
app.use(express.static('public', { index: 'game.html' }));

// Resolving a Discord access_token to a user id via Discord's API on every call would get rate-limited fast
const discordIdCache = new Map(); // access_token -> { discordId, expiresAt }
const DISCORD_ID_CACHE_MS = 5 * 60 * 1000;

// Never trust a client-supplied discord id, it's trivially spoofable and would let one player corrupt another's streak
async function resolveDiscordId(accessToken) {
  const cached = discordIdCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) return cached.discordId;

  const response = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;

  const { id } = await response.json();
  discordIdCache.set(accessToken, { discordId: id, expiresAt: Date.now() + DISCORD_ID_CACHE_MS });
  return id;
}

// A guild-specific avatar, null if the member has none set (falls back to their global avatar elsewhere)
async function resolveGuildAvatar(accessToken, guildId) {
  try {
    const response = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;

    const member = await response.json();
    return typeof member.avatar === 'string' ? member.avatar : null;
  } catch (err) {
    console.error('Failed to resolve guild avatar', err);
    return null;
  }
}

function bearerToken(req) {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Exchange the OAuth2 code the frontend got from Discord for an access token
app.post('/api/token', async (req, res) => {
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: req.body.code,
    }),
  });

  const data = await response.json();
  res.send({ access_token: data.access_token });
});

// Today's official NYT Wordle solution, with a random fallback if NYT is unreachable
app.get('/api/word', async (req, res) => {
  const date = new Date().toISOString().slice(0, 10);

  try {
    const response = await fetch(`https://www.nytimes.com/svc/wordle/v2/${date}.json`);
    if (!response.ok) throw new Error(`NYT responded with ${response.status}`);
    const data = await response.json();
    if (typeof data.days_since_launch === 'number') {
      void setWordleNumber(date, data.days_since_launch);
    }
    res.send({ word: data.solution.toUpperCase() });
  } catch (err) {
    console.error('Failed to fetch NYT Wordle word, falling back to random', err);
    const word = ANSWERS[Math.floor(Math.random() * ANSWERS.length)].toUpperCase();
    res.send({ word });
  }
});

// Your streak + the server's streak, shown when a player's game page loads
app.get('/api/streak', async (req, res) => {
  const discordId = await resolveDiscordId(bearerToken(req) ?? '');
  if (!discordId) return res.status(401).send({ error: 'Invalid or missing access token' });

  const streak = await requestStreak(discordId);
  res.send(streak ?? { playerStreak: null, serverStreak: null });
});

// Reports a finished game to the bot; fire-and-forget, the browser doesn't wait on bot delivery
app.post('/api/game-finished', async (req, res) => {
  const discordId = await resolveDiscordId(bearerToken(req) ?? '');
  if (!discordId) return res.status(401).send({ error: 'Invalid or missing access token' });

  const { guesses, finished, rows } = req.body;
  reportGameFinished(discordId, guesses, finished, rows);
  res.send({ ok: true });
});

// Image endpoints accept the bot bridge token, or WORDLE_IMAGE_TOKEN: an image-only token for e.g. a beta bot,
// which must not get the bridge token since the last bot to authenticate on /ws/bot takes over the bridge
function isImageAuthorized(req) {
  const token = bearerToken(req);
  if (!token) return false;
  return [process.env.WORDLE_WS_TOKEN, process.env.WORDLE_IMAGE_TOKEN].some((t) => t && t === token);
}

// Bot-only: renders a shareable results image (see preview.png/preview2.png) for a given day
app.get('/api/results-image', async (req, res) => {
  if (!isImageAuthorized(req)) {
    return res.status(401).send({ error: 'Invalid or missing token' });
  }

  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : null;

  try {
    const png = await renderResultsImage(date, guildId);
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error('Failed to render results image', err);
    res.status(500).send({ error: 'Failed to render image' });
  }
});

// Bot-only: renders a single player's results image for today, blank board if they haven't guessed yet.
// displayName/avatarHash are only used as a fallback, when the player has no record for today at all
app.get('/api/player-image', async (req, res) => {
  if (!isImageAuthorized(req)) {
    return res.status(401).send({ error: 'Invalid or missing token' });
  }

  const discordId = typeof req.query.discordId === 'string' ? req.query.discordId : null;
  if (!discordId) return res.status(400).send({ error: 'Missing discordId' });
  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : null;

  try {
    const png = await renderPlayerImage(discordId, guildId, {
      displayName: typeof req.query.displayName === 'string' ? req.query.displayName : null,
      avatarHash: typeof req.query.avatarHash === 'string' ? req.query.avatarHash : null,
      guildAvatarHash: typeof req.query.guildAvatarHash === 'string' ? req.query.guildAvatarHash : null,
    });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error('Failed to render player image', err);
    res.status(500).send({ error: 'Failed to render image' });
  }
});

// In case the process restarted mid-day, pick up wherever today's save file left off
await loadToday();

const port = process.env.PORT || 3001;
const httpServer = app.listen(port, () => console.log(`Listening on http://localhost:${port}`));

// Both wss instances are noServer: true, dispatch by path ourselves so they can share this one httpServer
const botWss = initBotBridge();
const gameWss = initGameBridge(resolveDiscordId, requestStreak, resolveGuildAvatar);

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/ws/bot') {
    botWss.handleUpgrade(req, socket, head, (ws) => botWss.emit('connection', ws, req));
  } else if (pathname === '/ws/game') {
    gameWss.handleUpgrade(req, socket, head, (ws) => gameWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
