import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

const ACK_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 3000;

let bot = null;
const pending = new Map(); // id -> { resolve, reject }
const queue = []; // envelopes awaiting an ack
let draining = false;

function send(envelope) {
  if (!bot || bot.readyState !== bot.OPEN) return false;
  bot.send(JSON.stringify(envelope));
  return true;
}

async function drainQueue() {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const envelope = queue[0];

    const delivered = await new Promise((resolve) => {
      if (!send(envelope)) return resolve(false);

      const timeout = setTimeout(() => {
        pending.delete(envelope.id);
        resolve(false);
      }, ACK_TIMEOUT_MS);

      pending.set(envelope.id, {
        resolve: () => { clearTimeout(timeout); resolve(true); },
        reject: () => { clearTimeout(timeout); resolve(false); },
      });
    });

    if (delivered) {
      queue.shift();
    } else {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  draining = false;
}

function handleMessage(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }

  if (envelope.type === 'streak_data' || envelope.type === 'ack') {
    const waiter = pending.get(envelope.id);
    if (!waiter) return;
    pending.delete(envelope.id);
    waiter.resolve(envelope.payload);
  }
}

// noServer: a {server, path} instance would abort any upgrade whose path doesn't match its own,
// which kills other WebSocketServers sharing this httpServer before they ever see the request
export function initBotBridge() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    let authed = false;

    const authTimeout = setTimeout(() => {
      if (!authed) ws.close(4001, 'unauthorized');
    }, 5000);

    ws.once('message', (raw) => {
      clearTimeout(authTimeout);
      try {
        const envelope = JSON.parse(raw);
        if (envelope.type === 'auth' && envelope.payload?.token === process.env.WORDLE_WS_TOKEN) {
          authed = true;
          bot = ws;
          console.log('Bot connected to wordle bridge');
          void drainQueue();
        } else {
          ws.close(4001, 'unauthorized');
        }
      } catch {
        ws.close(4001, 'unauthorized');
      }
    });

    ws.on('message', (raw) => {
      if (authed) handleMessage(raw);
    });

    ws.on('close', () => {
      if (bot === ws) bot = null;
    });
  });

  return wss;
}

export function requestStreak(discordId) {
  const id = randomUUID();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, {
      resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
      reject: () => { clearTimeout(timeout); resolve(null); },
    });

    if (!send({ id, type: 'get_streak', payload: { discordId } })) {
      clearTimeout(timeout);
      pending.delete(id);
      resolve(null);
    }
  });
}

export function reportGameFinished(discordId, guesses, finished) {
  queue.push({ id: randomUUID(), type: 'game_finished', payload: { discordId, guesses, finished } });
  void drainQueue();
}
