import 'dotenv/config';
import express from 'express';
import { ANSWERS } from './src/words.js';
import { initBotBridge, reportGameFinished, requestStreak } from './src/botBridge.js';
import { initGameBridge } from './src/gameBridge.js';
import { loadToday } from './src/playerStore.js';

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

  const { guesses, finished } = req.body;
  reportGameFinished(discordId, guesses, finished);
  res.send({ ok: true });
});

// In case the process restarted mid-day, pick up wherever today's save file left off
await loadToday();

const port = process.env.PORT || 3001;
const httpServer = app.listen(port, () => console.log(`Listening on http://localhost:${port}`));

// Both wss instances are noServer: true, dispatch by path ourselves so they can share this one httpServer
const botWss = initBotBridge();
const gameWss = initGameBridge(resolveDiscordId, requestStreak);

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
