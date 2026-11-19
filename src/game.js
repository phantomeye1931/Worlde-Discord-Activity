import $ from 'jquery';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { VALID_WORDS } from './words.js';

// Baked in at build time by build.js, not passed by Discord at runtime
const clientId = DISCORD_CLIENT_ID;

const ROWS = 6;
const COLS = 5;
const WIN_MESSAGES = ['Cheater.', 'Magnificent', 'Impressive', 'Splendid', 'Great', 'Phew'];
const RANK = { absent: 0, present: 1, correct: 2 };
const VALID_WORD_SET = new Set(VALID_WORDS);

let answer = null;
let row = 0;
let col = 0;
let gameOver = false;
let won = false;
let accessToken = null;
let instanceId = null;
let guildId = null;
let displayName = null;
let avatarHash = null;
let gameSocket = null;
let pendingSelfState = null; // self_state can arrive before /api/word resolves

const myRows = []; // states only, this is what other players see of my board
const myGuesses = []; // actual words, only ever sent back to rebuild my own board on rejoin

const $streakValues = $('.streak-value');
const $playersList = $('#playersList');
const $loadingScreen = $('#loadingScreen');

const $rows = $('.board-row');
const $message = $('#message');

// Bump this string on every JS edit, if it doesn't match on screen the bundle is stale
$('#versionJs').text('JS v1.2');

function tileAt(r, c) {
  return $rows.eq(r).children().eq(c);
}

function keyAt(letter) {
  return $(`.key[data-key="${letter}"]`);
}

function ordinal(n) {
  return ['', '1st', '2nd', '3rd', '4th', '5th'][n];
}

function setMessage(text) {
  $message.text(text);
}

function shakeRow() {
  const $row = $rows.eq(row);
  $row.addClass('is-shake');
  setTimeout(() => $row.removeClass('is-shake'), 400);
}

function addLetter(letter) {
  if (gameOver || !answer || col >= COLS) return;
  tileAt(row, col)
    .text(letter)
    .addClass('is-filled')
    .attr('aria-label', `${ordinal(col + 1)} letter, ${letter.toUpperCase()}`);
  col++;
  sendBoardUpdate();
}

function removeLetter() {
  if (gameOver || !answer || col <= 0) return;
  col--;
  tileAt(row, col)
    .text('')
    .removeClass('is-filled')
    .attr('aria-label', 'empty');
  sendBoardUpdate();
}

function currentGuess() {
  let guess = '';
  for (let c = 0; c < COLS; c++) guess += tileAt(row, c).text().toLowerCase();
  return guess;
}

function evaluateGuess(guess) {
  const result = new Array(COLS).fill('absent');
  const answerLetters = answer.split('');
  const guessLetters = guess.toUpperCase().split('');

  for (let i = 0; i < COLS; i++) {
    if (guessLetters[i] === answerLetters[i]) {
      result[i] = 'correct';
      answerLetters[i] = null;
      guessLetters[i] = null;
    }
  }

  for (let i = 0; i < COLS; i++) {
    if (guessLetters[i] == null) continue;
    const idx = answerLetters.indexOf(guessLetters[i]);
    if (idx !== -1) {
      result[i] = 'present';
      answerLetters[idx] = null;
    }
  }

  return result;
}

function upgradeKey(letter, state) {
  const $key = keyAt(letter);
  const current = ['correct', 'present', 'absent'].find((s) => $key.hasClass(`is-${s}`));
  if (current && RANK[current] >= RANK[state]) return;
  $key.removeClass('is-absent is-present is-correct').addClass(`is-${state}`);
}

const STAGGER = 150;
const FLIP_DURATION = 500;
const FLIP_HALF = FLIP_DURATION / 2;

function submitGuess() {
  if (gameOver || !answer) return;
  if (col < COLS) {
    shakeRow();
    setMessage('Not enough letters');
    return;
  }

  const activeRow = row;
  const guess = currentGuess();

  if (!VALID_WORD_SET.has(guess)) {
    shakeRow();
    setMessage('Not in word list');
    return;
  }

  const states = evaluateGuess(guess);
  myRows[activeRow] = states;
  myGuesses[activeRow] = guess;
  row++;
  col = 0;

  const isWin = guess.toUpperCase() === answer;
  const isLoss = !isWin && activeRow === ROWS - 1;
  if (isWin || isLoss) {
    gameOver = true;
    won = isWin;
  }

  sendBoardUpdate();

  states.forEach((state, c) => {
    const letter = guess[c];
    const $tile = tileAt(activeRow, c);
    setTimeout(() => {
      $tile.addClass('is-flip');
      setTimeout(() => {
        $tile
          .removeClass('is-filled')
          .addClass(`is-${state}`)
          .attr('aria-label', `${ordinal(c + 1)} letter, ${letter.toUpperCase()}, ${state}`);
        upgradeKey(letter, state);
      }, FLIP_HALF);
      setTimeout(() => $tile.removeClass('is-flip'), FLIP_DURATION);
    }, c * STAGGER);
  });

  const totalDelay = (COLS - 1) * STAGGER + FLIP_DURATION;

  if (isWin) {
    setTimeout(() => setMessage(WIN_MESSAGES[activeRow]), totalDelay);
    reportGameFinished(activeRow + 1, true);
    return;
  }

  if (isLoss) {
    setTimeout(() => setMessage(`Out of guesses! The word was ${answer}.`), totalDelay);
    reportGameFinished(ROWS, false);
    return;
  }

  setMessage('');
}

