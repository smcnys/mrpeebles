import { Game } from './game/Game.js';
import { MobileControls } from './mobile/MobileControls.js';

const canvas = document.getElementById('game');
const ui = {
  time: document.getElementById('time'),
  saved: document.getElementById('saved'),
  quota: document.getElementById('quota'),
  arms: document.getElementById('arms'),
  start: document.getElementById('start'),
  playBtn: document.getElementById('play'),
  restartBtn: document.getElementById('restart'),
  hint: document.getElementById('hint'),
  mm: document.getElementById('mm'),
};

let game = null;
let mobile = null;

function boot(regen = false) {
  if (mobile) { mobile.dispose(); mobile = null; }
  if (game) game.dispose();
  game = new Game({ canvas, ui });

  // Enable mobile axes
  game.mobile = { active: true, forward: 0, strafe: 0, run: false };

  // Hook up virtual controls
  mobile = new MobileControls({
    game,
    canvas,
    ui: {
      joystick: document.getElementById('joy'),
      stick: document.getElementById('joyStick'),
      look: document.getElementById('look'),
      punchBtn: document.getElementById('btnPunch'),
      grabBtn: document.getElementById('btnGrab'),
sprintBtn: document.getElementById('btnSprint'),
    }
  });

  if (regen) game.regenerate();
}

async function tryFullscreen() {
  // Fullscreen is best-effort and will fail on iOS Safari in many cases.
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
  } catch (e) { /* ignore */ }
}

function startGame(regen = false) {
  if (!game) boot(regen);
  // Unlock audio + hide overlay
  game?.sfx?.unlock?.();
  ui.start.style.display = 'none';
  tryFullscreen();
}

ui.playBtn.addEventListener('click', () => startGame(false));
ui.restartBtn.addEventListener('click', () => startGame(true));

window.addEventListener('resize', () => game?.resize());
boot(false);
