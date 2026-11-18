import { WebSocketServer } from 'ws';
import { getPlayer, upsertPlayer, saveIfFinished, getAllPlayers } from './playerStore.js';

const STATES = ['correct', 'present', 'absent'];
const ROWS = 6;
const COLS = 5;

const rooms = new Map(); // instanceId -> Map<discordId, { ws, displayName, avatarHash, streak, rows, typingCol }>

// Guess colors only, never letters, this is what gets shown in everyone else's sidebar
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, ROWS).map((row) =>
    Array.isArray(row) ? row.slice(0, COLS).map((state) => (STATES.includes(state) ? state : null)) : []
  );
}

// Actual guessed words, only ever sent back to the player who made them, to rebuild their own board
function sanitizeGuesses(guesses) {
  if (!Array.isArray(guesses)) return [];
  return guesses
    .slice(0, ROWS)
    .map((g) => (typeof g === 'string' ? g.toLowerCase() : ''))
    .filter((g) => new RegExp(`^[a-z]{${COLS}}$`).test(g));
}

// How many letters are filled in the row being typed right now, never which letters
function sanitizeTypingCol(typingCol) {
  const n = Number(typingCol);
  return Number.isInteger(n) && n >= 0 && n <= COLS ? n : 0;
}

// Discord avatar hashes are a 32-char hex string, optionally "a_"-prefixed for animated ones
function sanitizeAvatarHash(hash) {
  return typeof hash === 'string' && /^a?_?[0-9a-f]{32}$/i.test(hash) ? hash : null;
}

function broadcast(instanceId, message, exceptWs) {
  const room = rooms.get(instanceId);
  if (!room) return;
  const data = JSON.stringify(message);
  let sent = 0;
  for (const player of room.values()) {
    if (player.ws !== exceptWs && player.ws.readyState === player.ws.OPEN) {
      player.ws.send(data);
      sent++;
    }
  }
  console.log(`[gameBridge] broadcast ${message.type} in room ${instanceId} -> ${sent} other client(s)`);
}

// Everyone currently connected to this room, plus everyone who's played today but isn't connected right now
function rosterPayload(instanceId, exceptDiscordId) {
  const room = rooms.get(instanceId);
  const seen = new Set([exceptDiscordId]);
  const players = [];

  if (room) {
    for (const [discordId, player] of room) {
      if (seen.has(discordId)) continue;
      seen.add(discordId);
      players.push({
        discordId,
        displayName: player.displayName,
        avatarHash: player.avatarHash,
        streak: player.streak,
        rows: player.rows,
        typingCol: player.typingCol,
        active: true,
      });
    }
  }

  for (const [discordId, record] of getAllPlayers()) {
    if (seen.has(discordId)) continue;
    seen.add(discordId);
    players.push({
      discordId,
      displayName: record.displayName,
      avatarHash: record.avatarHash,
      streak: record.streak,
      rows: record.rows ?? [],
      typingCol: 0,
      active: false,
    });
  }

  return players;
}

