
// World.js - wrapper to construct world via Builder
import { WorldBuilder } from './Builder.js';

export class World {
  constructor(game) {
    this.game = game;
    this.builder = new WorldBuilder(game);
    this.activeFloor = 0;
  }

  build(seed) {
    return this.builder.build(seed);
  }
}
