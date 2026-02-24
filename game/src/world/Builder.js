import * as THREE from 'three';

function makeCanvasTexture(drawFn, w=512, h=512) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  drawFn(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function randFromSeed(seed) {
  let s = seed|0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) / 4294967296);
  };
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

function loadTexture(url) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}

export class WorldBuilder {
  constructor({ game }) {
    this.game = game;
    this.scene = game.scene;

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.debrisGroup = new THREE.Group();
    this.scene.add(this.debrisGroup);

    this.spriteGroup = new THREE.Group();
    this.scene.add(this.spriteGroup);

    this.colliders = [];
    this.breakables = new Map();

    this.debris = [];

    // pushable props (beds, IV stands)
    this.props = [];
    this.maxDebris = 1400;

    this.activeFloor = 0;

    this._initMaterialsAndSprites();
  }

  // --- Collision helpers -------------------------------------------------
  // Push a circle (x,z,r) out of active AABB colliders on a floor.
  spawnVendingMachinesForFloor(floor, f, y0, count=1) {
    if (!floor) return 0;
    const { w, h, grid, lobby } = floor;
    const idx = (x,y)=> y*w + x;
    const walk = (x,y) => (x>=0 && y>=0 && x<w && y<h) ? (grid[idx(x,y)]===1) : false;

    // Cap total vending machines on this floor to 2.
    const existing = this.props.filter(pr => pr.active && pr.floor === f && pr.subkind === 'vending').length;
    const cap = 2;
    const want = Math.max(0, Math.min(cap - existing, count|0));
    if (want <= 0) return 0;

    let placed = 0;
    let tries = 4200;

    while (placed < want && tries-- > 0) {
      const spot = this._findWallSpotOnFloor(floor, { preferLobby: true });
      if (!spot) continue;

      // Move inward from the wall so we don't collide with the wall collider.
      // The vending front faces outward; inward is +Z in local space.
      const inward = new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw)).normalize();
      const p = new THREE.Vector3(spot.x, 0, spot.z).add(inward.multiplyScalar(0.42));

      // Ensure it's on a walkable cell
      if (!walk(Math.floor(p.x), Math.floor(p.z))) continue;

      // Don't overlap other props
      let ok = true;
      for (const pr of this.props) {
        if (!pr.active) continue;
        if (pr.floor !== f) continue;
        const dx = (pr.center?.x ?? 0) - p.x;
        const dz = (pr.center?.z ?? 0) - p.z;
        if (dx*dx + dz*dz < 2.4*2.4) { ok = false; break; }
      }
      if (!ok) continue;

      // Avoid walls/props (use a smaller radius than before so it can actually fit near walls)
      if (this.collideCircleXZ(f, p, 0.45)) continue;