// noServer, dispatched manually in server.js alongside the bot bridge's wss, see botBridge.js for why
export function initGameBridge(resolveDiscordId, requestStreak) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    let discordId = null;
    let instanceId = null;

    console.log('[gameBridge] connection opened, awaiting auth');

    const authTimeout = setTimeout(() => {
      if (!discordId) {
        console.log('[gameBridge] auth timed out after 5s, closing');
        ws.close(4001, 'unauthorized');
      }
    }, 5000);

    ws.on('message', async (raw) => {
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        console.log('[gameBridge] received non-JSON message, ignoring');
        return;
      }

      if (envelope.type === 'auth' && !discordId) {
        const resolvedId = await resolveDiscordId(envelope.payload?.accessToken ?? '');
        const requestedInstanceId = envelope.payload?.instanceId;

        if (!resolvedId) {
          console.log('[gameBridge] auth rejected: could not resolve discord id from access token');
          ws.close(4001, 'unauthorized');
          return;
        }
        if (typeof requestedInstanceId !== 'string' || !requestedInstanceId) {
          console.log(`[gameBridge] auth rejected for ${resolvedId}: missing/invalid instanceId (${JSON.stringify(requestedInstanceId)})`);
          ws.close(4001, 'unauthorized');
          return;
        }

        clearTimeout(authTimeout);
        discordId = resolvedId;
        instanceId = requestedInstanceId;
        const displayName = String(envelope.payload?.displayName ?? '?').slice(0, 32);
        const avatarHash = sanitizeAvatarHash(envelope.payload?.avatarHash);

        const streakData = await requestStreak(discordId);
        const streak = typeof streakData?.playerStreak === 'number' ? streakData.playerStreak : null;

        // Rejoining mid-day: pick up exactly where this player left off, so their board isn't reset
        const persisted = getPlayer(discordId);
        const rows = persisted?.rows ?? [];
        const guesses = persisted?.guesses ?? [];
        const gameOver = persisted?.gameOver ?? false;
        const won = persisted?.won ?? false;

        if (!rooms.has(instanceId)) rooms.set(instanceId, new Map());
        rooms.get(instanceId).set(discordId, { ws, displayName, avatarHash, streak, rows, typingCol: 0, gameOver });

        console.log(`[gameBridge] ${discordId} (${displayName}) joined room ${instanceId}, now ${rooms.get(instanceId).size} player(s) in room, restored ${rows.length} row(s)`);

        // Only this client gets the actual letters, needed to rebuild its own board, never broadcast
        ws.send(JSON.stringify({ type: 'self_state', payload: { guesses, gameOver, won } }));
        ws.send(JSON.stringify({ type: 'roster', payload: { players: rosterPayload(instanceId, discordId) } }));
        broadcast(instanceId, {
          type: 'player_update',
          payload: { discordId, displayName, avatarHash, streak, rows, typingCol: 0, active: true },
        }, ws);
        return;
      }

      if (envelope.type === 'board_update' && discordId) {
        const player = rooms.get(instanceId)?.get(discordId);
        if (!player) {
          console.log(`[gameBridge] board_update from ${discordId} but no player record in room ${instanceId}`);
          return;
        }

        // Already solved (or lost) today, a client replaying/resubmitting a new guess can't overwrite that
        if (player.gameOver) {
          console.log(`[gameBridge] ignoring board_update from ${discordId}, already finished today`);
          return;
        }

        player.rows = sanitizeRows(envelope.payload?.rows);
        player.typingCol = sanitizeTypingCol(envelope.payload?.typingCol);
        const gameOver = Boolean(envelope.payload?.gameOver);
        const won = Boolean(envelope.payload?.won);
        const guesses = sanitizeGuesses(envelope.payload?.guesses);

        console.log(`[gameBridge] board_update from ${discordId}: ${player.rows.length} completed row(s), typingCol=${player.typingCol}, gameOver=${gameOver}`);

        player.gameOver = gameOver; // locks out any further board_update for the rest of today

        if (player.rows.length > 0) {
          upsertPlayer(discordId, {
            displayName: player.displayName,
            avatarHash: player.avatarHash,
            streak: player.streak,
            rows: player.rows,
            guesses,
            gameOver,
            won,
          });
          if (gameOver) saveIfFinished(discordId);
        }

        broadcast(instanceId, {
          type: 'player_update',
          payload: {
            discordId,
            displayName: player.displayName,
            avatarHash: player.avatarHash,
            streak: player.streak,
            rows: player.rows,
            typingCol: player.typingCol,
            active: true,
          },
        }, ws);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (!discordId || !instanceId) {
        console.log('[gameBridge] connection closed before auth completed');
        return;
      }
      const room = rooms.get(instanceId);
      if (!room) return;
      room.delete(discordId);
      if (room.size === 0) rooms.delete(instanceId);
      console.log(`[gameBridge] ${discordId} left room ${instanceId}`);

      // Played at least one row today: keep them visible, just mark offline instead of removing
      const persisted = getPlayer(discordId);
      if (persisted && persisted.rows?.length > 0) {
        broadcast(instanceId, {
          type: 'player_update',
          payload: {
            discordId,
            displayName: persisted.displayName,
            avatarHash: persisted.avatarHash,
            streak: persisted.streak,
            rows: persisted.rows,
            typingCol: 0,
            active: false,
          },
        }, ws);
      } else {
        broadcast(instanceId, { type: 'player_left', payload: { discordId } }, ws);
      }
    });
  });

  return wss;
}
