import * as THREE from 'three';

const KEYS = new Set();

export class Player {
  constructor({ game }) {
    this.game = game;
    this.cam = game.camera;
    this.controls = game.controls;

    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.tmp = new THREE.Vector3();

    this.radius = 0.36;
        this.height = 1.7;

    this.speed = 6.2;
    this.sprint = 1.25;

        this.punchCooldown = 0;
    this.grabbed = null;
    this._eHintT = 0;
    this.grabAnimT = 0;

    // Power / stamina
    this.maxPower = 100;
    this.power = this.maxPower;
    // Power regeneration (units per second). Keep this fairly slow so power management matters.
    this.powerRegenPerSec = 4; // was 10
    this.powerCosts = {
      punch: 8,
      grab: 4,
      throw: 40
    };

    window.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== document.body) return;
      if (e.button === 0) this.punch();
      if (e.button === 2) this.toggleGrab();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      KEYS.add(e.code);
      if (e.code === 'KeyE') this.tryElevator();
    });
    window.addEventListener('keyup', (e) => KEYS.delete(e.code));
  }

  reset() {
    if (!this.game.world) return;
        const floorIndex = (typeof this.game.activeFloor === 'number') ? this.game.activeFloor : (this.game.world.activeFloor||0);
    const spawn = this.game.world.floors[floorIndex].spawn;
    const safe = this.game.builder.findNearestWalkable(floorIndex, spawn.x, spawn.z, 22);
        this.controls.getObject().position.set(safe.x, this.height, safe.z);
    this.vel.set(0,0,0);
    this.grabbed = null;
    this.power = this.maxPower;
    this.game?.hud?.setPower?.(this.power, this.maxPower);
  }


  addPower(amount=0) {
    const a = Math.max(0, amount);
    if (a <= 0) return;
    this.power = Math.min(this.maxPower, this.power + a);
    this.game?.hud?.setPower?.(this.power, this.maxPower);
  }

  _hasPower(cost=1) {
    return (this.power|0) >= (cost|0);
  }

  _spendPower(cost=0) {
    const c = Math.max(0, cost|0);
    if (c <= 0) return true;
    if (!this._hasPower(c)) {
      this.game?.sfx?.play('noPower', 1.0);
      return false;
    }
    this.power = Math.max(0, this.power - c);
    this.game?.hud?.setPower?.(this.power, this.maxPower);
    return true;
  }

  get position() { return this.controls.getObject().position; }
  getYaw() {
    // Prefer PointerLockControls camera yaw so movement always matches view direction.
    const c = this.game && this.game.controls;
    if (c && c.getObject) {
      return c.getObject().rotation.y;
    }
    return this.yaw || 0;
  }



  update(dt) {
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);
    this.grabAnimT = Math.max(0, this.grabAnimT - dt);

    // regenerate power
    if (this.power < this.maxPower) {
      this.power = Math.min(this.maxPower, this.power + this.powerRegenPerSec * dt);
      this.game?.hud?.setPower?.(this.power, this.maxPower);
    }

    const obj = this.controls.getObject();

    // Desktop (keyboard) + Mobile (virtual joystick) support.
    // When game.mobile.active is true, movement comes from normalized axes.
    const m = this.game && this.game.mobile;
    const forward = (m && m.active) ? (m.forward || 0) : ((KEYS.has('KeyW') ? 1 : 0) - (KEYS.has('KeyS') ? 1 : 0));
    const strafe  = (m && m.active) ? (m.strafe  || 0) : ((KEYS.has('KeyD') ? 1 : 0) - (KEYS.has('KeyA') ? 1 : 0));
    const run = (m && m.active) ? !!m.run : (KEYS.has('ShiftLeft') || KEYS.has('ShiftRight'));
    const spd = this.speed * (run ? this.sprint : 1.0);

    // Robust FPS movement: use camera world direction projected onto XZ.
    const fwd = new THREE.Vector3();
    this.game.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();

    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();

    this.dir.set(
      fwd.x * forward + right.x * strafe,
      0,
      fwd.z * forward + right.z * strafe
    );
    if (this.dir.lengthSq() > 0.001) this.dir.normalize();


    // friction
    this.vel.x *= Math.pow(0.0012, dt);
    this.vel.z *= Math.pow(0.0012, dt);

    this.vel.x += this.dir.x * spd * dt * 10.5;
    this.vel.z += this.dir.z * spd * dt * 10.5;

    this.vel.y -= 18 * dt;

    this.tmp.copy(this.vel).multiplyScalar(dt);
    obj.position.add(this.tmp);

    this._collideWorld();

    const floorY = this.game.builder.getFloorY(this.game.world.activeFloor, obj.position.x, obj.position.z);
    const minY = floorY + this.height;
    if (obj.position.y < minY) {
      obj.position.y = minY;
      this.vel.y = 0;
    }

    if (this.grabbed) {
  const p = this.grabbed;

  const camDir = new THREE.Vector3();
  this.cam.getWorldDirection(camDir);

  const right = new THREE.Vector3()
    .crossVectors(camDir, new THREE.Vector3(0, 1, 0))
    .normalize();

  // Hold position tuning
  const forwardDist = 0.95;  // closer to camera
  const rightOffset = 0.15;  // less sideways offset
  const downOffset  = 0.85;  // lower toward hands

  p.pos.copy(this.cam.position)
    .add(camDir.multiplyScalar(forwardDist))
    .add(right.multiplyScalar(rightOffset));

  // move down relative to camera height
  p.pos.y -= downOffset;

  // Keep patient logic coords in sync with the carried mesh position
  if (p.mesh && p.mesh.geometry && p.mesh.geometry.parameters && p.mesh.geometry.parameters.height) {
    const yoff = p.mesh.geometry.parameters.height * 0.5;
    p.x = p.pos.x; p.z = p.pos.z; p.y = p.pos.y - yoff;
  } else {
    p.x = p.pos.x; p.z = p.pos.z; p.y = p.pos.y - 1.0;
  }

  p.vel.set(0, 0, 0);
  p.held = true;
}

        // elevator hint proximity
    this._eHintT -= dt;

    // arms state
    if (this.punchCooldown > 0.15) this.game.ui.arms.src = 'assets/sprites/arms_punch.png';
    else if (this.grabbed || this.grabAnimT > 0) this.game.ui.arms.src = 'assets/sprites/arms_grab.png';
    else this.game.ui.arms.src = 'assets/sprites/arms_idle.png';
  }

  _collideWorld() {
    const p = this.position;
    const r = this.radius;
    const colliders = this.game.builder.colliders;

    for (let i=0;i<colliders.length;i++) {
      const c = colliders[i];
      if (!c.active || (c.tag !== 'wall' && c.tag !== 'prop')) continue;
      if (c.floor !== this.game.world.activeFloor) continue;

      const cx = Math.max(c.min.x, Math.min(p.x, c.max.x));
      const cy = Math.max(c.min.y, Math.min(p.y, c.max.y));
      const cz = Math.max(c.min.z, Math.min(p.z, c.max.z));
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx*dx + dz*dz;
      if (d2 < r*r) {
        const d = Math.sqrt(Math.max(1e-6, d2));
        const push = (r - d);
        p.x += (dx/d) * push;
        p.z += (dz/d) * push;


if (c.tag === 'prop' && c.mesh && c.vel) {
  // push the prop away from the player
  const k = Math.min(6.0, 10.0 * push);
  c.vel.x += (-dx/d) * k;
  c.vel.z += (-dz/d) * k;
}
        this.vel.x *= 0.18;
        this.vel.z *= 0.18;
      }
    }
  }

  punch() {
    if (this.punchCooldown > 0) return;
    // When power is 0 you can't punch.
    if (!this._spendPower(this.powerCosts.punch)) return;
    this.punchCooldown = 0.35;

    const origin = this.cam.position.clone();
    const dir = new THREE.Vector3();
    this.cam.getWorldDirection(dir);

    const hit = this.game.builder.raycast(origin, dir, 2.1);
    if (!hit) return;

    if (hit.type === 'glass') {
      const p = origin.clone().add(dir.clone().multiplyScalar(hit.t || 0));
      const c = hit.collider;
      // estimate outward normal based on closest AABB face
      const eps = 0.08;
      let n = new THREE.Vector3(0,0,1);
      if (Math.abs(p.x - c.min.x) < eps) n.set(-1,0,0);
      else if (Math.abs(p.x - c.max.x) < eps) n.set(1,0,0);
      else if (Math.abs(p.z - c.min.z) < eps) n.set(0,0,-1);
      else if (Math.abs(p.z - c.max.z) < eps) n.set(0,0,1);

      this.game.builder.addGlassCrackSpread(p, n);
      this.game.particles?.spawnDust(p.x, p.y, p.z, dir, 0.35);
      this.game.sfx?.play('punchWall', 0.6);
      return;
    }

    if (hit.type === 'wall') {
      // punch impact dust + damage
      const p = origin.clone().add(dir.clone().multiplyScalar(hit.t || 0));
      this.game.particles?.spawnDust(p.x, p.y, p.z, dir, 1.0);
      this.game.sfx?.play('punchWall', 1.0);
      this.game.builder.damageWall(hit.wallId, 36, dir);
    } else if (hit.type === 'patient') {
      this.game.sfx?.play('punchFlesh', 1.0);
      const p = hit.patient;
      p.applyDamage(25, 'punch', dir);
      p.vel.add(dir.multiplyScalar(6));

      // If we just punched a carried patient to 0 health, force an immediate drop
      // and reset arms to idle (no more grab pose).
      if (this.grabbed === p && (p.isDown || p.health <= 0 || p.dead)) {
        p.held = false;
        this.grabbed = null;
        this.grabAnimT = 0;
        // cancel punch/grab arm overlays so it snaps to idle right away
        this.punchCooldown = 0;
        if (this.game?.ui?.arms) this.game.ui.arms.src = 'assets/sprites/arms_idle.png';
      }
    } else if (hit.type === 'prop') {
      const pr = hit.prop;

      // Vending machine: spawns donuts (limited).
      if (pr && pr.subkind === 'vending') {
        // Donut should eject from the vending machine "front" (the textured face).
        // In Builder, the textured face is the BoxGeometry +Z face, so the world-space "front"
        // direction is the local +Z rotated by the machine yaw.
        const yaw = pr.mesh?.rotation?.y ?? 0;
        const vendDir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();

        const spawned = this.game.donutManager?.trySpawnFromVending?.(pr, vendDir);
        // small dust puff for feedback
        const p = origin.clone().add(dir.clone().multiplyScalar(hit.t || 0));
        this.game.particles?.spawnDust(p.x, p.y, p.z, dir, 0.6);
        this.game.sfx?.play('punchWall', 0.6);
        if (!spawned) this.game.sfx?.play('noPower', 0.6);
        return;
      }

      // Furniture: propel it forward.
      if (pr && pr.vel && !pr.immovable) {
        pr.vel.x += dir.x * 14.0;
        pr.vel.z += dir.z * 14.0;
      }
      const p = origin.clone().add(dir.clone().multiplyScalar(hit.t || 0));
      this.game.particles?.spawnDust(p.x, p.y, p.z, dir, 0.8);
      this.game.sfx?.play('punchWall', 0.8);
    }
  }

  toggleGrab() {
    // When power is 0 you can't grab or throw.
    if (!this._hasPower(1)) {
      this.game?.sfx?.play('noPower', 1.0);
      return;
    }

    if (this.grabbed) {
      // throwing costs a large amount
      if (!this._spendPower(this.powerCosts.throw)) return;
      const dir = new THREE.Vector3();
      this.cam.getWorldDirection(dir);
      const p = this.grabbed;
      p.held = false;
      p.thrownT = 0.45; // time window for wall-smash
      p.vel.copy(dir.multiplyScalar(26));
      p.vel.y += 8.0;
      p.onThrown?.(this.game);
      this.game.sfx?.play('throw', 1.0);
      this.grabbed = null;
      return;
    }

    // grabbing costs a small amount
    if (!this._spendPower(this.powerCosts.grab)) return;

    const origin = this.cam.position.clone();
    const dir = new THREE.Vector3();
    this.cam.getWorldDirection(dir);

    const hit = this.game.builder.raycast(origin, dir, 3.2, { patients:true, walls:false });
    if (hit && hit.type === 'patient') {
      const p = hit.patient;
      if (!p.saved && !p.dead) {
        this.grabbed = p;
        p.held = true;
        this.game.sfx?.play('pickup', 1.0);
        this.grabAnimT = 0.25;
      } else {
        // refund if we couldn't actually grab
        this.power = Math.min(this.maxPower, this.power + this.powerCosts.grab);
        this.game?.hud?.setPower?.(this.power, this.maxPower);
      }
    } else {
      // refund if there was nothing to grab
      this.power = Math.min(this.maxPower, this.power + this.powerCosts.grab);
      this.game?.hud?.setPower?.(this.power, this.maxPower);
    }
  }

  tryElevator() {
    if (!this.game.world) return;
    const floor = this.game.world.floors[this.game.activeFloor];
    const pos = this.position;
    const dx = pos.x - floor.elevator.x;
    const dz = pos.z - floor.elevator.z;
    const near = (dx*dx + dz*dz) < 1.25*1.25;
    if (!near) return;

    // cycle floors
    const next = (this.game.activeFloor + 1) % this.game.world.floors.length;
    this.game.activeFloor = next;
    this.game.world.activeFloor = next;

    this.game.builder.setActiveFloor(next);
    this.game.patientManager.setActiveFloor(next);
    this.game.hud.setFloor(next + 1);

    // snap to elevator on the new floor
    const elev = this.game.world.floors[next].elevator;
    const safe = this.game.builder.findNearestWalkable(next, elev.x, elev.z, 22);
    this.controls.getObject().position.set(safe.x, this.height, safe.z);
    this.vel.set(0,0,0);
  }

}