      const donutsLeft = 1 + ((Math.random()*3)|0); // 1..3
      this._createVendingMachine(p.x, p.z, f, y0, donutsLeft, spot.yaw);
      placed++;
    }

    // Guarantee at least one on floor 0 (lobby) if requested and random placement fails.
    if (placed === 0 && want > 0 && lobby) {
      const fallback = [
        { x: lobby.x0 + 2.2, z: lobby.y0 + 1.2, yaw: 0 },
        { x: lobby.x1 - 2.2, z: lobby.y1 - 1.2, yaw: Math.PI },
        { x: lobby.x0 + 1.2, z: lobby.y1 - 2.2, yaw: Math.PI/2 },
        { x: lobby.x1 - 1.2, z: lobby.y0 + 2.2, yaw: -Math.PI/2 },
      ];
      for (const c of fallback) {
        const p2 = new THREE.Vector3(c.x, 0, c.z);
        if (!walk(Math.floor(p2.x), Math.floor(p2.z))) continue;
        if (this.collideCircleXZ(f, p2, 0.45)) continue;
        this._createVendingMachine(p2.x, p2.z, f, y0, 2, c.yaw);
        placed = 1;
        break;
      }
    }

    return placed;
  }

  // Spawn additional decorative sprites that sit against walls.
  // User can add/replace the PNG files in assets/sprites/.
  spawnWallPropsForFloor(floor, f, y0, count=8) {
    if (!floor) return 0;

    const items = [
      { name: 'potted_plant', tex: this.texPottedPlant, scale: 1.0 },
      { name: 'chair', tex: this.texChair, scale: 0.95 },
      { name: 'end_table', tex: this.texEndTable, scale: 0.9 },
      { name: 'standing_computer', tex: this.texStandingComputer, scale: 1.05 },
    ].filter(it => !!it.tex);

    if (!items.length) return 0;

    const placedMax = Math.max(0, count|0);
    let placed = 0;
    let tries = 2600;

    const placeWallSprite = (tex, x, z, yaw, scale=1.0, kind='wallProp') => {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        alphaTest: 0.15,
        side: THREE.DoubleSide,
      });
      mat.toneMapped = false;
      const geo = new THREE.PlaneGeometry(1.25*scale, 1.25*scale);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y0 + 0.65*scale, z);
      // Rotate to face into the room.
      m.rotation.y = yaw;
      m.userData.floor = f;
      m.userData.kind = kind;
      this.spriteGroup.add(m);

      // Add simple AABB collider so the player/patients can't pass through.
      const bb = new THREE.Box3().setFromObject(m);
      bb.expandByVector(new THREE.Vector3(0.42*scale, 1.30*scale, 0.42*scale));

      // Make the collider tall enough to be punchable from the player's eye height.
      bb.min.y = y0;
      bb.max.y = y0 + 2.6;
      const propCol = {
        min: bb.min.clone(),
        max: bb.max.clone(),
        tag: 'prop',
        mesh: m,
        half: new THREE.Vector3((bb.max.x-bb.min.x)*0.5, (bb.max.y-bb.min.y)*0.5, (bb.max.z-bb.min.z)*0.5),
        center: new THREE.Vector3((bb.min.x+bb.max.x)*0.5, (bb.min.y+bb.max.y)*0.5, (bb.min.z+bb.max.z)*0.5),
        vel: new THREE.Vector3(),
        active: true,
        floor: f,
        unbreakable: true,
        // movable like other furniture
        subkind: kind,
      };
      this.colliders.push(propCol);
      this.props.push(propCol);
      return m;
    };

    while (placed < placedMax && tries-- > 0) {
      const spot = this._findWallSpotOnFloor(floor, { preferLobby: false });
      if (!spot) continue;

      // don't overlap other props
      let ok = true;
      for (const pr of this.props) {
        if (pr.floor !== f) continue;
        const dx = (pr.center?.x ?? 0) - spot.x;
        const dz = (pr.center?.z ?? 0) - spot.z;
        if (dx*dx + dz*dz < 1.95*1.95) { ok = false; break; }
      }
      if (!ok) continue;

      // avoid walls/props
      const p = new THREE.Vector3(spot.x, 0, spot.z);
      if (this.collideCircleXZ(f, p, 0.55)) continue;

      const it = items[(Math.random()*items.length)|0];
      placeWallSprite(it.tex, p.x, p.z, spot.yaw, it.scale, it.name);
      placed++;
    }

    
    return placed;
  }

  // Guaranteed lobby props so the player always sees them.
  // This avoids rare cases where random wall-spot search fails due to crowded colliders.
  spawnGuaranteedLobbyProps(floor, f, y0) {
    if (!floor) return;
    const { lobby, w, h, grid } = floor;
    const idx = (x,y)=> y*w + x;
    const walk = (x,y) => (x>=0 && y>=0 && x<w && y<h) ? (grid[idx(x,y)]===1) : false;

    const candidates = [
      // Near lobby north wall
      { x: lobby.x0 + 2.2, z: lobby.y0 + 1.1, yaw: 0 },
      // Near lobby south wall
      { x: lobby.x1 - 2.2, z: lobby.y1 - 1.1, yaw: Math.PI },
      // Near lobby west wall
      { x: lobby.x0 + 1.1, z: lobby.y1 - 2.2, yaw: Math.PI/2 },
      // Near lobby east wall
      { x: lobby.x1 - 1.1, z: lobby.y0 + 2.2, yaw: -Math.PI/2 },
    ];

    const tryPlace = (pos, radius) => {
      const p = new THREE.Vector3(pos.x, 0, pos.z);
      if (!walk(Math.floor(p.x), Math.floor(p.z))) return null;
      if (this.collideCircleXZ(f, p, radius)) return null;
      return p;
    };    // (Vending machines are spawned separately with a max count, so we don't exceed the cap.)

    // Place a couple wall props near the lobby walls (if textures exist)
    const props = [
      { tex: this.texPottedPlant, scale: 1.0, kind: 'potted_plant' },
      { tex: this.texChair, scale: 0.95, kind: 'chair' },
      { tex: this.texEndTable, scale: 0.9, kind: 'end_table' },
      { tex: this.texStandingComputer, scale: 1.05, kind: 'standing_computer' },
    ].filter(p => !!p.tex);

    const placePlane = (tex, p, yaw, scale, kind) => {
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.15, side: THREE.DoubleSide });
      mat.toneMapped = false;
      const geo = new THREE.PlaneGeometry(1.35*scale, 1.35*scale);
      const m = new THREE.Mesh(geo, mat);
      const yOffset =
        (kind === 'chair') ? 0.42 :
        (kind === 'end_table') ? 0.48 :
        (kind === 'standing_computer') ? 0.55 :
        0.58;
      m.position.set(p.x, y0 + yOffset*scale, p.z);
      m.rotation.y = yaw;
      m.userData.floor = f;
      m.userData.kind = kind;
      this.spriteGroup.add(m);

      const bb = new THREE.Box3().setFromObject(m);
      bb.expandByVector(new THREE.Vector3(0.45*scale, 1.30*scale, 0.45*scale));
      bb.min.y = y0;
      bb.max.y = y0 + 2.6;
      const propCol = {
        min: bb.min.clone(),
        max: bb.max.clone(),
        tag: 'prop',
        mesh: m,
        half: new THREE.Vector3((bb.max.x-bb.min.x)*0.5, (bb.max.y-bb.min.y)*0.5, (bb.max.z-bb.min.z)*0.5),
        center: new THREE.Vector3((bb.min.x+bb.max.x)*0.5, (bb.min.y+bb.max.y)*0.5, (bb.min.z+bb.max.z)*0.5),
        vel: new THREE.Vector3(),
        active: true,
        floor: f,
        unbreakable: true,
        // movable like other furniture
        subkind: kind,
      };
      this.colliders.push(propCol);
      this.props.push(propCol);
    };

    if (props.length) {
      // Place one of each prop (if available) near lobby walls so you always see them.
      for (let i=0; i<props.length; i++) {
        const c = candidates[(2 + i) % candidates.length]; // use 4 wall-adjacent candidates
        const p = tryPlace(c, 0.55);
        if (!p) continue;
        const pr = props[i];
        placePlane(pr.tex, p, c.yaw, pr.scale, pr.kind);
      }
    }
  }


  _createVendingMachine(x, z, f, y0, donutsLeft=2, yaw=0) {
    // Black box body with a textured front face.
    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. We use +Z as "front".
    const blackMat = this.vendingBlackMat || new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.95,
      metalness: 0.05,
      emissive: 0x000000,
      emissiveIntensity: 0.0,
    });
    this.vendingBlackMat = blackMat;

    // The vending front is a flat sprite-like graphic; keep it unlit so it doesn't look dim.
    const frontMat = this.vendingFrontMat || new THREE.MeshBasicMaterial({
      map: this.texVendingFront || null,
      transparent: true,
      alphaTest: 0.15,
      side: THREE.FrontSide,
    });
    // Avoid tone-mapping darkening on UI-like textures.
    frontMat.toneMapped = false;
    if (frontMat.map !== this.texVendingFront) frontMat.map = this.texVendingFront || null;
    this.vendingFrontMat = frontMat;

    // Slightly larger so it doesn't look too short.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.45, 3.85, 0.90),
      [blackMat, blackMat, blackMat, blackMat, frontMat, blackMat]
    );
    body.position.set(x, y0 + (3.20/2), z);
    body.rotation.y = yaw;
    body.userData.floor = f;
    body.userData.kind = 'vending';
    this.worldGroup.add(body);

    // Collider / prop record
    const bb = new THREE.Box3().setFromObject(body);
    bb.expandByVector(new THREE.Vector3(0.10, 0.06, 0.10));
    const propCol = {
      min: bb.min.clone(),
      max: bb.max.clone(),
      tag: 'prop',
      mesh: body,
      half: new THREE.Vector3((bb.max.x-bb.min.x)*0.5, (bb.max.y-bb.min.y)*0.5, (bb.max.z-bb.min.z)*0.5),
      center: new THREE.Vector3((bb.min.x+bb.max.x)*0.5, (bb.min.y+bb.max.y)*0.5, (bb.min.z+bb.max.z)*0.5),
      vel: new THREE.Vector3(), // present but immovable
      active: true,
      floor: f,
      unbreakable: true,
      immovable: true,
      subkind: 'vending',
      donutsLeft: donutsLeft|0,
    };
    this.colliders.push(propCol);
    this.props.push(propCol);
  }


  // Pick a walkable tile that is adjacent to a wall, then return a world-space position
  // offset so the prop sits against that wall and faces into the room.
  _findWallSpotOnFloor(floor, { preferLobby=false } = {}) {
    if (!floor) return null;
    const { w, h, grid, lobby } = floor;
    const idx = (x,y)=> y*w + x;
    const walk = (x,y) => (x>=0 && y>=0 && x<w && y<h) ? (grid[idx(x,y)]===1) : false;

    const maxTries = 220;
    for (let t=0; t<maxTries; t++) {
      const cx = 2 + ((Math.random()*(w-4))|0);
      const cz = 2 + ((Math.random()*(h-4))|0);
      if (!walk(cx, cz)) continue;

      const inLobby = (cx>=lobby.x0 && cx<=lobby.x1 && cz>=lobby.y0 && cz<=lobby.y1);
      if (preferLobby && !inLobby && Math.random() < 0.75) continue;

      // Determine which wall we're adjacent to (prefer the first one found).
      // We treat non-walkable as wall/solid.
      // Directions: N (-z), S (+z), W (-x), E (+x)
      const dirs = [
        { name: 'N', wx: 0, wz: -1, front: { x: 0, z: +1 }, yaw: 0 },
        { name: 'S', wx: 0, wz: +1, front: { x: 0, z: -1 }, yaw: Math.PI },
        { name: 'W', wx: -1, wz: 0, front: { x: +1, z: 0 }, yaw: Math.PI/2 },
        { name: 'E', wx: +1, wz: 0, front: { x: -1, z: 0 }, yaw: -Math.PI/2 },
      ];
      // shuffle a bit so we don't always pick N first
      for (let i=dirs.length-1;i>0;i--){
        const j = (Math.random()*(i+1))|0;
        const tmp = dirs[i]; dirs[i]=dirs[j]; dirs[j]=tmp;
      }

      let picked = null;
      for (const d of dirs) {
        if (!walk(cx + d.wx, cz + d.wz)) { picked = d; break; }
      }
      if (!picked) continue;

      // Place against the boundary on that side. Use the prop depth of ~0.75.
      const depth = 0.75;
      const gap = 0.05;
      let x = cx + 0.5;
      let z = cz + 0.5;
      if (picked.name === 'N') z = (cz) + (depth/2) + gap;
      if (picked.name === 'S') z = (cz+1) - (depth/2) - gap;
      if (picked.name === 'W') x = (cx) + (depth/2) + gap;
      if (picked.name === 'E') x = (cx+1) - (depth/2) - gap;

      // Verify we're still in walkable space.
      if (!walk(Math.floor(x), Math.floor(z))) continue;

      return { x, z, yaw: picked.yaw };
    }
    return null;
  }


  // Returns true if any collision occurred.
  collideCircleXZ(floorIndex, pos, radius) {
    const colliders = this.colliders;
    let hit = false;
    for (let i=0;i<colliders.length;i++) {
      const c = colliders[i];
      if (!c.active) continue;
      if (c.floor !== floorIndex) continue;
      if (c.tag !== 'wall' && c.tag !== 'prop') continue;

      const cx = Math.max(c.min.x, Math.min(pos.x, c.max.x));
      const cz = Math.max(c.min.z, Math.min(pos.z, c.max.z));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx*dx + dz*dz;
      if (d2 < radius*radius) {
        hit = true;
        const d = Math.sqrt(Math.max(1e-6, d2));
        const push = (radius - d);
        pos.x += (dx/d) * push;
        pos.z += (dz/d) * push;
      }
    }
    return hit;
  }

  // Sweep-test a moving circle against AABBs by stepping.
  // Returns final position and info about the first wall hit (if any).
  moveCircleStepped(floorIndex, pos, vel, radius, dt, steps=4) {
    const out = {
      x: pos.x,
      z: pos.z,
      hitWallId: null,
      hitDir: null,
    };
    const stepDt = dt / Math.max(1, steps|0);
    const p = new THREE.Vector3(pos.x, 0, pos.z);

    for (let s=0; s<steps; s++) {
      const beforeX = p.x;
      const beforeZ = p.z;

      p.x += vel.x * stepDt;
      p.z += vel.z * stepDt;

      // Detect wall overlap BEFORE resolution.
      // collideCircleXZ() pushes out of overlap, which can erase the evidence of which
      // wall was hit (leading to "sometimes it bounces" instead of breaking).
      let preHitWallId = null;
      for (const c of this.colliders) {
        if (!c.active) continue;
        if (c.floor !== floorIndex) continue;
        if (c.tag !== 'wall') continue;
        const cx = Math.max(c.min.x, Math.min(p.x, c.max.x));
        const cz = Math.max(c.min.z, Math.min(p.z, c.max.z));
        const dx = p.x - cx;
        const dz = p.z - cz;
        if ((dx*dx + dz*dz) < radius*radius) { preHitWallId = c.wallId ?? null; break; }
      }

      const collided = this.collideCircleXZ(floorIndex, p, radius);
      if (collided && out.hitWallId == null) {
        out.hitWallId = preHitWallId;
        const n = new THREE.Vector3(beforeX - p.x, 0, beforeZ - p.z);
        if (n.lengthSq() < 1e-6) n.set(-vel.x, 0, -vel.z);
        if (n.lengthSq() < 1e-6) n.set(1,0,0);
        n.normalize();
        out.hitDir = n;
      }
    }

    out.x = p.x;
    out.z = p.z;
    return out;
  }

  _initMaterialsAndSprites() {
    this.floorTex = makeCanvasTexture((ctx,w,h)=>{
      ctx.fillStyle = '#e9eef4'; ctx.fillRect(0,0,w,h);
      for (let y=0;y<h;y+=32){
        for (let x=0;x<w;x+=32){
          const blue = ((x/32 + y/32) % 6 === 0) || ((x/32 + y/32) % 6 === 3);
          ctx.fillStyle = blue ? '#b9d6f1' : '#f2f6fb';
          ctx.fillRect(x,y,32,32);
          ctx.strokeStyle = 'rgba(0,0,0,0.14)';
          ctx.strokeRect(x,y,32,32);
        }
      }
      for (let i=0;i<240;i++){
        const x = Math.random()*w, y = Math.random()*h;
        const r = 10 + Math.random()*40;
        const a = 0.03 + Math.random()*0.06;
        ctx.fillStyle = `rgba(70,60,50,${a})`;
        ctx.beginPath(); ctx.ellipse(x,y,r,r*(0.6+Math.random()*0.7),0,0,Math.PI*2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      for (let i=0;i<1400;i++) ctx.fillRect((Math.random()*w)|0,(Math.random()*h)|0,1,1);
    });

    this.wallTex = makeCanvasTexture((ctx,w,h)=>{
      ctx.fillStyle = '#f5f7fb'; ctx.fillRect(0,0,w,h);
      for (let i=0;i<2200;i++){
        const g = 230 + ((Math.random()*20)|0);
        ctx.fillStyle = `rgba(${g},${g},${g},0.18)`;
        ctx.fillRect((Math.random()*w)|0,(Math.random()*h)|0,2,2);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      for (let y=0;y<h;y+=96){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
      for (let x=0;x<w;x+=96){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      const bandY = Math.floor(h*0.55);
      ctx.fillStyle = 'rgba(135,140,150,0.85)';
      ctx.fillRect(0, bandY-18, w, 36);
      ctx.fillStyle = 'rgba(210,210,216,0.65)';
      ctx.fillRect(0, bandY-14, w, 6);
      ctx.fillStyle = 'rgba(110,115,125,0.55)';
      ctx.fillRect(0,h-34,w,34);
      for (let i=0;i<120;i++){
        const x = Math.random()*w;
        const len = 18 + Math.random()*70;
        ctx.fillStyle = 'rgba(90,75,60,0.06)';
        ctx.fillRect(x, h-34-len, 2+Math.random()*3, len);
      }
    });

    this.ceilTex = makeCanvasTexture((ctx,w,h)=>{
      ctx.fillStyle = '#f7f9fc'; ctx.fillRect(0,0,w,h);
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      for (let y=0;y<h;y+=96){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
      for (let x=0;x<w;x+=96){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for (let i=0;i<1600;i++){
        const g = 245 + ((Math.random()*10)|0);
        ctx.fillStyle = `rgba(${g},${g},${g},0.18)`;
        ctx.fillRect((Math.random()*w)|0,(Math.random()*h)|0,2,2);
      }
      for (let y=48;y<h;y+=192){
        for (let x=48;x<w;x+=192){
          ctx.fillStyle='rgba(255,255,255,0.35)';
          ctx.fillRect(x-34,y-12,68,24);
          ctx.fillStyle='rgba(210,230,255,0.18)';
          ctx.fillRect(x-32,y-10,64,20);
        }
      }
    });

    this.floorMat = new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: 1.0, metalness: 0.0 });
        this.wallMat  = new THREE.MeshStandardMaterial({ map: this.wallTex, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
        this.ceilMat  = new THREE.MeshStandardMaterial({ map: this.ceilTex, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.16 });
    this.debrisMat = new THREE.MeshStandardMaterial({ map: this.wallTex, roughness: 1.0, metalness: 0.0 });

    // furniture sprite textures
    this.texBed = loadSprite('assets/sprites/bed.png');
    this.texIV = loadSprite('assets/sprites/iv_stand.png');    this.texDoor = loadSprite('assets/sprites/door.png');

    // extra wall props (optional: add these PNGs to assets/sprites/)
    this.texPottedPlant = loadSprite('assets/sprites/potted_plant.png');
    this.texChair = loadSprite('assets/sprites/chair.png');
    this.texEndTable = loadSprite('assets/sprites/end_table.png');
    this.texStandingComputer = loadSprite('assets/sprites/standing_computer.png');

    // vending / donut textures (users can replace these files)
    this.texVendingFront = loadSprite('assets/sprites/vending_front.png');
    // Ensure the front displays bright (unlit) and correctly in sRGB.

    // glass crack decal texture (procedural, no external asset required)
    this.texGlassCrack = makeCanvasTexture((ctx,w,h)=>{
      ctx.clearRect(0,0,w,h);
      const cx = w*0.5, cy = h*0.5;
      ctx.lineCap = 'round';

      // main spokes
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.82)';
      ctx.beginPath();
      for (let i=0;i<12;i++){
        const a = (i/12)*Math.PI*2 + (Math.random()*0.25);
        const r = w*(0.22 + Math.random()*0.34);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a)*r, cy + Math.sin(a)*r);
      }
      ctx.stroke();

      // secondary fractures
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.58)';
      for (let k=0;k<30;k++){
        const a = Math.random()*Math.PI*2;
        const r0 = w*(0.08 + Math.random()*0.22);
        const r1 = r0 + w*(0.10 + Math.random()*0.22);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a)*r0, cy + Math.sin(a)*r0);
        const a2 = a + (Math.random()*1.0 - 0.5);
        ctx.lineTo(cx + Math.cos(a2)*r1, cy + Math.sin(a2)*r1);
        ctx.stroke();
      }
    }, 512, 512);
    this.texGlassCrack.colorSpace = THREE.SRGBColorSpace;

  }

  clearWorld(disposeAll=false) {
    while (this.worldGroup.children.length) this.worldGroup.remove(this.worldGroup.children[0]);
    while (this.debrisGroup.children.length) this.debrisGroup.remove(this.debrisGroup.children[0]);
    while (this.spriteGroup.children.length) this.spriteGroup.remove(this.spriteGroup.children[0]);
    this.colliders.length = 0;
    this.breakables.clear();
    this.debris.length = 0;
    this.props.length = 0;
    this.activeFloor = 0;
    if (disposeAll) {
      this.floorTex?.dispose(); this.wallTex?.dispose(); this.ceilTex?.dispose();
      this.floorMat?.dispose(); this.wallMat?.dispose(); this.ceilMat?.dispose();
      this.debrisMat?.dispose();
      this.texBed?.dispose();
      this.texIV?.dispose();
      this.texDoor?.dispose();
      this.texPottedPlant?.dispose();
      this.texChair?.dispose();
      this.texEndTable?.dispose();
      this.texStandingComputer?.dispose();
      this.texVendingFront?.dispose();
    }
  }

  setActiveFloor(floorIndex) {
    this.activeFloor = floorIndex;
    for (const ch of this.worldGroup.children) ch.visible = (ch.userData.floor === floorIndex);
    for (const d of this.debrisGroup.children) d.visible = (d.userData.floor === floorIndex);
    for (const s of this.spriteGroup.children) s.visible = (s.userData.floor === floorIndex);
  }

  build(world) {
    this.world = world;
    const tile = 1.0;
    const wallH = 3.0;
    this.wallH = wallH;
    const wallT = 0.18;
    const levelY = (f) => f * 4.2;
    this.levelY = levelY;

    let wallIdCounter = 1;

    for (let f=0; f<world.floors.length; f++) {
      const floor = world.floors[f];
      const { w, h, grid } = floor;
      const y0 = levelY(f);

      // floor plane
      const floorGeo = new THREE.PlaneGeometry(w*tile, h*tile);
      this.floorTex.repeat.set(w/8, h/8);
      const floorMesh = new THREE.Mesh(floorGeo, this.floorMat);
      floorMesh.rotation.x = -Math.PI/2;
      floorMesh.position.set((w*tile)/2, y0, (h*tile)/2);
      floorMesh.userData.floor = f;
      this.worldGroup.add(floorMesh);

      // ceiling
      const ceilGeo = new THREE.PlaneGeometry(w*tile, h*tile);
      this.ceilTex.repeat.set(w/8, h/8);
      const ceilMesh = new THREE.Mesh(ceilGeo, this.ceilMat);
      ceilMesh.rotation.x = Math.PI/2;
      ceilMesh.position.set((w*tile)/2, y0 + wallH, (h*tile)/2);
      ceilMesh.userData.floor = f;
      this.worldGroup.add(ceilMesh);

      
      // Outer, non-breakable perimeter shell
      this._buildOuterShell(floor, f, y0);
// walls
      const wallGeoX = new THREE.BoxGeometry(tile, wallH, wallT);
      const wallGeoZ = new THREE.BoxGeometry(wallT, wallH, tile);

      const idx = (x,y)=> y*w + x;
      const walk = (x,y) => (x>=0 && y>=0 && x<w && y<h) ? (grid[idx(x,y)]===1) : false;

      const addWall = (geo, px, pz, id) => {
        const mesh = new THREE.Mesh(geo, this.wallMat);
        mesh.position.set(px, y0 + wallH/2, pz);
        mesh.userData.floor = f;
        mesh.userData.wallId = id;
        this.worldGroup.add(mesh);

        const bb = new THREE.Box3().setFromObject(mesh);
        const colliderIndex = this.colliders.length;
        this.colliders.push({
          min: bb.min.clone(), max: bb.max.clone(),
          tag: 'wall', active: true, wallId: id, floor: f
        });
        this.breakables.set(id, { mesh, hp: 90, colliderIndex, aabb: bb, floor: f });
      };

      for (let y=0;y<h;y++){
        for (let x=0;x<w;x++){
          if (!walk(x,y)) continue;
          const cx = x*tile + tile/2;
          const cz = y*tile + tile/2;

          if (!walk(x, y-1)) addWall(wallGeoX, cx, cz - tile/2, wallIdCounter++);
          if (!walk(x, y+1)) addWall(wallGeoX, cx, cz + tile/2, wallIdCounter++);
          if (!walk(x-1, y)) addWall(wallGeoZ, cx - tile/2, cz, wallIdCounter++);
          if (!walk(x+1, y)) addWall(wallGeoZ, cx + tile/2, cz, wallIdCounter++);
        }
      }

      // Lobby decoration (3D desk)
      const lobby = floor.lobby;
      const desk = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 1.1, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x2c323e, roughness: 1.0 })
      );
      desk.position.set((lobby.x0+3.6)*tile, y0 + 0.55, (lobby.y0+2.8)*tile);
      desk.userData.floor = f;
      this.worldGroup.add(desk);

      const elev = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55,0.55,0.06,24),
        new THREE.MeshStandardMaterial({ color: 0x64d564, emissive: 0x175917, emissiveIntensity: 0.9, roughness: 0.6 })
      );
      elev.userData.floor = f;
      this.worldGroup.add(elev);

      // Overhead lights placed along corridors/lobby
            if (this._spawnLightsForFloor) this._spawnLightsForFloor(floor, f, y0);

      // Furniture sprites placed in realistic spots
      
                  if (this._spawnFurnitureForFloor) this._spawnFurnitureForFloor(floor, f, y0);
      // Vending machine + decorative wall props
      if (f === 0) this.spawnGuaranteedLobbyProps(floor, f, y0);
      // Random extras (adds variety)
      this.spawnVendingMachinesForFloor(floor, f, y0, (f===0) ? (1 + ((Math.random()*2)|0)) : 0);
      this.spawnWallPropsForFloor(floor, f, y0, 8);

      if (this._spawnDoorSprites) this._spawnDoorSprites(floor, f, y0);
    }

    this.setActiveFloor(world.activeFloor);
  }

  _spawnLightsForFloor(floor, f, y0) {
    const { w, h, grid, lobby } = floor;
    const idx = (x,y)=> y*w + x;
    const walk = (x,y) => (x>=0 && y>=0 && x<w && y<h) ? (grid[idx(x,y)]===1) : false;

    const target = 44;
    let placed = 0;
    const tries = 2600;

    for (let t=0; t<tries && placed<target; t++) {
      const x = 2 + ((Math.random()*(w-4))|0);
      const y = 2 + ((Math.random()*(h-4))|0);
      if (!walk(x,y)) continue;

      const inLobby = (x>=lobby.x0 && x<=lobby.x1 && y>=lobby.y0 && y<=lobby.y1);
      if (!inLobby && Math.random() < 0.92) continue;

      const px = x + 0.5, pz = y + 0.5;

      // avoid clustering
      let ok = true;
      for (const ch of this.worldGroup.children) {
        if (ch.userData && ch.userData.kind === 'light' && ch.userData.floor === f) {
          const dx = ch.position.x - px;
          const dz = ch.position.z - pz;
          if (dx*dx + dz*dz < 5.8*5.8) { ok = false; break; }
        }
      }
      if (!ok) continue;

      // Brighter interior lighting.
      const light = new THREE.PointLight(0xe8f4ff, inLobby ? 0.95 : 0.75, inLobby ? 14 : 11, 2.0);
      light.position.set(px, y0 + 2.85, pz);
      light.userData.floor = f;
      light.userData.kind = 'light';
      this.worldGroup.add(light);

      // small emissive ceiling panel
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.18),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xffffff,
          emissiveIntensity: 0.75,
          roughness: 0.6,
          side: THREE.DoubleSide
        })
      );
      panel.rotation.x = Math.PI/2;
      panel.position.set(px, y0 + 2.98, pz);
      panel.userData.floor = f;
      panel.userData.kind = 'lightPanel';
      this.worldGroup.add(panel);

      placed++;
    }
  }


  _spawnFurnitureForFloor(floor, f, y0) {
    const { w, h, grid, rooms, lobby } = floor;
    const idx = (x,y)=> y*w + x;
    const walk = (x,y) => (x>=0 && y>=0 && x<w && y<h) ? (grid[idx(x,y)]===1) : false;

    const placeSprite = (tex, x, z, scale=1.0) => {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
                alphaTest: 0.15,
        side: THREE.DoubleSide,
      });
      tex.premultiplyAlpha = true;
      const geo = new THREE.PlaneGeometry(1.4*scale, 1.4*scale);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y0 + 0.7*scale, z);
      m.userData.floor = f;
      this.spriteGroup.add(m);

      // Add simple AABB collider so the player/patients can't pass through.
      // Planes have near-zero thickness; expand a bit to make collision robust.
      const bb = new THREE.Box3().setFromObject(m);
      bb.expandByVector(new THREE.Vector3(0.45*scale, 0.9*scale, 0.45*scale));
      const propCol = {
        min: bb.min.clone(),
        max: bb.max.clone(),
        tag: 'prop',
        mesh: m,
        half: new THREE.Vector3((bb.max.x-bb.min.x)*0.5, (bb.max.y-bb.min.y)*0.5, (bb.max.z-bb.min.z)*0.5),
        center: new THREE.Vector3((bb.min.x+bb.max.x)*0.5, (bb.min.y+bb.max.y)*0.5, (bb.min.z+bb.max.z)*0.5),
        vel: new THREE.Vector3(),
        active: true,
        floor: f,
        unbreakable: true,
      };
      this.colliders.push(propCol);
      this.props.push(propCol);

      return m;
    };

    // Beds in patient rooms (larger rooms), near a wall
    for (const r of rooms) {
      const rw = (r.x1 - r.x0);
      const rh = (r.y1 - r.y0);
      if (rw < 6 || rh < 6) continue;
      if (Math.random() < 0.35) continue;

      const side = (Math.random()*4)|0;
      let bx = ((r.x0+r.x1)*0.5) + 0.5;
      let bz = ((r.y0+r.y1)*0.5) + 0.5;

      if (side === 0) { bx = r.x0 + 1.6; bz = ((r.y0+r.y1)*0.5)+0.5; }
      if (side === 1) { bx = r.x1 - 1.6; bz = ((r.y0+r.y1)*0.5)+0.5; }
      if (side === 2) { bx = ((r.x0+r.x1)*0.5)+0.5; bz = r.y0 + 1.6; }
      if (side === 3) { bx = ((r.x0+r.x1)*0.5)+0.5; bz = r.y1 - 1.6; }

      if (!walk(Math.floor(bx), Math.floor(bz))) continue;

      placeSprite(this.texBed, bx, bz, 1.35);

      const ivx = bx + (Math.random()<0.5 ? 0.9 : -0.9);
      const ivz = bz + (Math.random()<0.5 ? 0.6 : -0.6);
      if (walk(Math.floor(ivx), Math.floor(ivz))) placeSprite(this.texIV, ivx, ivz, 1.05);
    }

    // IV stands in corridors occasionally
    for (let i=0;i<22;i++){
      const x = 2 + ((Math.random()*(w-4))|0) + 0.5;
      const z = 2 + ((Math.random()*(h-4))|0) + 0.5;
      if (!walk(Math.floor(x), Math.floor(z))) continue;
      if (Math.random() < 0.86) continue;
      placeSprite(this.texIV, x, z, 1.0);
    }
  }

  // Returns true if a world-space (x,z) point is in a walkable grid cell on the given floor.
  // In this prototype, floor.grid uses 1 = walkable, 0 = solid.
  isWalkableWorld(floorIndex, x, z) {
    const floor = this.world?.floors?.[floorIndex];
    if (!floor) return true; // fail-open if world not ready
    const { w, h, grid } = floor;
    if (!w || !h || !grid) return true;
    const gx = Math.floor(x);
    const gz = Math.floor(z);
    if (gx < 0 || gz < 0 || gx >= w || gz >= h) return false;
    return grid[gz * w + gx] === 1;
  }



  findNearestWalkable(floorIndex, x, z, maxR=18) {
    const floor = this.game.world.floors[floorIndex];
    const { w, h, grid } = floor;
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const idx = (xx,yy)=> yy*w + xx;
    const walk = (xx,yy)=> (xx>=0 && yy>=0 && xx<w && yy<h) ? (grid[idx(xx,yy)]===1) : false;

    if (walk(ix, iz)) return { x: ix + 0.5, z: iz + 0.5 };

    for (let r=1; r<=maxR; r++) {
      for (let dz=-r; dz<=r; dz++) {
        for (let dx=-r; dx<=r; dx++) {
          if (Math.abs(dx)!==r && Math.abs(dz)!==r) continue;
          const xx = ix + dx, yy = iz + dz;
          if (walk(xx,yy)) return { x: xx + 0.5, z: yy + 0.5 };
        }
      }
    }
    // fallback: lobby center
    const l = floor.lobby;
    return { x: (l.x0 + l.x1)*0.5 + 0.5, z: (l.y0 + l.y1)*0.5 + 0.5 };
  }


  _buildOuterShell(floor, f, y0) {
    const { w, h } = floor;
        const wallH = 6.0;
    const thick = 0.70;

    // Transparent glass perimeter so you can see the city skyline outside
    // Use an unlit material so the glass doesn't look dark (no envMap needed).
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9fd7ff,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    mat.toneMapped = false;

    const addColliderForMesh = (mesh, wallId) => {
      const bb = new THREE.Box3().setFromObject(mesh);
      this.colliders.push({
        min: bb.min.clone(),
        max: bb.max.clone(),
        tag: 'wall',
        active: true,
        wallId,
        floor: f,
        unbreakable: true,
      });
    };

    const makeWall = (x, z, sx, sz, wallId) => {
      const geo = new THREE.BoxGeometry(sx, wallH, sz);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y0 + wallH/2, z);
      mesh.userData.floor = f;
      mesh.userData.wallId = wallId;
      this.worldGroup.add(mesh);
      addColliderForMesh(mesh, wallId);
    };

    // Our tile/world space is [0..w] x [0..h] with floor centered at (w/2,h/2)
    const centerX = w/2;
    const centerZ = h/2;
    const minX = 0, maxX = w;
    const minZ = 0, maxZ = h;

    // North/South
    makeWall(centerX, minZ - thick/2, w + thick*2, thick, -(1000 + f*10 + 0));
    makeWall(centerX, maxZ + thick/2, w + thick*2, thick, -(1000 + f*10 + 1));
    // West/East
    makeWall(minX - thick/2, centerZ, thick, h + thick*2, -(1000 + f*10 + 2));
    makeWall(maxX + thick/2, centerZ, thick, h + thick*2, -(1000 + f*10 + 3));
  }


  _spawnGlassCrackDecal(worldPos, normal, size=0.9, opacity=0.9, rotJitter=true) {
    if (!this.texGlassCrack) return null;

    const mat = new THREE.MeshBasicMaterial({
      map: this.texGlassCrack,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.toneMapped = false;

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);

    const n = (normal || new THREE.Vector3(0,0,1)).clone().normalize();
    const yaw = Math.atan2(n.x, n.z);
    mesh.rotation.y = yaw;

    if (rotJitter) mesh.rotation.z = (Math.random()*2-1) * 0.35;

    mesh.position.copy(worldPos).add(n.multiplyScalar(0.02));
    mesh.userData.floor = this.activeFloor;
    mesh.userData.kind = 'glassCrack';

    this.worldGroup.add(mesh);

    return mesh;
  }

  // Add a crack decal. If you punch near an existing crack, it "spreads":
  // we add branching crack decals around the impact and intensify the nearest crack.
  addGlassCrackSpread(worldPos, normal) {
    if (!this._glassCracks) this._glassCracks = [];

    const pos = worldPos.clone();
    const n = (normal || new THREE.Vector3(0,0,1)).clone().normalize();

    // Find nearest existing crack within radius
    let nearest = null;
    let bestD2 = 1e9;
    for (const c of this._glassCracks) {
      if (!c.mesh) continue;
      if (c.floor !== this.activeFloor) continue;
      const dx = c.pos.x - pos.x;
      const dz = c.pos.z - pos.z;
      const d2 = dx*dx + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; nearest = c; }
    }

    const nearR = 1.15;
    const isNear = nearest && bestD2 < (nearR*nearR);

    // Primary crack at hit
    const baseSize = isNear ? (0.75 + (nearest.level|0)*0.08) : 0.95;
    const baseOpacity = isNear ? 0.95 : 0.90;
    const primaryMesh = this._spawnGlassCrackDecal(pos, n, baseSize, baseOpacity, true);

    // Track crack entry
    const entry = { mesh: primaryMesh, pos: pos.clone(), floor: this.activeFloor, level: 0 };
    if (isNear) {
      nearest.level = (nearest.level|0) + 1;

      // Intensify nearest crack slightly (more visible)
      try {
        if (nearest.mesh?.material) nearest.mesh.material.opacity = Math.min(1.0, 0.85 + nearest.level*0.06);
        if (nearest.mesh) nearest.mesh.scale.setScalar(Math.min(1.35, 1.0 + nearest.level*0.05));
      } catch (e) {}

      entry.level = Math.min(5, nearest.level|0);

      // Spread: add branching decals around the impact point
      const branches = Math.min(6, 2 + (nearest.level|0));
      const t = new THREE.Vector3(-n.z, 0, n.x).normalize(); // tangent along the glass plane
      const b = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), n).normalize(); // bitangent along the glass plane
      for (let i=0;i<branches;i++){
        const a = Math.random()*Math.PI*2;
        const r = 0.22 + Math.random()*0.85;
        const offset = t.clone().multiplyScalar(Math.cos(a)*r).add(b.clone().multiplyScalar(Math.sin(a)*r));
        const p2 = pos.clone().add(offset);

        const sz = 0.28 + Math.random()*0.55;
        const op = 0.45 + Math.random()*0.40;
        this._spawnGlassCrackDecal(p2, n, sz, op, true);
      }
    }

    this._glassCracks.push(entry);

    // limit decals so we don't spam
    const MAX = 70;
    while (this._glassCracks.length > MAX) {
      const old = this._glassCracks.shift();
      if (old?.mesh?.parent) old.mesh.parent.remove(old.mesh);
    }
  }


  getFloorY(floorIndex) { return this.levelY ? this.levelY(floorIndex) : 0; }
  getCeilY(floorIndex) { return this.getFloorY(floorIndex) + (this.wallH || 3.0); }

  update(dt) {
    // face camera for furniture sprites
    const q = this.game.camera.quaternion;
    for (const s of this.spriteGroup.children) {
      if (s.userData.floor !== this.activeFloor) continue;
      s.quaternion.copy(q);
    }

    // debris physics
    const g = 18;
    for (let i=this.debris.length-1;i>=0;i--){
      const d = this.debris[i];
      d.ttl -= dt;
      if (d.ttl <= 0) {
        this.debrisGroup.remove(d.mesh);
        this.debris.splice(i,1);
        continue;
      }

      d.vel.y -= g * dt;
      d.mesh.position.x += d.vel.x * dt;
      d.mesh.position.y += d.vel.y * dt;
      d.mesh.position.z += d.vel.z * dt;

      d.mesh.rotation.x += d.ang.x * dt;
      d.mesh.rotation.y += d.ang.y * dt;
      d.mesh.rotation.z += d.ang.z * dt;

      const floorY = this.getFloorY(d.floor);
      const hh = d.halfH;
      if (d.mesh.position.y < floorY + hh) {
        d.mesh.position.y = floorY + hh;
        d.vel.y *= -0.22;
        d.vel.x *= 0.72;
        d.vel.z *= 0.72;
        d.ang.multiplyScalar(0.85);
        if (Math.abs(d.vel.y) < 0.8 && (d.vel.x*d.vel.x + d.vel.z*d.vel.z) < 0.2) {
          d.vel.set(0,0,0);
          d.ang.set(0,0,0);
        }
      }

      d.mesh.visible = (d.floor === this.activeFloor);
    }
    // pushable props update (beds / IV stands)
    for (const pr of this.props) {
      if (!pr.active) continue;
      if (pr.floor !== this.activeFloor) continue;

      const preX = pr.mesh.position.x;
      const preZ = pr.mesh.position.z;

      // Integrate
      pr.mesh.position.x += pr.vel.x * dt;
      pr.mesh.position.z += pr.vel.z * dt;

      // Strong damping so props settle quickly
      pr.vel.x *= Math.pow(0.03, dt);
      pr.vel.z *= Math.pow(0.03, dt);

      pr.mesh.position.y = this.getFloorY(pr.floor) + 0.8;

      // Stable AABB derived from cached half-extents (no setFromObject jitter)
      const bb = new THREE.Box3(
        new THREE.Vector3(pr.mesh.position.x - pr.half.x, pr.mesh.position.y - pr.half.y, pr.mesh.position.z - pr.half.z),
        new THREE.Vector3(pr.mesh.position.x + pr.half.x, pr.mesh.position.y + pr.half.y, pr.mesh.position.z + pr.half.z)
      );

      const speedXZ = Math.hypot(pr.vel.x, pr.vel.z);

      // Resolve overlaps against walls. If we hit hard, break and STOP (no jitter/bounce).
      let brokeWall = false;

      // Do multiple resolution passes; if we still overlap after all passes, snap back and stop.
// This prevents "edge jitter" when a prop wedges into a corner or thin wall.
      const MAX_PASSES = 6;
      let hadOverlap = false;

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        let anyOverlap = false;

        for (const c of this.colliders) {
          if (!c.active) continue;
          if (c.floor !== pr.floor) continue;
          if (c.tag !== 'wall') continue;

          // AABB overlap test on X/Z
          if (bb.max.x < c.min.x || bb.min.x > c.max.x) continue;
          if (bb.max.z < c.min.z || bb.min.z > c.max.z) continue;

          anyOverlap = true;
          hadOverlap = true;

          const canBreak = (c.wallId != null && c.wallId > 0);
          if (canBreak && speedXZ > 4.6) {
            // Hard impact: break the wall and freeze the prop at the pre-impact position.
            const dir = new THREE.Vector3(pr.mesh.position.x - preX, 0, pr.mesh.position.z - preZ);
            if (dir.lengthSq() < 1e-6) dir.set(pr.vel.x, 0, pr.vel.z);
            if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
            dir.normalize();

            this.damageWall(c.wallId, 220, dir);

            // kill patient near impact point
            const ix = pr.mesh.position.x;
            const iz = pr.mesh.position.z;
            for (const p of this.game.patientManager.patients) {
              if (p.floor !== pr.floor || p.isDown) continue;
              const dx = p.x - ix;
              const dz = p.z - iz;
              if (dx*dx + dz*dz < 1.35*1.35) {
                p.applyDamage(999, 'propImpact', dir);
                p.vel.add(dir.clone().multiplyScalar(6));
              }
            }

            pr.mesh.position.x = preX;
            pr.mesh.position.z = preZ;
            pr.vel.x = 0;
            pr.vel.z = 0;

            // Rebuild bb at the stopped position
            bb.min.set(preX - pr.half.x, pr.mesh.position.y - pr.half.y, preZ - pr.half.z);
            bb.max.set(preX + pr.half.x, pr.mesh.position.y + pr.half.y, preZ + pr.half.z);

            brokeWall = true;
            break;
          }

          // Soft contact: push out along shallow axis and STOP motion into the wall.
          const penX1 = c.max.x - bb.min.x;
          const penX2 = bb.max.x - c.min.x;
          const penZ1 = c.max.z - bb.min.z;
          const penZ2 = bb.max.z - c.min.z;

          const pushX = (penX1 < penX2) ? -penX1 : penX2;
          const pushZ = (penZ1 < penZ2) ? -penZ1 : penZ2;

          const ax = Math.abs(pushX);
          const az = Math.abs(pushZ);

          // If tie, choose axis based on which velocity component is larger to avoid alternation/jitter.
          if (ax < az || (ax === az && Math.abs(pr.vel.x) >= Math.abs(pr.vel.z))) {
            pr.mesh.position.x += pushX;
            pr.vel.x = 0;
          } else {
            pr.mesh.position.z += pushZ;
            pr.vel.z = 0;
          }

          // Update bb after push
          bb.min.set(pr.mesh.position.x - pr.half.x, pr.mesh.position.y - pr.half.y, pr.mesh.position.z - pr.half.z);
          bb.max.set(pr.mesh.position.x + pr.half.x, pr.mesh.position.y + pr.half.y, pr.mesh.position.z + pr.half.z);
        }

        if (brokeWall) break;
        if (!anyOverlap) break;
      }

      // If we are STILL overlapping after resolution passes (wedged), snap back and stop completely.
      if (!brokeWall && hadOverlap) {
        let stillOverlapping = false;
        for (const c of this.colliders) {
          if (!c.active) continue;
          if (c.floor !== pr.floor) continue;
          if (c.tag !== 'wall') continue;
          if (bb.max.x < c.min.x || bb.min.x > c.max.x) continue;
          if (bb.max.z < c.min.z || bb.min.z > c.max.z) continue;
          stillOverlapping = true;
          break;
        }
        if (stillOverlapping) {
          pr.mesh.position.x = preX;
          pr.mesh.position.z = preZ;
          pr.vel.x = 0;
          pr.vel.z = 0;
          bb.min.set(preX - pr.half.x, pr.mesh.position.y - pr.half.y, preZ - pr.half.z);
          bb.max.set(preX + pr.half.x, pr.mesh.position.y + pr.half.y, preZ + pr.half.z);
        }
      }

      // Update collider bounds
      pr.min.copy(bb.min);
      pr.max.copy(bb.max);

      // Hard sleep: if basically stopped, fully stop to prevent wall "creep"
      if (Math.hypot(pr.vel.x, pr.vel.z) < 0.02) {
        pr.vel.x = 0;
        pr.vel.z = 0;
      }
    }

  }


  raycast(origin, dir, maxDist, flags={ patients:true, walls:true }) {
    let best = null;

    if (flags.walls !== false) {
      for (const [id, w] of this.breakables.entries()) {
        if (w.floor !== this.activeFloor) continue;
        if (!w.mesh.visible) continue;

        const t = rayAABB(origin, dir, w.aabb.min, w.aabb.max);
        if (t !== null && t >= 0 && t <= maxDist) {
          if (!best || t < best.t) best = { t, type: 'wall', wallId: id };
        }
      }
    }

      // also allow hitting the outer glass shell (unbreakable wall colliders)
      for (const c of this.colliders) {
        if (!c.active) continue;
        if (c.floor !== this.activeFloor) continue;
        if (c.tag !== 'wall') continue;
        if (!c.unbreakable) continue;
        const t = rayAABB(origin, dir, c.min, c.max);
        if (t !== null && t >= 0 && t <= maxDist) {
          if (!best || t < best.t) best = { t, type: 'glass', collider: c };
        }
      }

    if (flags.patients !== false) {
      const ph = this.game.patientManager.raycast(origin, dir, maxDist);
      if (ph && (!best || ph.t < best.t)) best = ph;
    }

    // props (beds / IV stands)
    if (flags.props !== false) {
      for (const pr of this.props) {
        if (!pr.active) continue;
        if (pr.floor !== this.activeFloor) continue;
        const t = rayAABB(origin, dir, pr.min, pr.max);
        if (t !== null && t >= 0 && t <= maxDist) {
          if (!best || t < best.t) best = { t, type: 'prop', prop: pr };
        }
      }
    }

    return best;
  }

  damageWall(wallId, amount, dir) {
    const w = this.breakables.get(wallId);
    if (!w) return;
    w.hp -= amount;
    if (w.hp <= 0) this._breakWall(wallId, dir);
    else this._chipWall(w, dir);
  }

  _chipWall(w, dir) {
    const rng = randFromSeed((w.mesh.userData.wallId * 9973) ^ (Date.now()|0));
    const n = 2 + ((rng()*4)|0);
    for (let i=0;i<n;i++){
      this._spawnShard(w, dir, 0.06 + rng()*0.08);
    }
  }

  _breakWall(wallId, dir) {
    const w = this.breakables.get(wallId);
    if (!w) return;

    w.mesh.visible = false;
    const c = this.colliders[w.colliderIndex];
    if (c) c.active = false;

    const rng = randFromSeed((wallId * 1315423911) ^ (this.game.world.seed|0));
    const count = 18 + ((rng()*22)|0);
    for (let i=0;i<count;i++){
      this._spawnShard(w, dir, 0.10 + rng()*0.22);
    }
    for (let i=0;i<12;i++){
      this._spawnShard(w, dir, 0.04 + rng()*0.06, 0.6);
    }
  }

  _spawnShard(w, dir, size=0.15, ttl=7.5) {
    if (this.debris.length > this.maxDebris) {
      const old = this.debris.shift();
      this.debrisGroup.remove(old.mesh);
    }

    const bb = w.aabb;
    const cx = (bb.min.x + bb.max.x) * 0.5;
    const cy = (bb.min.y + bb.max.y) * 0.5;
    const cz = (bb.min.z + bb.max.z) * 0.5;

    const rand = Math.random;
    const sx = Math.max(0.05, size * (0.6 + rand()*1.1));
    const sy = Math.max(0.05, size * (0.6 + rand()*1.1));
    const sz = Math.max(0.03, size * (0.4 + rand()*0.9));

    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geo, this.debrisMat);

    mesh.position.set(
      cx + (rand()*0.8 - 0.4) * (bb.max.x - bb.min.x),
      cy + (rand()*0.8 - 0.4) * (bb.max.y - bb.min.y),
      cz + (rand()*0.8 - 0.4) * (bb.max.z - bb.min.z)
    );

    mesh.rotation.set(rand()*Math.PI, rand()*Math.PI, rand()*Math.PI);
    mesh.userData.floor = w.floor;
    mesh.visible = (w.floor === this.activeFloor);

    const spread = 0.9;
    const vel = new THREE.Vector3(
      dir.x * (6 + rand()*6) + (rand()*2-1)*spread,
      2.6 + rand()*3.6,
      dir.z * (6 + rand()*6) + (rand()*2-1)*spread
    );
    const ang = new THREE.Vector3((rand()*2-1)*6, (rand()*2-1)*6, (rand()*2-1)*6);

    this.debrisGroup.add(mesh);
    this.debris.push({ mesh, vel, ang, ttl: ttl*(0.7+rand()*0.6), floor: w.floor, halfH: sy/2 });
  }
}

function rayAABB(o, d, bmin, bmax) {
  let tmin = -Infinity, tmax = Infinity;
  for (const ax of ['x','y','z']) {
    const inv = 1.0 / (d[ax] || 1e-9);
    let t1 = (bmin[ax] - o[ax]) * inv;
    let t2 = (bmax[ax] - o[ax]) * inv;
    if (t1 > t2) { const tmp=t1; t1=t2; t2=tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? 0 : null;
}
