import * as THREE from 'three';

export class DonutManager {
  constructor({ game }) {
    this.game = game;
    this.scene = game.scene;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.donuts = [];

    // Shared geometry/material for cheap rendering
    this.geo = new THREE.TorusGeometry(0.18, 0.07, 10, 18);

    // Optional donut texture (users can replace assets/sprites/donut.png)
    const donutTex = new THREE.TextureLoader().load('assets/sprites/donut.png');
    donutTex.colorSpace = THREE.SRGBColorSpace;
    donutTex.magFilter = THREE.LinearFilter;
    donutTex.minFilter = THREE.LinearMipmapLinearFilter;

    this.mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: donutTex,
      transparent: true,
      roughness: 0.85,
      metalness: 0.05,
      emissive: 0x1a0d05,
      emissiveIntensity: 0.10,
      side: THREE.DoubleSide,
    });

    // how much power a donut restores
    this.powerRestore = 40;
  }

  clear() {
    for (const d of this.donuts) {
      this.group.remove(d.mesh);
    }
    this.donuts.length = 0;
  }

  spawn({ floor, x, z }) {
    const y0 = this.game.builder.getFloorY(floor);
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.set(x, y0 + 0.12, z);
    mesh.rotation.x = Math.PI/2;
    mesh.userData.kind = 'donut';
    mesh.userData.floor = floor;
    this.group.add(mesh);

    this.donuts.push({
      floor,
      mesh,
      t: 0,
    });
  }

  // Called by Player when punching a vending machine prop
  trySpawnFromVending(vendingProp, dir) {
    if (!vendingProp || vendingProp.subkind !== 'vending') return false;
    if ((vendingProp.donutsLeft|0) <= 0) return false;

    vendingProp.donutsLeft = (vendingProp.donutsLeft|0) - 1;

    // Spawn in front of machine (guaranteed outside the body)
    // Use the mesh position (true center) and push far enough to clear the cabinet depth + donut radius.
    const mx = vendingProp.mesh?.position?.x ?? (vendingProp.center?.x ?? ((vendingProp.min.x + vendingProp.max.x) * 0.5));
    const mz = vendingProp.mesh?.position?.z ?? (vendingProp.center?.z ?? ((vendingProp.min.z + vendingProp.max.z) * 0.5));

    // cabinet half-depth is ~0.45 (see Builder), donut pickup radius ~0.28 -> push at least ~0.9.
    const pushOut = 0.95;
    const sideJitter = (Math.random()-0.5) * 0.18;

    // side vector perpendicular in XZ
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();

    const ox = mx + dir.x * pushOut + side.x * sideJitter;
    const oz = mz + dir.z * pushOut + side.z * sideJitter;

    // Ensure donut doesn't spawn inside a wall/prop
    const floor = (typeof this.game.activeFloor === 'number') ? this.game.activeFloor : (this.game.world?.activeFloor ?? 0);
    const pos = new THREE.Vector3(ox, 0, oz);
    this.game.builder.collideCircleXZ(floor, pos, 0.28);

    this.spawn({ floor, x: pos.x, z: pos.z });

    this.game.sfx?.play('pickup', 0.7);

    return true;
  }

  update(dt) {
    const floor = this.game.activeFloor ?? (this.game.world?.activeFloor ?? 0);
    const p = this.game.controls.getObject().position;

    for (let i=this.donuts.length-1; i>=0; i--) {
      const d = this.donuts[i];
      if (d.floor !== floor) {
        // hide donuts on other floors
        d.mesh.visible = false;
        continue;
      }
      d.mesh.visible = true;

      d.t += dt;
      d.mesh.rotation.z += dt * 2.6;
      d.mesh.position.y += Math.sin(d.t * 6.0) * 0.002; // tiny wobble

      const dx = d.mesh.position.x - p.x;
      const dz = d.mesh.position.z - p.z;
      const dist2 = dx*dx + dz*dz;

      // pickup radius
      if (dist2 < 0.75*0.75) {
        this.group.remove(d.mesh);
        this.donuts.splice(i, 1);

        this.game.player?.addPower?.(this.powerRestore);
        this.game.sfx?.play('heal', 0.9);
      }
    }
  }
}
