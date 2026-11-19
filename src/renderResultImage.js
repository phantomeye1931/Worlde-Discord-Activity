import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { getAllPlayersForDate, getPlayer, getWordleNumber } from './playerStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_CSS_PATH = path.join(__dirname, '..', 'public', 'game.css');

const ROWS = 6;
const COLS = 5;
const SPOTLIGHT_MAX_PLAYERS = 4; // up to this many sit side by side as one row of big cards
const TARGET_ASPECT = 16 / 9;

// Extra rules layered on top of game.css for this standalone context, see RESULT_CSS below
const RESULT_CSS = `
.result-page { background: var(--color-bg); color: var(--color-text); display: inline-flex; flex-direction: column; align-items: center; gap: 1.5rem; padding: 2rem; font-family: sans-serif; }
.result-title { margin: 0; font-size: 1.15rem; font-weight: 600; }
.result-grid { display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 1rem; }
.result-grid--row { flex-wrap: nowrap; }
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

function isValidAvatarHash(hash) {
  return typeof hash === 'string' && /^a?_?[0-9a-f]{32}$/i.test(hash);
}

// Mirrors renderAvatar() in game.js: same img-with-letter-fallback, just without jQuery/onerror JS wiring.
// Prefers the member's per-server avatar over their global one, same as Discord's own clients do
function avatarHtml(discordId, displayName, avatarHash, guildId, guildAvatarHash) {
  const letter = escapeHtml((displayName || '?').charAt(0).toUpperCase());

  const src = isValidAvatarHash(guildAvatarHash) && guildId
    ? `https://cdn.discordapp.com/guilds/${escapeHtml(guildId)}/users/${escapeHtml(discordId)}/avatars/${escapeHtml(guildAvatarHash)}.png?size=128`
    : isValidAvatarHash(avatarHash)
      ? `https://cdn.discordapp.com/avatars/${escapeHtml(discordId)}/${escapeHtml(avatarHash)}.png?size=128`
      : null;

  if (!src) {
    return `<div class="player-avatar"><div class="result-avatar-fallback">${letter}</div></div>`;
  }
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

function cardHtml(player, compact, guildId) {
  return `<div class="player result-card${compact ? ' result-card--compact' : ''}">
    ${avatarHtml(player.discordId, player.displayName, player.avatarHash, guildId, player.guildAvatarHash)}
    ${miniBoardHtml(player.rows || [])}
  </div>`;
}

function buildHtml({ wordleNumber, players, compact, guildId }) {
  const gameCss = fs.readFileSync(GAME_CSS_PATH, 'utf8');
  const title = wordleNumber ? `Wordle No. ${wordleNumber}` : 'Wordle';
  const cards = players.map((p) => cardHtml(p, compact, guildId)).join('');
  const gridClass = compact ? 'result-grid' : 'result-grid result-grid--row';

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
  <div class="${gridClass}">${cards}</div>
</div>
</body>
</html>`;
}

// Picks how many grid columns, out of the card/gap/chrome sizes actually measured in the page,
// make the final page closest to TARGET_ASPECT -- better use of the fixed 16:9 frame than a static column count
function pickColumns({ n, cardWidth, cardHeight, gap, chromeW, chromeH }) {
  let best = { columns: n, score: Infinity };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const width = columns * cardWidth + (columns - 1) * gap + chromeW;
    const height = rows * cardHeight + (rows - 1) * gap + chromeH;
    const score = Math.abs(width / height - TARGET_ASPECT);
    if (score < best.score) best = { columns, score };
  }
  return best.columns;
}

async function applyGridColumns(page, n) {
  const { cardWidth, cardHeight, gap, chromeW, chromeH } = await page.evaluate(() => {
    const page_ = document.getElementById('resultPage');
    const grid = document.querySelector('.result-grid');
    const card = document.querySelector('.result-card');
    const pageRect = page_.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      cardWidth: cardRect.width,
      cardHeight: cardRect.height,
      gap: parseFloat(getComputedStyle(grid).gap) || 0,
      chromeW: pageRect.width - gridRect.width,
      chromeH: pageRect.height - gridRect.height,
    };
  });

  const columns = pickColumns({ n, cardWidth, cardHeight, gap, chromeW, chromeH });

  await page.evaluate((maxWidth) => {
    document.querySelector('.result-grid').style.maxWidth = `${maxWidth}px`;
  }, columns * cardWidth + (columns - 1) * gap + 1);
}

async function screenshotCards(wordleNumber, players, guildId) {
  const compact = players.length > SPOTLIGHT_MAX_PLAYERS;
  const html = buildHtml({ wordleNumber, players, compact, guildId });

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Cards are a fixed/intrinsic size regardless of layout, so pick the column count that best
    // fills a 16:9 frame before doing the final pad-to-box pass below
    if (compact) await applyGridColumns(page, players.length);

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

// Lower is better: solved ranked by guess count, then still-playing, then lost last
function playerScore(p) {
  if (p.gameOver && p.won) return p.rows.length;
  if (p.gameOver) return ROWS + 1;
  return ROWS + 0.5;
}

// Renders a shareable results image for every player on the given date (YYYY-MM-DD), like preview.png/preview2.png
export async function renderResultsImage(date, guildId) {
  const [playersMap, wordleNumber] = await Promise.all([
    getAllPlayersForDate(date),
    getWordleNumber(date),
  ]);

  const players = Array.from(playersMap.entries())
    .map(([discordId, record]) => ({ discordId, ...record }))
    .filter((p) => Array.isArray(p.rows) && p.rows.length > 0)
    .sort((a, b) => playerScore(a) - playerScore(b));

  return screenshotCards(wordleNumber, players, guildId);
}

// Renders a single player's results image for today; an all-empty board if they haven't guessed yet,
// using the given fallback displayName/avatarHash/guildAvatarHash since a never-played player has no stored record
export async function renderPlayerImage(discordId, guildId, fallback = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [record, wordleNumber] = await Promise.all([
    getPlayer(discordId),
    getWordleNumber(today),
  ]);

  const player = {
    discordId,
    displayName: record?.displayName ?? fallback.displayName ?? null,
    avatarHash: record?.avatarHash ?? fallback.avatarHash ?? null,
    guildAvatarHash: record?.guildAvatarHash ?? fallback.guildAvatarHash ?? null,
    rows: record?.rows ?? [],
  };

  return screenshotCards(wordleNumber, [player], guildId);
}