function handleKey(key) {
  if (key === 'enter') {
    submitGuess();
  } else if (key === 'backspace') {
    removeLetter();
  } else if (/^[a-z]$/.test(key)) {
    addLetter(key);
  }
}

$('.key').on('click', function () {
  handleKey($(this).data('key'));
});

$(document).on('keydown', (event) => {
  if (event.key === 'Enter') {
    handleKey('enter');
  } else if (event.key === 'Backspace') {
    handleKey('backspace');
  } else if (/^[a-zA-Z]$/.test(event.key)) {
    handleKey(event.key.toLowerCase());
  }
});

const $botAvatarButton = $('#botAvatarButton');
const $botSidebar = $('#botSidebar');

function closeBotSidebar() {
  $botSidebar.prop('hidden', true);
  $botAvatarButton.attr('aria-expanded', 'false');
}

$botAvatarButton.on('click', () => {
  const isOpen = !$botSidebar.prop('hidden');
  $botSidebar.prop('hidden', isOpen);
  $botAvatarButton.attr('aria-expanded', String(!isOpen));
});

$(document).on('keydown', (event) => {
  if (event.key === 'Escape') closeBotSidebar();
});

const otherPlayers = new Map(); // discordId -> { $player, $divider }

function buildMiniBoard(rows, typingCol) {
  const $board = $('<div class="player-board" aria-hidden="true"></div>');
  const typingRow = rows.length; // the row they're currently typing into, if any
  for (let r = 0; r < ROWS; r++) {
    const row = rows[r] || [];
    const $row = $('<div class="mini-row"></div>');
    for (let c = 0; c < COLS; c++) {
      const $tile = $('<div class="mini-tile"></div>');
      const state = row[c];
      if (['correct', 'present', 'absent'].includes(state)) {
        $tile.addClass(`is-${state}`);
      } else if (r === typingRow && c < typingCol) {
        $tile.addClass('is-typed'); // filled, but the color is still unknown to everyone else
      }
      $row.append($tile);
    }
    $board.append($row);
  }
  return $board;
}

function renderAvatar($avatar, discordId, name, avatarHash) {
  const letter = (name || '?').charAt(0).toUpperCase();
  if (!avatarHash) {
    $avatar.empty().text(letter);
    return;
  }
  // Low-res is plenty for a 40px circle, no point pulling full-size avatars
  const $img = $('<img alt="" />').attr('src', `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=64`);
  $img.on('error', () => $avatar.empty().text(letter));
  $avatar.empty().append($img);
}

function reorderPlayersList() {
  // Clear all existing players and dividers from the DOM
  $playersList.empty();

  const entries = Array.from(otherPlayers.values());
  entries.sort((a, b) => Number(b.active) - Number(a.active));

  entries.forEach((entry) => $playersList.append(entry.$player));
}

function upsertOtherPlayer(discordId, name, rows, typingCol, avatarHash, active, streak) {
  let entry = otherPlayers.get(discordId);

  if (!entry) { // Compute if empty
    const $player = $('<div class="player"></div>');
    const $topRow = $('<div class="player-info"></div>');
    const $avatar = $('<div class="player-avatar"></div>');
    renderAvatar($avatar, discordId, name, avatarHash);
    const $streak = $('<span class="player-streak"></span>');
    $topRow.append($avatar, $streak);
    $player.append($topRow);

    // Removed $divider from entry object
    entry = { $player, $streak, active: false };
    otherPlayers.set(discordId, entry);
  }

  entry.$streak.text(typeof streak === 'number' ? `\u{1F525}${streak}` : '');
  entry.$player.find('.player-board').remove();
  entry.$player.append(buildMiniBoard(rows, typingCol));
  entry.active = Boolean(active);
  entry.$player.toggleClass('is-active', entry.active);
  reorderPlayersList();
}

function removeOtherPlayer(discordId) {
  const entry = otherPlayers.get(discordId);
  if (!entry) return;
  entry.$player.remove();
  otherPlayers.delete(discordId);
  reorderPlayersList();
}

function sendBoardUpdate() {
  if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) {
    console.log('[gameSocket] skipped board_update, socket not open (readyState:', gameSocket?.readyState, ')');
    return;
  }
  console.log('[gameSocket] sending board_update', { rows: myRows.length, typingCol: col, gameOver, won });
  gameSocket.send(JSON.stringify({
    type: 'board_update',
    payload: { rows: myRows, typingCol: col, guesses: myGuesses, gameOver, won },
  }));
}

