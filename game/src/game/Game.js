import * as THREE from 'three';

import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { HospitalGenerator } from '../world/Generator.js';
import { WorldBuilder } from '../world/Builder.js';
import { ParticleSystem } from '../fx/ParticleSystem.js';
import { Player } from '../player/Player.js';
import { PatientManager } from '../entities/Patient.js';
import { DonutManager } from '../entities/Donut.js';
import { HUD } from '../ui/HUD.js';
import { SoundManager } from '../audio/SoundManager.js';

export class Game {
  constructor({ canvas, ui }) {
    this.canvas = canvas;
    this.ui = ui;

    this.scene = new THREE.Scene();
    // Slightly lighter fog so the scene doesn't feel dim.
    this.scene.fog = new THREE.FogExp2(0x090c12, 0.020);

    // Cityscape sky dome (visible through glass perimeter walls)
    this._initSkyDome();


    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;


    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 220);
        // FPS: keep camera at origin; raise the controls object instead
    this.camera.position.set(0, 0, 0);

    this.controls = new PointerLockControls(this.camera, document.body);
    this.scene.add(this.controls.getObject());

    // Lighting: brighter overall (FPS readability)
    const hemi = new THREE.HemisphereLight(0xbfd7ff, 0x0a0c10, 0.78);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(8, 14, 6);
    this.scene.add(dir);

    // Lobby spot (helps readability)
    const spot = new THREE.PointLight(0xcfe6ff, 0.85, 22, 2.0);
    spot.position.set(10, 5.5, 10);
    this.scene.add(spot);

    this.clock = new THREE.Clock();

    this.hud = new HUD(ui);

    this.sfx = new SoundManager();

    this.particles = new ParticleSystem(this.scene);
    // bind setters for safety (some modules call these)
    this.setSaved = this.setSaved.bind(this);
    this.setQuota = this.setQuota.bind(this);
this.player = new Player({ game: this });

    this.generator = new HospitalGenerator();
    this.builder = new WorldBuilder({ game: this });

    this.patientManager = new PatientManager({ game: this });
    this.donutManager = new DonutManager({ game: this });

    this._bindInputs();
    this.regenerate();
    this._loop();
  }

  _initSkyDome() {
    const loader = new THREE.TextureLoader();
    const tex = loader.load('assets/textures/city_sky.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;

    const geo = new THREE.SphereGeometry(180, 48, 32);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide });
    // Keep the skyline bright regardless of tone mapping / fog.
    mat.toneMapped = false;
    mat.fog = false;
    const sky = new THREE.Mesh(geo, mat);
    sky.position.set(35, 18, 35);
    sky.userData.kind = 'skydome';
    this.scene.add(sky);
  }

  lockPointer() {
    this.sfx?.unlock();
    // Pointer lock must be triggered from a user gesture and can fail in insecure contexts.
    // Call requestPointerLock() directly and swallow the promise rejection to avoid noisy console errors.
    try {
      const el = document.body;
      const p = el.requestPointerLock ? el.requestPointerLock({ unadjustedMovement: true }) : null;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore */ }
  }


  _bindInputs() {
    this.onPointerLockChange = () => {
      const locked = document.pointerLockElement === document.body;
      this.ui.start.style.display = locked ? 'none' : '';
    };
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  regenerate() {
    // reset world content
    this.builder.clearWorld();
    this.particles.clear();
    this.patientManager.clear();
    this.donutManager.clear();

    // active floor is tracked on the game (not the generated world)
    const activeFloor = (typeof this.activeFloor === 'number') ? this.activeFloor : 0;

    // generate new hospital
    this.world = this.generator.generateMultiFloor({
      floors: 3,
      w: 70,
      h: 70,
      seed: (Math.random() * 1e9) | 0
    });
    this.world.activeFloor = activeFloor;

    // build meshes + set visibility
    this.builder.build(this.world);
    this.builder.setActiveFloor(activeFloor);

    // spawn vending machines (1-2 total on the active floor)
    const vmCount = 1 + ((Math.random()*2)|0);
    this.builder.spawnVendingMachinesForFloor(this.world.floors[activeFloor], activeFloor, this.builder.getFloorY(activeFloor), vmCount);

    // decorative wall props on the active floor
    const wallPropCount = 6 + ((Math.random()*6)|0); // 6..11
    if (this.builder.spawnWallPropsForFloor) {
      this.builder.spawnWallPropsForFloor(this.world.floors[activeFloor], activeFloor, this.builder.getFloorY(activeFloor), wallPropCount);
    }

    // spawn entities
    this.patientManager.setActiveFloor(activeFloor);
    const patientCount = this.patientManager.spawnInitial(this.world);

    // move player to a guaranteed safe spawn
    this.player.reset();

    // rules
    this.timerSec = 210;
    this.quota = patientCount|0;
    this.saved = 0;
    this.hud.setQuota(this.quota);
    this.hud.setSaved(this.saved);
  }


  setSaved(n) {
    this.saved = (n|0);
    if (this.hud && this.hud.setSaved) this.hud.setSaved(this.saved);
  }

  setQuota(n) {
    this.quota = (n|0);
    if (this.hud && this.hud.setQuota) this.hud.setQuota(this.quota);
  }


  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  dispose() {
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.builder.clearWorld(true);
    this.patientManager.clear();
    this.donutManager.clear();
    this.renderer.dispose();
  }

  _loop = () => {
    const dt = Math.min(0.033, this.clock.getDelta());
    this.player.update(dt);
        this.builder.update(dt);
    this.particles.update(dt);
    this.patientManager.update(dt);
    this.donutManager.update(dt);
    const floor = (this.world && this.world.floors) ? this.world.floors[this.world.activeFloor||0] : null;
    this.hud.updateMinimap(this.player.position, floor);

    if (this.ui.start && this.ui.start.style.display === 'none') {
      this.timerSec = Math.max(0, this.timerSec - dt);
      this.hud.setTime(this.timerSec);
      if (this.timerSec <= 0 || this.saved >= this.quota) {
        this.ui.start.style.display = '';
      }
    }
this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  };
}