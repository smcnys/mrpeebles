import * as THREE from 'three';

// Lightweight "GPU-ish" particle bursts:
// - Each burst is a THREE.Points with per-particle start position + velocity attributes
// - Motion is computed in the vertex shader with a time uniform (no CPU per-particle updates)
//
// This keeps it simple + fast for lots of tiny bursts.
export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
    this.time = 0;
  }

  clear() {
    for (const b of this.bursts) {
      this.scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
    }
    this.bursts.length = 0;
  }

  update(dt) {
    this.time += dt;
    for (let i=this.bursts.length-1; i>=0; i--) {
      const b = this.bursts[i];
      const age = this.time - b.t0;
      b.points.material.uniforms.uTime.value = age;

      // fade
      const life = b.points.material.uniforms.uLife.value;
      const a = Math.max(0, 1 - age / life);
      b.points.material.uniforms.uAlpha.value = a;

      if (age >= life) {
        this.scene.remove(b.points);
        b.points.geometry.dispose();
        b.points.material.dispose();
        this.bursts.splice(i,1);
      }
    }
  }

  spawnBlood(x, y, z, dir=null, strength=1.0) {
    const count = Math.max(14, Math.min(60, Math.floor(22 * strength)));
    const start = new Float32Array(count * 3);
    const vel   = new Float32Array(count * 3);
    const seed  = new Float32Array(count);

    const rand = Math.random;
    const baseDir = dir ? dir.clone().normalize() : new THREE.Vector3(0, 1, 0);

    for (let i=0;i<count;i++) {
      const ix=i*3;
      start[ix+0] = x + (rand()*0.16 - 0.08);
      start[ix+1] = y + (rand()*0.16 - 0.08);
      start[ix+2] = z + (rand()*0.16 - 0.08);

      // random spray around baseDir
      const v = new THREE.Vector3(rand()*2-1, rand()*2-1, rand()*2-1).normalize();
      v.add(baseDir.clone().multiplyScalar(0.9 + rand()*1.2));
      v.normalize();

      const sp = (2.0 + rand()*3.2) * (0.8 + strength*0.5);
      vel[ix+0] = v.x * sp;
      vel[ix+1] = Math.abs(v.y) * sp * 1.2;
      vel[ix+2] = v.z * sp;

      seed[i] = rand();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
    geo.setAttribute('aVel',   new THREE.BufferAttribute(vel,   3));
    geo.setAttribute('aSeed',  new THREE.BufferAttribute(seed,  1));

    // initial position comes from shader; but THREE requires a position attribute
    geo.setAttribute('position', new THREE.BufferAttribute(start.slice(0), 3));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime:  { value: 0 },
        uLife:  { value: 0.65 + strength*0.12 },
        uSize:  { value: 1.6 },    // pixels (smaller)
        uAlpha: { value: 1.0 },
        uGravity: { value: 9.5 },
      },
      vertexShader: `
        attribute vec3 aStart;
        attribute vec3 aVel;
        attribute float aSeed;

        uniform float uTime;
        uniform float uLife;
        uniform float uSize;
        uniform float uGravity;

        varying float vLife;

        // small hash for jitter
        float hash(float n){ return fract(sin(n)*43758.5453123); }

        void main() {
          float t = clamp(uTime, 0.0, uLife);

          // ballistic motion
          vec3 p = aStart + aVel * t;
          p.y -= 0.5 * uGravity * t * t;

          // a tiny sideways curl
          float h = hash(aSeed*17.13);
          p.x += (h - 0.5) * 0.18 * t;
          p.z += (hash(aSeed*91.7) - 0.5) * 0.18 * t;

          vLife = 1.0 - (t / uLife);

          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;

          // size attenuates with distance
        float size = uSize * (0.55 + 0.35*h) * (0.45 + 0.55*vLife);
          gl_PointSize = size * (140.0 / -mvPosition.z);
        }
      `,
      fragmentShader: `
        precision mediump float;
        uniform float uAlpha;
        varying float vLife;

        void main() {
          // circular point sprite
          vec2 uv = gl_PointCoord.xy - 0.5;
          float r = dot(uv, uv);
          if (r > 0.25) discard;

          // soft edge
          float edge = smoothstep(0.25, 0.06, r);

          // deep red center -> slightly brighter edge
          vec3 col = mix(vec3(0.85,0.03,0.03), vec3(1.0,0.12,0.12), 1.0 - edge);

          float a = uAlpha * edge * (0.35 + 0.65*vLife);
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);

    this.bursts.push({ points: pts, t0: this.time });
  }


  // Dust burst for wall punches/impacts (small gray-beige puffs)
  spawnDust(x, y, z, dir=null, strength=1.0) {
    const count = Math.max(10, Math.min(46, Math.floor(18 * strength)));
    const start = new Float32Array(count * 3);
    const vel   = new Float32Array(count * 3);
    const seed  = new Float32Array(count);

    const rand = Math.random;
    const baseDir = dir ? dir.clone().normalize() : new THREE.Vector3(0, 1, 0);

    for (let i=0;i<count;i++) {
      const ix=i*3;
      start[ix+0] = x + (rand()*0.14 - 0.07);
      start[ix+1] = y + (rand()*0.10 - 0.05);
      start[ix+2] = z + (rand()*0.14 - 0.07);

      // spray mostly outward from surface direction, with a little upward lift
      const v = new THREE.Vector3(rand()*2-1, rand()*2-1, rand()*2-1).normalize();
      v.add(baseDir.clone().multiplyScalar(1.1 + rand()*1.0));
      v.y = Math.abs(v.y) * 0.9 + 0.15;
      v.normalize();

      const sp = (1.2 + rand()*2.2) * (0.75 + strength*0.5);
      vel[ix+0] = v.x * sp;
      vel[ix+1] = v.y * sp;
      vel[ix+2] = v.z * sp;

      seed[i] = rand();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
    geo.setAttribute('aVel',   new THREE.BufferAttribute(vel,   3));
    geo.setAttribute('aSeed',  new THREE.BufferAttribute(seed,  1));
    geo.setAttribute('position', new THREE.BufferAttribute(start.slice(0), 3));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime:  { value: 0 },
        uLife:  { value: 0.42 + strength*0.10 },
        uSize:  { value: 1.05 },   // pixels (small)
        uAlpha: { value: 1.0 },
        uGravity: { value: 6.0 },
      },
      vertexShader: `
        attribute vec3 aStart;
        attribute vec3 aVel;
        attribute float aSeed;

        uniform float uTime;
        uniform float uLife;
        uniform float uSize;
        uniform float uGravity;

        varying float vLife;

        float hash(float n){ return fract(sin(n)*43758.5453123); }

        void main() {
          float t = clamp(uTime, 0.0, uLife);

          vec3 p = aStart + aVel * t;
          p.y -= 0.5 * uGravity * t * t;

          // slight flutter
          float j = (hash(aSeed*31.7)-0.5) * 0.06;
          p.x += j * sin(t*18.0 + aSeed*10.0);
          p.z += j * cos(t*16.0 + aSeed*12.0);

          vLife = 1.0 - (t / uLife);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;

          gl_PointSize = uSize * (300.0 / -mv.z) * (0.75 + 0.6*vLife);
        }
      `,
      fragmentShader: `
        precision mediump float;
        uniform float uAlpha;
        varying float vLife;

        void main() {
          vec2 uv = gl_PointCoord.xy - 0.5;
          float r = dot(uv, uv);
          if (r > 0.25) discard;

          float edge = smoothstep(0.25, 0.06, r);

          // dusty beige-gray with soft edges
          vec3 col = mix(vec3(0.55,0.52,0.48), vec3(0.78,0.74,0.68), 1.0 - edge);

          float a = uAlpha * edge * (0.20 + 0.80*vLife);
          gl_FragColor = vec4(col, a);
        }
      `
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);

    this.bursts.push({ points: pts, t0: this.time });
  }
}