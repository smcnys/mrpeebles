import * as THREE from 'three';



// Patient billboard sprite sizing (world units)
const PATIENT_SPRITE_W = 1.0;
const PATIENT_SPRITE_H = 2.0; // taller
const PATIENT_SPRITE_YOFF = PATIENT_SPRITE_H * 0.5; // place bottom on floor
const PATIENT_DOWN_YOFF   = 0.03; // tiny lift to avoid z-fighting when lying on floor
const PATIENT_RADIUS = 0.38;

function _safeSpriteMat(tex, extra = {}) {
  // Avoid THREE warning spam when tex is undefined (missing file / not loaded yet)
  if (!tex) return new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0, depthWrite: false, ...extra });
  return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, ...extra });
}

function loadSprite(url) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.premultiplyAlpha = true;
  return t;
}

const Patient = class Patient {
  constructor({ game, floor, x, z }) {
    this.game = game;
    this.floor = floor;

    this.maxHealth = 100;
    this.health = 100;

    this.isDown = false;
    this.dead = false;
    this.saved = false; // reserved (delivered to hospital later)

    this.countedAsSaved = false;

    // hit flash
    this.hitT = 0;
    this.pendingDown = false;

    // position / physics
    this.x = x;
    this.z = z;
    this.y = game.builder.getFloorY(floor);
    this.vel = new THREE.Vector3();

    this.held = false;
    this._wasHeld = false;
    this.thrownT = 0; // window for wall-smash logic

    // walk animation
    this._walkAnimT = 0;
    this._walkFrame = 0;

    // wandering
    this._goal = null;
    this._goalT = 0;

    this.mesh = null;
    this._setUpMesh();
  }

  _setUpMesh() {
    const mgr = this.game.patientManager;
    const mat = _safeSpriteMat(mgr?.texWalk1, {
      transparent: true,
      depthWrite: false,
      alphaTest: 0.15,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(PATIENT_SPRITE_W, PATIENT_SPRITE_H);
    this.mesh = new THREE.Mesh(geo, mat);
    const yoff = this.isDown ? PATIENT_DOWN_YOFF : PATIENT_SPRITE_YOFF;
    this.mesh.position.set(this.x, this.y + yoff, this.z);

    // Alias used by Player grab/throw code
    this.pos = this.mesh.position;

    this.mesh.userData.kind = 'patient';
    this.mesh.userData.patient = this;
    this.mesh.userData.floor = this.floor;

    mgr.group.add(this.mesh);
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry?.dispose?.();
    this.mesh.material?.dispose?.();
    this.game.patientManager.group.remove(this.mesh);
    this.mesh = null;
  }

  _syncMesh() {
    if (!this.mesh) return;
    const yoff = this.isDown ? PATIENT_DOWN_YOFF : PATIENT_SPRITE_YOFF;
    this.mesh.position.set(this.x, this.y + yoff, this.z);
  }

  _setWalkSprite(frame=0) {
    const mgr = this.game.patientManager;
    const tex = (frame|0) === 1 ? mgr.texWalk2 : mgr.texWalk1;
    if (this.mesh?.material?.map !== tex) this.mesh.material.map = tex;
    if (this.mesh?.material) this.mesh.material.needsUpdate = true;
  }

  _setDownSprite() {
    const mgr = this.game.patientManager;
    if (this.mesh?.material?.map !== mgr.texDown) this.mesh.material.map = mgr.texDown;
    if (this.mesh?.material) this.mesh.material.needsUpdate = true;
  }

  _setGrabbedSprite() {
    const mgr = this.game.patientManager;
    if (this.mesh?.material?.map !== mgr.texGrab) this.mesh.material.map = mgr.texGrab;
    if (this.mesh?.material) this.mesh.material.needsUpdate = true;
  }

  _setHitSprite() {
    const mgr = this.game.patientManager;
    if (mgr?.texHit && this.mesh?.material) {
      this.mesh.material.map = mgr.texHit;
      this.mesh.material.needsUpdate = true;
    }
  }

  _hitFX(dir=null, strength=1.0) {
    this.hitT = 0.14;
    this._setHitSprite();

    // red particle burst via GPU shader particles
    const fxY = this.mesh ? this.mesh.position.y : (this.y + 1.0);
    if (this.game.particles && this.game.particles.spawnBlood) {
      this.game.particles.spawnBlood(this.x, fxY, this.z, dir, strength);
    }
  }

  applyDamage(amount, reason='damage', dir=null) {
    if (this.isDown || this.dead) return;

    const dmg = Math.max(0, amount|0);
    this.health = Math.max(0, this.health - dmg);

    this._hitFX(dir, Math.min(1.8, 0.9 + dmg/35));

    if (this.health <= 0) {
      this.health = 0;
      // If the patient is currently being carried, drop them immediately.
      // (Otherwise Player.js will keep forcing the held position for a few frames.)
      if (this.held) {
        this.game.sfx?.play('patientDown', 0.9);
        this.goDown('down');
      } else {
        this.pendingDown = true;
        this.game.sfx?.play('patientDown', 0.9);
      }

      if (!this.countedAsSaved) {
        this.countedAsSaved = true;
        this.game.setSaved((this.game.saved|0) + 1);
        this.game.sfx?.play('saved', 1.0);
      }
    }
  }

  heal(amount) {
    if (this.isDown || this.dead) return;
    const n = Math.max(0, amount|0);
    this.health = Math.min(this.maxHealth, this.health + n);
  }

  goDown(reason='down') {
    if (this.isDown) return;
    this.isDown = true;
    this.dead = true;
    this.pendingDown = false;
    this.hitT = 0;

    // Snap to floor
    const floorY = this.game.builder.getFloorY(this.floor);
    this.y = floorY;

    this.vel.set(0,0,0);
    this.thrownT = 0;
    this.held = false;
    this._wasHeld = false;

    this._setDownSprite();

    // Lay flat on the floor when down/dead
    if (this.mesh) {
      this.mesh.rotation.set(-Math.PI/2, 0, 0);
    }

    this._syncMesh();
  }

  _pickNewGoal(dt) {
    this._goalT -= dt;
    if (this._goalT > 0 && this._goal) return;

    this._goalT = 0.8 + Math.random()*1.8;

    const floor = this.game.world.floors[this.floor];
    const w = floor.w;
    const h = floor.h;

    for (let i=0;i<40;i++){
      const gx = Math.floor(this.x + (Math.random()*14 - 7));
      const gz = Math.floor(this.z + (Math.random()*14 - 7));
      if (gx < 0 || gz < 0 || gx >= w || gz >= h) continue;
      if (!this.game.builder.isWalkableWorld(this.floor, gx+0.5, gz+0.5)) continue;
      this._goal = { x: gx + 0.5, z: gz + 0.5 };
      return;
    }

    const p = this.game.builder.findNearestWalkable(this.floor, this.x, this.z, 10);
    this._goal = { x: p.x, z: p.z };
  }

  update(dt) {
    if (this.isDown) {
      this._syncMesh();
      return;
    }

    // Hit flash timer
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) {
        if (this.pendingDown) {
          this.goDown('down');
          return;
        }
        this._setWalkSprite(this._walkFrame);
      }
    }

    // If held, Player.js drives position directly
    // While held, show the grabbed sprite (unless down/dead).
    if (this.held) {
      if (!this._wasHeld && this.hitT <= 0 && !this.isDown) {
        this._setGrabbedSprite();
      }
      this._wasHeld = true;
      this.vel.set(0,0,0);
      // Player drives mesh.position while held; keep physics state in sync without overriding.
      if (this.pos) {
        this.x = this.pos.x;
        this.z = this.pos.z;
        this.y = this.pos.y - PATIENT_SPRITE_YOFF;
      }
      return;
    } else if (this._wasHeld) {
      // just released; restore walk sprite if still alive
      this._wasHeld = false;
      if (!this.isDown && !this.dead && this.hitT <= 0) this._setWalkSprite(this._walkFrame);
    }

    // Thrown physics (simple ballistic + wall smash)
    if (this.thrownT > 0) {
      this.thrownT = Math.max(0, this.thrownT - dt);

      // gravity
      this.vel.y -= 18 * dt;

      // proposed move
      const nx = this.x + this.vel.x * dt;
      const ny = this.y + this.vel.y * dt;
      const nz = this.z + this.vel.z * dt;

      // floor collide
      const floorY = this.game.builder.getFloorY(this.floor);
      if (ny < floorY) {
        this.y = floorY;
        this.vel.y = 0;
      } else {
        this.y = ny;
      }


      // ceiling collide (prevents throwing through floors)
      const ceilY = this.game.builder.getCeilY ? this.game.builder.getCeilY(this.floor) : (floorY + 3.0);
      const topY = this.y + PATIENT_SPRITE_H;
      if (topY > ceilY) {
        this.y = Math.max(floorY, ceilY - PATIENT_SPRITE_H);
        if (this.vel.y > 0) this.vel.y = 0;
      }

      // Robust collision against wall + prop AABBs so thrown patients can't tunnel out of the map.
      const moved = this.game.builder.moveCircleStepped(
        this.floor,
        { x: this.x, z: this.z },
        this.vel,
        PATIENT_RADIUS,
        dt,
        6
      );

      this.x = moved.x;
      this.z = moved.z;

      // Smash breakable walls when thrown hard.
      if (moved.hitWallId && moved.hitWallId > 0) {
        const speedXZ = Math.hypot(this.vel.x, this.vel.z);
        // Lower threshold + more reliable hitWallId detection = consistent wall breaks.
        if (speedXZ > 4.8) {
          this.game.builder.damageWall(moved.hitWallId, 140, moved.hitDir || new THREE.Vector3(1,0,0));
          this.applyDamage(999, 'wall', moved.hitDir);
          this.vel.set(0,0,0);
          this.thrownT = 0;
        } else {
          // slow impacts just damp
          this.vel.x *= 0.18;
          this.vel.z *= 0.18;
        }
      }

      this._syncMesh();
      return;
    }

    // Wander walking
    this._pickNewGoal(dt);

    const speed = 1.25; // slower
    let vx = 0, vz = 0;
    if (this._goal) {
      const dx = this._goal.x - this.x;
      const dz = this._goal.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.25) {
        this._goal = null;
      } else {
        vx = (dx / d) * speed;
        vz = (dz / d) * speed;
      }
    }

    // Move with simple wall avoidance using isWalkableWorld
    const nx = this.x + vx * dt;
    const nz = this.z + vz * dt;
    if (this.game.builder.isWalkableWorld(this.floor, nx, nz)) {
      this.x = nx; this.z = nz;
    } else {
      // try axis-separated
      if (this.game.builder.isWalkableWorld(this.floor, nx, this.z)) this.x = nx;
      if (this.game.builder.isWalkableWorld(this.floor, this.x, nz)) this.z = nz;
    }

    // Also collide against AABB walls/props (furniture) to avoid clipping.
    this.game.builder.collideCircleXZ(this.floor, this, PATIENT_RADIUS);

    // walk anim
    const sp2 = vx*vx + vz*vz;
    if (sp2 > 0.02) {
      this._walkAnimT += dt;
      if (this._walkAnimT > 0.22) {
        this._walkAnimT = 0;
        this._walkFrame = this._walkFrame ? 0 : 1;
        if (this.hitT <= 0) this._setWalkSprite(this._walkFrame);
      }
    }

    this._syncMesh();
  }
};