function hasProgress(state) {
  return !!state && Array.isArray(state.guesses) && state.guesses.length > 0;
}

// Replays guesses the server remembers from before a rejoin, straight to final state, no animation
function applySelfState(state) {
  state.guesses.forEach((guess, r) => {
    const states = evaluateGuess(guess);
    myRows[r] = states;
    myGuesses[r] = guess;
    states.forEach((state_, c) => {
      const letter = guess[c];
      tileAt(r, c)
        .text(letter)
        .addClass(`is-${state_}`)
        .attr('aria-label', `${ordinal(c + 1)} letter, ${letter.toUpperCase()}, ${state_}`);
      upgradeKey(letter, state_);
    });
  });

  row = state.guesses.length;
  col = 0;
  gameOver = state.gameOver;
  won = state.won;

  if (gameOver) {
    setMessage(won ? WIN_MESSAGES[state.guesses.length - 1] : `Out of guesses! The word was ${answer}.`);
  } else {
    setMessage('');
  }
}

function handleSelfState(state) {
  if (!answer) {
    pendingSelfState = state;
    return;
  }
  if (hasProgress(state)) applySelfState(state);
}

function connectGameSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws/game`;
  console.log('[gameSocket] connecting to', url);
  gameSocket = new WebSocket(url);

  gameSocket.addEventListener('open', () => {
    console.log('[gameSocket] open, sending auth', { instanceId, displayName, hasAvatar: !!avatarHash });
    gameSocket.send(JSON.stringify({ type: 'auth', payload: { accessToken, instanceId, guildId, displayName, avatarHash } }));
  });

  gameSocket.addEventListener('error', (event) => {
    console.error('[gameSocket] error', event);
  });

  gameSocket.addEventListener('message', (event) => {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      console.error('[gameSocket] received non-JSON message', event.data);
      return;
    }

    console.log('[gameSocket] received', envelope.type, envelope.payload);

    if (envelope.type === 'roster') {
      envelope.payload.players.forEach((p) => {
        upsertOtherPlayer(p.discordId, p.displayName, p.rows, p.typingCol, p.avatarHash, p.active, p.streak);
      });
    } else if (envelope.type === 'player_update') {
      const p = envelope.payload;
      upsertOtherPlayer(p.discordId, p.displayName, p.rows, p.typingCol, p.avatarHash, p.active, p.streak);
    } else if (envelope.type === 'player_left') {
      removeOtherPlayer(envelope.payload.discordId);
    } else if (envelope.type === 'self_state') {
      handleSelfState(envelope.payload);
    }
  });

  // Discord Activities can suspend the tab, just reconnect and let roster resync
  gameSocket.addEventListener('close', (event) => {
    console.log('[gameSocket] closed', { code: event.code, reason: event.reason }, 'reconnecting in 3s');
    setTimeout(connectGameSocket, 3000);
  });
}

function reportGameFinished(guesses, finished) {
  fetch('/api/game-finished', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ guesses, finished, rows: myRows }),
  }).catch((err) => console.error('Failed to report finished game', err));
}

function loadStreaks() {
  fetch('/api/streak', { headers: { Authorization: `Bearer ${accessToken}` } })
    .then((res) => res.json())
    .then(({ playerStreak, serverStreak }) => {
      $streakValues.eq(0).text(playerStreak ?? '?');
      $streakValues.eq(1).text(serverStreak ?? '?');
    })
    .catch((err) => {
      console.error('Failed to load streaks', err);
      setMessage(`Error: ${err.message}`);
    });
}

async function main() {
  const discordSdk = new DiscordSDK(clientId);

  await discordSdk.ready();

  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds', 'guilds.members.read', 'rpc.activities.write'],
  });

  const tokenResponse = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  ({ access_token: accessToken } = await tokenResponse.json());

  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  instanceId = discordSdk.instanceId;
  guildId = discordSdk.guildId;
  displayName = auth.user.global_name || auth.user.username;
  avatarHash = auth.user.avatar;

  // The "Playing GLaDOS" headline itself is fixed to the app's registered name, this just adds the line under it
  discordSdk.commands.setActivity({ activity: { type: 0, details: 'Playing Wordle' } })
    .catch((err) => {
      console.error('Failed to set activity presence', err);
      setMessage(`Error: ${err.message}`);
    });

  loadStreaks();
  connectGameSocket();

  setMessage("Loading today's word...");
  const wordResponse = await fetch('/api/word');
  const { word } = await wordResponse.json();
  answer = word.toUpperCase();

  if (hasProgress(pendingSelfState)) {
    applySelfState(pendingSelfState);
  } else {
    setMessage('');
  }
  pendingSelfState = null;

  $loadingScreen.prop('hidden', true);
}

main().catch((err) => {
  console.error('Failed to start game', err);
  setMessage(`Error: ${err.message}`);
  $loadingScreen.prop('hidden', true);
});
