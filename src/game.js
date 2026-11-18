import $ from 'jquery';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { VALID_WORDS } from './words.js';

// Baked in at build time by build.js, not passed by Discord at runtime
const clientId = DISCORD_CLIENT_ID;

const ROWS = 6;
const COLS = 5;
const RANK = { absent: 0, present: 1, correct: 2 };
const VALID_WORD_SET = new Set(VALID_WORDS);

let answer = null;
let row = 0;
let col = 0;
let gameOver = false;
let accessToken = null;

const $streakValues = $('.streak-value');

const $rows = $('.board-row');
const $message = $('#message');

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
}

function removeLetter() {
  if (gameOver || !answer || col <= 0) return;
  col--;
  tileAt(row, col)
    .text('')
    .removeClass('is-filled')
    .attr('aria-label', 'empty');
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

  if (guess.toUpperCase() === answer) {
    gameOver = true;
    setTimeout(() => setMessage('You win!'), totalDelay);
    reportGameFinished(activeRow + 1, true);
    return;
  }

  if (activeRow === ROWS - 1) {
    gameOver = true;
    setTimeout(() => setMessage(`Out of guesses! The word was ${answer}.`), totalDelay);
    reportGameFinished(ROWS, false);
    return;
  }

  row++;
  col = 0;
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

function reportGameFinished(guesses, finished) {
  fetch('/api/game-finished', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ guesses, finished }),
  }).catch((err) => console.error('Failed to report finished game', err));
}

function loadStreaks() {
  fetch('/api/streak', { headers: { Authorization: `Bearer ${accessToken}` } })
    .then((res) => res.json())
    .then(({ playerStreak, serverStreak }) => {
      $streakValues.eq(0).text(playerStreak ?? '?');
      $streakValues.eq(1).text(serverStreak ?? '?');
    })
    .catch((err) => console.error('Failed to load streaks', err));
}

async function main() {
  const discordSdk = new DiscordSDK(clientId);

  await discordSdk.ready();

  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });

  const tokenResponse = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  ({ access_token: accessToken } = await tokenResponse.json());

  await discordSdk.commands.authenticate({ access_token: accessToken });

  loadStreaks();

  setMessage("Loading today's word...");
  const wordResponse = await fetch('/api/word');
  const { word } = await wordResponse.json();
  answer = word.toUpperCase();
  setMessage('');
}

main().catch((err) => {
  console.error('Failed to start game', err);
  setMessage(`Error: ${err.message}`);
});