const PatientManager = class PatientManager {
  constructor({ game }) {
    this.game = game;
    this.group = new THREE.Group();
    this.game.scene.add(this.group);

    this.texWalk1 = loadSprite('assets/sprites/patient_walk1.png');
    this.texWalk2 = loadSprite('assets/sprites/patient_walk2.png');
    this.texDown = loadSprite('assets/sprites/patient_down.png');
    this.texGrab = loadSprite('assets/sprites/patient_grabbed.png');

    this.texHit  = loadSprite('assets/sprites/patient_hit.png');
    this.patients = [];
    this.activeFloor = 0;
  }

  clear() {
    for (const p of this.patients) p.dispose();
    this.patients.length = 0;
  }

  setActiveFloor(floor) {
    this.activeFloor = floor|0;
    for (const p of this.patients) {
      if (p.mesh) p.mesh.visible = (p.floor === this.activeFloor);
    }
  }

  spawnInitial(world) {
    // Spawn a RANDOM (but controlled) number of patients.
    // IMPORTANT: Only count/spawn on the active floor so the HUD quota always
    // matches the number of patients the player can actually find and save.
    const floors = world.floors || [];
    if (!floors.length) return 0;

    const f = this.activeFloor | 0;
    const floor = floors[f];
    if (!floor) return 0;

    // Keep it playable (no 30+ patient runs).
    const count = 10 + ((Math.random() * 7) | 0); // 10–16
    const { w, h } = floor;

    for (let i=0; i<count; i++) {
      // sample random tiles until we find something walkable
      let px = 0, pz = 0;
      for (let t=0; t<160; t++) {
        const x = (Math.random() * (w-2) + 1) + 0.5;
        const z = (Math.random() * (h-2) + 1) + 0.5;
        if (!this.game.builder.isWalkableWorld(f, x, z)) continue;
        const p0 = this.game.builder.findNearestWalkable(f, x, z, 22);
        px = p0.x; pz = p0.z;
        break;
      }

      // fallback to lobby center (guaranteed by findNearestWalkable)
      if (!px && !pz) {
        const l = floor.lobby;
        const p0 = this.game.builder.findNearestWalkable(
          f,
          (l.x0 + l.x1) * 0.5,
          (l.y0 + l.y1) * 0.5,
          30
        );
        px = p0.x; pz = p0.z;
      }

      const p = new Patient({ game: this.game, floor: f, x: px, z: pz });
      p._setWalkSprite(0);
      this.patients.push(p);
    }

    this.setActiveFloor(this.activeFloor);
    return this.patients.length;
  }

  update(dt) {
    // face camera + update patients
    const q = this.game.camera.quaternion;
    for (const p of this.patients) {
      if (p.mesh) {
        if (!p.isDown) {
          p.mesh.quaternion.copy(q);
        }
      }
      if (p.floor !== this.activeFloor) continue;
      p.update(dt);
    }
  }

  raycast(origin, dir, maxDist) {
    // approximate hit against billboards using sphere around patient center
    let best = null;
    for (const p of this.patients) {
      if (p.floor !== this.activeFloor) continue;
      const cx = (p.pos ? p.pos.x : p.x);
      const cy = (p.mesh ? p.mesh.position.y : (p.pos ? p.pos.y : (p.y + 1.0)));
      const cz = (p.pos ? p.pos.z : p.z);

      // ray-sphere
      const ocx = origin.x - cx;
      const ocy = origin.y - cy;
      const ocz = origin.z - cz;
      const b = ocx*dir.x + ocy*dir.y + ocz*dir.z;
      const c = ocx*ocx + ocy*ocy + ocz*ocz - 0.95*0.95;
      const disc = b*b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t >= 0 && t <= maxDist) {
        if (!best || t < best.t) best = { t, type:'patient', patient: p };
      }
    }
    return best;
  }
};

export { Patient, PatientManager };