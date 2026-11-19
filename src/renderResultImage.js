import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { getAllPlayersForDate, getPlayer, getWordleNumber } from './playerStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_CSS_PATH = path.join(__dirname, '..', 'public', 'game.css');

const ROWS = 6;
const COLS = 5;
const SPOTLIGHT_MAX_PLAYERS = 2; // above this we switch to the compact horizontal-card grid

// Extra rules layered on top of game.css for this standalone context, see RESULT_CSS below
const RESULT_CSS = `
.result-page { background: var(--color-bg); color: var(--color-text); display: inline-flex; flex-direction: column; align-items: center; gap: 1.5rem; padding: 2rem; font-family: sans-serif; }
.result-title { margin: 0; font-size: 1.15rem; font-weight: 600; }
.result-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 1rem; }
.result-grid--compact { max-width: 580px; }
.player.result-card { width: 170px; padding: 1rem; }
.player.result-card .player-avatar { width: 64px; height: 64px; font-size: 1.4rem; }
.player.result-card--compact { flex-direction: row; align-items: center; justify-content: flex-start; width: 230px; gap: 0.75rem; }
.player.result-card--compact .player-avatar { width: 44px; height: 44px; font-size: 1rem; flex-shrink: 0; }
.player.result-card--compact .player-board { width: 130px; }
.result-avatar-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--color-avatar-text); }
`;

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.connected) return browser;
  }
  browserPromise = puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  return browserPromise;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Mirrors renderAvatar() in game.js: same img-with-letter-fallback, just without jQuery/onerror JS wiring
function avatarHtml(discordId, displayName, avatarHash) {
  const letter = escapeHtml((displayName || '?').charAt(0).toUpperCase());
  if (!avatarHash) {
    return `<div class="player-avatar"><div class="result-avatar-fallback">${letter}</div></div>`;
  }
  const src = `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=128`;
  return `<div class="player-avatar">
    <img src="${src}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <div class="result-avatar-fallback" style="display:none">${letter}</div>
  </div>`;
}

// Mirrors buildMiniBoard() in game.js, minus typingCol since that's never persisted to playerStore
function miniBoardHtml(rows) {
  let html = '<div class="player-board" aria-hidden="true">';
  for (let r = 0; r < ROWS; r++) {
    const row = rows[r] || [];
    html += '<div class="mini-row">';
    for (let c = 0; c < COLS; c++) {
      const state = row[c];
      const cls = ['correct', 'present', 'absent'].includes(state) ? ` is-${state}` : '';
      html += `<div class="mini-tile${cls}"></div>`;
    }
    html += '</div>';
  }
  return `${html}</div>`;
}

function cardHtml(player, compact) {
  return `<div class="player result-card${compact ? ' result-card--compact' : ''}">
    ${avatarHtml(player.discordId, player.displayName, player.avatarHash)}
    ${miniBoardHtml(player.rows || [])}
  </div>`;
}

function buildHtml({ wordleNumber, players, compact }) {
  const gameCss = fs.readFileSync(GAME_CSS_PATH, 'utf8');
  const title = wordleNumber ? `Wordle No. ${wordleNumber}` : 'Wordle';
  const cards = players.map((p) => cardHtml(p, compact)).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${gameCss}
${RESULT_CSS}</style>
</head>
<body>
<div id="resultPage" class="result-page">
  <h1 class="result-title">${escapeHtml(title)}</h1>
  <div class="result-grid${compact ? ' result-grid--compact' : ''}">${cards}</div>
</div>
</body>
</html>`;
}

async function screenshotCards(wordleNumber, players) {
  const compact = players.length > SPOTLIGHT_MAX_PLAYERS;
  const html = buildHtml({ wordleNumber, players, compact });

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Pad the page out to an exact 16:9 box (width a multiple of 16) with the content centered,
    // so Discord embeds always get the same shape regardless of player count
    await page.evaluate(() => {
      const el = document.getElementById('resultPage');
      const { width, height } = el.getBoundingClientRect();
      const targetWidth = Math.ceil(Math.max(width, (height * 16) / 9) / 16) * 16;
      el.style.boxSizing = 'border-box';
      el.style.width = `${targetWidth}px`;
      el.style.height = `${(targetWidth / 16) * 9}px`;
      el.style.justifyContent = 'center';
    });
    const element = await page.$('#resultPage');
    return await element.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}

// Renders a shareable results image for every player on the given date (YYYY-MM-DD), like preview.png/preview2.png
export async function renderResultsImage(date) {
  const [playersMap, wordleNumber] = await Promise.all([
    getAllPlayersForDate(date),
    getWordleNumber(date),
  ]);

  const players = Array.from(playersMap.entries())
    .map(([discordId, record]) => ({ discordId, ...record }))
    .filter((p) => Array.isArray(p.rows) && p.rows.length > 0)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));

  return screenshotCards(wordleNumber, players);
}

// Renders a single player's results image for today, or null if they haven't played yet
export async function renderPlayerImage(discordId) {
  const today = new Date().toISOString().slice(0, 10);
  const [record, wordleNumber] = await Promise.all([
    getPlayer(discordId),
    getWordleNumber(today),
  ]);

  if (!record || !Array.isArray(record.rows) || record.rows.length === 0) return null;

  return screenshotCards(wordleNumber, [{ discordId, ...record }]);
}
