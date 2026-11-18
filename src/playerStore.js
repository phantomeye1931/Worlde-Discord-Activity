import fs from 'fs';
import path from 'path';

const DATA_DIR = 'data';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function filePathFor(date) {
  return path.join(DATA_DIR, `${date}.json`);
}

let currentDate = todayKey();
let players = new Map(); // discordId -> { displayName, avatarHash, streak, rows, guesses, gameOver, won }

// All writes funnel through this single promise chain so concurrent finishes never interleave on disk
let writeQueue = Promise.resolve();

function rollOverIfNewDay() {
  const today = todayKey();
  if (today !== currentDate) {
    console.log(`[playerStore] new day, resetting in-memory store (${currentDate} -> ${today})`);
    currentDate = today;
    players = new Map();
  }
}

export async function loadToday() {
  rollOverIfNewDay();
  const file = filePathFor(currentDate);
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    players = new Map(Object.entries(JSON.parse(raw)));
    console.log(`[playerStore] loaded ${players.size} player record(s) from ${file}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[playerStore] no file for ${currentDate} yet, starting fresh`);
    } else {
      console.error(`[playerStore] failed to load ${file}`, err);
    }
  }
}

async function writeToDisk(date, snapshot) {
  const file = filePathFor(date);
  const tmpFile = `${file}.tmp`;
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(tmpFile, JSON.stringify(snapshot, null, 2));
  await fs.promises.rename(tmpFile, file); // atomic swap, a reader never sees a half-written file
  console.log(`[playerStore] saved ${Object.keys(snapshot).length} player record(s) to ${file}`);
}

// Snapshot is captured synchronously at call time, so a write that executes after a day rollover
// still correctly writes yesterday's data to yesterday's file instead of today's (now-empty) map
function enqueueWrite(date, snapshot) {
  writeQueue = writeQueue.then(() => writeToDisk(date, snapshot)).catch((err) => {
    console.error('[playerStore] write failed', err);
  });
  return writeQueue;
}

export function upsertPlayer(discordId, data) {
  rollOverIfNewDay();
  players.set(discordId, { ...players.get(discordId), ...data, updatedAt: Date.now() });
}

export function saveIfFinished(discordId) {
  rollOverIfNewDay();
  const record = players.get(discordId);
  if (!record?.gameOver) return;
  enqueueWrite(currentDate, Object.fromEntries(players));
}

export function getPlayer(discordId) {
  rollOverIfNewDay();
  return players.get(discordId) ?? null;
}

export function getAllPlayers() {
  rollOverIfNewDay();
  return players;
}
