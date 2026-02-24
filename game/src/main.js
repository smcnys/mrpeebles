import { Game } from './game/Game.js';

const canvas = document.getElementById('game');
const ui = {
  time: document.getElementById('time'),
  saved: document.getElementById('saved'),
  quota: document.getElementById('quota'),  arms: document.getElementById('arms'),
  start: document.getElementById('start'),
  playBtn: document.getElementById('play'),
  restartBtn: document.getElementById('restart'),
  hint: document.getElementById('hint'),
  mm: document.getElementById('mm'),
};

let game = null;

function boot(regen=false) {
  if (game) game.dispose();
  game = new Game({ canvas, ui });
  if (regen) game.regenerate();
}

ui.playBtn.addEventListener('click', () => {
  if (!game) boot(false);
  game.lockPointer();
});

ui.restartBtn.addEventListener('click', () => {
  if (!game) boot(true);
  game.regenerate();
  game.lockPointer();
});

window.addEventListener('resize', () => game?.resize());
boot(false);