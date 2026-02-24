function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HospitalGenerator {
  generateMultiFloor({ floors=3, w=70, h=70, seed=1 }) {
    const rng = mulberry32(seed|0);
    const out = { floors: [], activeFloor: 0, seed };
    for (let f=0; f<floors; f++) out.floors.push(this._genFloor({ w, h, rng, floorIndex: f }));
    return out;
  }
  _genFloor({ w, h, rng, floorIndex }) {
    const grid = new Uint8Array(w*h);
    const idx = (x,y)=> y*w + x;

    const carveRect = (x0,y0,x1,y1) => {
      for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) grid[idx(x,y)] = 1;
    };

    const carveCorridor = (x0,y0,x1,y1, width=2) => {
      let x=x0, y=y0;
      const step = (xx,yy)=>{
        for (let oy=-width;oy<=width;oy++){
          for (let ox=-width;ox<=width;ox++){
            const nx=xx+ox, ny=yy+oy;
            if (nx>1 && ny>1 && nx<w-2 && ny<h-2) grid[idx(nx,ny)] = 1;
          }
        }
      };
      step(x,y);
      while (x !== x1) { x += Math.sign(x1-x); step(x,y); }
      while (y !== y1) { y += Math.sign(y1-y); step(x,y); }
    };

    const randRange = (a,b)=> a + ((rng()*(b-a+1))|0);

    const lobbyW = 18 + ((rng()*8)|0);
    const lobbyH = 16 + ((rng()*8)|0);
    const cx = (w/2)|0, cy = (h/2)|0;
    const lx0 = cx - (lobbyW/2|0), ly0 = cy - (lobbyH/2|0);
    const lx1 = lx0 + lobbyW, ly1 = ly0 + lobbyH;
    carveRect(lx0, ly0, lx1, ly1);

    const lobbyCx = lx0 + lobbyW*0.5;
    const lobbyCy = ly0 + lobbyH*0.5;

    const rooms = [];
    const doors = [];
        const roomCount = 18 + ((rng()*8)|0);

    for (let i=0;i<roomCount;i++) {
      const rw = randRange(6, 11);
      const rh = randRange(6, 11);

      const angle = rng()*Math.PI*2;
      const dist = 16 + rng()*22;
      const rx0 = Math.max(3, Math.min(w-rw-4, (cx + Math.cos(angle)*dist)|0));
      const ry0 = Math.max(3, Math.min(h-rh-4, (cy + Math.sin(angle)*dist)|0));
            const rx1 = rx0 + rw;
      const ry1 = ry0 + rh;

      // avoid overlaps so rooms don't merge into a giant open area
      let overlaps = false;
      for (const rr of rooms) {
        const pad = 3;
        if (!(rx1 < rr.x0-pad || rx0 > rr.x1+pad || ry1 < rr.y0-pad || ry0 > rr.y1+pad)) { overlaps = true; break; }
      }
      if (overlaps) continue;

      carveRect(rx0, ry0, rx1, ry1);
      rooms.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1 });

      const roomCx = (rx0+rx1)*0.5;
      const roomCy = (ry0+ry1)*0.5;
      const dx = lobbyCx - roomCx;
      const dy = lobbyCy - roomCy;

      let doorX, doorY;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) { doorX = rx1; doorY = randRange(ry0+1, ry1-1); }
        else        { doorX = rx0; doorY = randRange(ry0+1, ry1-1); }
      } else {
        if (dy > 0) { doorY = ry1; doorX = randRange(rx0+1, rx1-1); }
        else        { doorY = ry0; doorX = randRange(rx0+1, rx1-1); }
      }

      grid[idx(doorX, doorY)] = 1;

      let cx0 = doorX, cy0 = doorY;
      if (doorX === rx0) cx0 = doorX - 1;
      else if (doorX === rx1) cx0 = doorX + 1;
      if (doorY === ry0) cy0 = doorY - 1;
      else if (doorY === ry1) cy0 = doorY + 1;

      if (cx0>2 && cy0>2 && cx0<w-3 && cy0<h-3) {
        carveCorridor(cx0, cy0, (lobbyCx|0), (lobbyCy|0), 1);
        doors.push({ x: doorX+0.5, z: doorY+0.5 });
      }
    }

    for (let i=0;i<6;i++){
      const rw = randRange(4,5), rh = randRange(4,5);
      const rx0 = randRange(4, w-rw-6);
      const ry0 = randRange(4, h-rh-6);
      const rx1 = rx0+rw, ry1 = ry0+rh;
      carveRect(rx0, ry0, rx1, ry1);
      const doorX = rx0;
      const doorY = randRange(ry0+1, ry1-1);
      grid[idx(doorX,doorY)] = 1;
      if (doorX-1>2) carveCorridor(doorX-1, doorY, (lobbyCx|0), (lobbyCy|0), 1);
      doors.push({ x: doorX+0.5, z: doorY+0.5 });
      rooms.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, kind:'bath' });
    }

    const spawn = { x: lobbyCx + 0.5, z: lobbyCy + 0.5 };return {
      w, h, grid,
      lobby: { x0: lx0, y0: ly0, x1: lx1, y1: ly1 },
      rooms,
      doors,
      spawn,floorIndex,
    };
  }
}
