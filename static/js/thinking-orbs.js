// thinking-orbs.js — Ported from Jakub Antalik's thinking-orbs
// Pure 2D canvas, no WebGL, no filters. Monochrome dot-based thinking orbs.
// MIT License. https://github.com/Jakubantalik/thinking-orbs

(function() {
  'use strict';

  // ─── Core primitives ──────────────────────────────────

  function hashD(a, b) {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }

  function fibDir(i, n) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
  }

  function angleDelta(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
  }

  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hashD(xi, yi), b = hashD(xi + 1, yi);
    const c = hashD(xi, yi + 1), d = hashD(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  function frac(x) { return x - Math.floor(x); }
  function lerp(a, b, f) { return a + (b - a) * f; }

  function makeProj(yaw, tilt, cx, cy, scale) {
    const st = Math.sin(tilt), ct = Math.cos(tilt);
    const sy = Math.sin(yaw), cyw = Math.cos(yaw);
    return function(x, y, z) {
      const x1 = x * cyw + z * sy;
      const z1 = -x * sy + z * cyw;
      const y1 = y * ct - z1 * st;
      const z2 = y * st + z1 * ct;
      return [cx + x1 * scale, cy - y1 * scale, z2];
    };
  }

  function radiusScale(size, pow) {
    return Math.pow(size / 300, pow);
  }

  function paint(ctx, dots, dark, rMin) {
    rMin = rMin || 0.3;
    dots.sort(function(a, b) { return a.z - b.z; });
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var alpha = d.a != null ? d.a : 1;
      if (alpha < 0.02) continue;
      var w = Math.min(1, Math.max(0, d.white));
      var g = Math.round((dark ? 1 - w : w) * 255);
      ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + alpha + ')';
      ctx.beginPath();
      ctx.arc(d.x, d.y, Math.max(rMin, d.r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function paintLines(ctx, lines, dark) {
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var alpha = l.a != null ? l.a : 1;
      if (alpha < 0.02) continue;
      var w = Math.min(1, Math.max(0, l.white));
      var g = Math.round((dark ? 1 - w : w) * 255);
      ctx.strokeStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + alpha + ')';
      ctx.lineWidth = l.w;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
  }

  // ─── Draw modes ────────────────────────────────────────

  function drawOrbits(ctx, size, t, dark, o) {
    o = o || {};
    var cx = size/2, cy = size/2, R = (size/2)*0.82;
    var pt = makeProj(t*0.12, 0.3, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow || 0.6);
    var dots = [];
    var orbitN = o.orbitN || 12, ghostN = o.ghostN || 40, particles = o.particles || 3;
    for (var orb = 0; orb < orbitN; orb++) {
      var h1 = hashD(orb,1.7), h2 = hashD(orb,5.2), h3 = hashD(orb,8.9);
      var ro = R*(0.45+0.52*h1), th = h1*2*Math.PI, phi = Math.acos(2*h2-1);
      var nx = Math.sin(phi)*Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi)*Math.sin(th);
      var ux = -ny, uy = nx, ul = Math.max(1e-6, Math.sqrt(ux*ux+uy*uy));
      ux /= ul; uy /= ul;
      var vx = ny*0-nz*uy, vy = nz*ux-nx*0, vz = nx*uy-ny*ux;
      var speed = (0.25+0.55*h3)*(h3>0.5?1:-1);
      for (var k = 0; k < ghostN; k++) {
        var a = (k/ghostN)*2*Math.PI;
        var p = pt((ux*Math.cos(a)+vx*Math.sin(a))*ro,(uy*Math.cos(a)+vy*Math.sin(a))*ro,(0*Math.cos(a)+vz*Math.sin(a))*ro);
        var depth = (p[2]/ro+1)/2;
        dots.push({x:p[0],y:p[1],z:p[2],r:(o.ghostR||0.9)*rs,white:0.72,a:(o.ghostA||0.5)*(0.4+0.6*depth)});
      }
      for (var m = 0; m < particles; m++) {
        a = t*speed+(m/particles)*2*Math.PI+h2*6;
        p = pt((ux*Math.cos(a)+vx*Math.sin(a))*ro,(uy*Math.cos(a)+vy*Math.sin(a))*ro,(0*Math.cos(a)+vz*Math.sin(a))*ro);
        depth = (p[2]/ro+1)/2;
        dots.push({x:p[0],y:p[1],z:p[2],r:((o.partR||1.2)+(o.partRDepth||1.6)*depth)*rs,white:0.3-0.22*depth});
      }
    }
    paint(ctx, dots, dark, o.rMin);
  }

  function drawGlobe(ctx, size, t, dark, o) {
    o = o || {};
    var cx = size/2, cy = size/2, radius = (size/2)*0.82;
    var tilt = 0.4+0.06*Math.sin(t*0.35);
    var pt = makeProj(t*0.5, tilt, cx, cy, radius);
    var scan = t*(0.5+(1.7-0.5)*(o.scanMul||1));
    var rs = radiusScale(size, o.rsPow||0.6);
    var dimBase = o.dimBase||1;
    var dots = [];
    var latRings = o.latRings||17, lonDensity = o.lonDensity||44;
    for (var li = 0; li <= latRings; li++) {
      var lat = -Math.PI/2+(li/latRings)*Math.PI;
      var cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      var lonCount = Math.max(1, Math.round(Math.abs(cosLat)*lonDensity));
      for (var lj = 0; lj < lonCount; lj++) {
        var lon = (lj/lonCount)*2*Math.PI;
        var p = pt(cosLat*Math.cos(lon), sinLat, cosLat*Math.sin(lon));
        var depth = (p[2]+1)/2;
        var d = angleDelta(lon+t*0.5, scan);
        var boost = Math.exp(-(d*d)/0.18)*Math.max(0, p[2]);
        dots.push({x:p[0],y:p[1],z:p[2],r:((o.rBase||0.6)+(o.rDepth||1.7)*depth+(o.rBoost||1)*boost)*rs,white:(o.inkFar||0.62)-(o.inkSpan||0.54)*depth,a:dimBase+(1-dimBase)*Math.min(1,boost)});
      }
    }
    paint(ctx, dots, dark, o.rMin);
  }

  function drawWave(ctx, size, t, dark, o) {
    o = o || {};
    var cx = size/2, cy = size/2, R = (size/2)*0.874;
    var pt = makeProj(t*0.18, 0.38, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow||0.6);
    var dots = [];
    var rings = o.rings||15, lonDensity = o.lonDensity||40;
    for (var ri = 0; ri <= rings; ri++) {
      var lat = -Math.PI/2+(ri/rings)*Math.PI;
      var cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      var w = 0.62*Math.sin(t*2.1-ri*0.52)+0.38*Math.sin(t*1.27+ri*0.83);
      var rr = R*(0.88+0.105*w);
      var lonCount = Math.max(1, Math.round(Math.abs(cosLat)*lonDensity));
      for (var lj = 0; lj < lonCount; lj++) {
        var lon = (lj/lonCount)*2*Math.PI;
        var p = pt(cosLat*Math.cos(lon)*rr, sinLat*rr, cosLat*Math.sin(lon)*rr);
        var depth = (p[2]/R+1)/2;
        var crest = Math.max(0, w);
        dots.push({x:p[0],y:p[1],z:p[2],r:((o.rBase||0.6)+(o.rDepth||1.7)*depth)*(1+0.4*crest)*rs,white:0.66-0.56*depth-0.1*crest});
      }
    }
    paint(ctx, dots, dark, o.rMin);
  }

  function drawWeb(ctx, size, t, dark, o) {
    o = o || {};
    var cx = size/2, cy = size/2, R = (size/2)*0.8*(o.spread||1);
    var pt = makeProj(t*0.12, 0.32, cx, cy, R);
    var rs = radiusScale(size, o.rsPow||0.6);
    var nodeN = o.nodeN||30, thr = o.thr||0.72;
    var nodes = [], dots = [], lines = [];
    for (var i = 0; i < nodeN; i++) {
      var d = fibDir(i, nodeN);
      var x = d[0]+0.3*(vnoise(i*0.31+9,t*0.24)-0.5)*2;
      var y = d[1]+0.3*(vnoise(i*0.53+27,t*0.21)-0.5)*2;
      var z = d[2]+0.3*(vnoise(i*0.77+55,t*0.27)-0.5)*2;
      var l = Math.sqrt(x*x+y*y+z*z);
      nodes.push([x/l,y/l,z/l]);
    }
    for (i = 0; i < nodeN; i++) {
      for (var j = i+1; j < nodeN; j++) {
        var dx = nodes[i][0]-nodes[j][0], dy = nodes[i][1]-nodes[j][1], dz = nodes[i][2]-nodes[j][2];
        var dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if (dist >= thr) continue;
        var p1 = pt(nodes[i][0],nodes[i][1],nodes[i][2]);
        var p2 = pt(nodes[j][0],nodes[j][1],nodes[j][2]);
        var depth = ((p1[2]+p2[2])/2+1)/2;
        lines.push({x1:p1[0],y1:p1[1],x2:p2[0],y2:p2[1],white:0.42,a:(1-dist/thr)*(0.3+0.55*depth),w:Math.max(0.6,(o.lineW||0.8)*rs)});
      }
    }
    for (i = 0; i < nodeN; i++) {
      var p = pt(nodes[i][0],nodes[i][1],nodes[i][2]);
      var depth = (p[2]+1)/2;
      var pulse = 1+0.25*Math.sin(t*1.4+i*2.7);
      dots.push({x:p[0],y:p[1],z:p[2],r:((o.nodeR||1.4)+(o.nodeRDepth||1.8)*depth)*pulse*rs,white:0.55-0.45*depth});
    }
    var signals = o.signals||5;
    for (var s = 0; s < signals; s++) {
      var seg = Math.floor(t*0.55+s*7.31);
      var ai = Math.floor(hashD(seg,s*3.1+1.7)*nodeN);
      var bi = Math.floor(hashD(seg,s*5.7+4.2)*nodeN);
      if (ai === bi) continue;
      var f = frac(t*0.55+s*7.31);
      var px = lerp(nodes[ai][0],nodes[bi][0],f);
      var py = lerp(nodes[ai][1],nodes[bi][1],f);
      var pz = lerp(nodes[ai][2],nodes[bi][2],f);
      var ll = Math.max(1e-6, Math.sqrt(px*px+py*py+pz*pz));
      var pp = pt(px/ll,py/ll,pz/ll);
      var d2 = (pp[2]+1)/2;
      dots.push({x:pp[0],y:pp[1],z:pp[2],r:((o.nodeR||1.4)*1.5+(o.nodeRDepth||1.8)*d2)*rs,white:0.05,a:0.5+0.5*d2});
    }
    paintLines(ctx, lines, dark);
    paint(ctx, dots, dark, o.rMin);
  }

  function drawBraid(ctx, size, t, dark, o) {
    o = o || {};
    var cx = size/2, cy = size/2, R = (size/2)*0.76;
    var pt = makeProj(t*0.4, 0.3, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow||0.6);
    var dots = [];
    var ghostN = o.ghostN||150;
    for (var i = 0; i < ghostN; i++) {
      var d = fibDir(i, ghostN);
      var p = pt(d[0]*R,d[1]*R,d[2]*R);
      var depth = (p[2]/R+1)/2;
      dots.push({x:p[0],y:p[1],z:p[2],r:0.8*rs,white:0.78,a:0.1+0.22*depth});
    }
    var strandN = o.strandN||52, turns = o.turns||3;
    for (var s = 0; s < 3; s++) {
      var phase = (s/3)*2*Math.PI;
      for (i = 0; i < strandN; i++) {
        var u = (frac(i/strandN+t*0.045)*2-1)*0.96;
        var surf = Math.sqrt(Math.max(0,1-u*u));
        var endFade = Math.min(1,(1-Math.abs(u))/0.1);
        var a = u*Math.PI*turns+phase;
        var weave = 1+0.075*Math.sin(u*Math.PI*turns*2+phase*2+t*0.8);
        var rr = surf*R*weave;
        p = pt(Math.cos(a)*rr, u*R*weave, Math.sin(a)*rr);
        depth = (p[2]/R+1)/2;
        dots.push({x:p[0],y:p[1],z:p[2],r:((o.rBase||1.2)+(o.rDepth||1.8)*depth)*rs,white:0.55-0.45*depth,a:endFade*(0.45+0.55*depth)});
      }
    }
    paint(ctx, dots, dark, o.rMin);
  }

  function drawRibbon(ctx, size, t, dark, o) {
    o = o || {};
    var cx = size/2, cy = size/2, R = (size/2)*0.78;
    var spin = o.spin != null ? o.spin : 1;
    var camTilt = 0.3;
    var pt = makeProj(t*0.1*spin, camTilt, cx, cy, 1);
    var rs = radiusScale(size, o.rsPow||0.6);
    var dots = [];
    var ghostN = o.ghostN != null ? o.ghostN : 150;
    for (var i = 0; i < ghostN; i++) {
      var d = fibDir(i, ghostN);
      var p = pt(d[0]*R,d[1]*R,d[2]*R);
      var depth = (p[2]/R+1)/2;
      dots.push({x:p[0],y:p[1],z:p[2],r:0.8*rs,white:0.78,a:0.1+0.22*depth});
    }
    var ya = t*0.24*spin;
    var ta = o.faceOn ? -camTilt : 0.55+0.3*Math.sin(t*0.18)*spin;
    var ux = Math.cos(ya), uz = Math.sin(ya);
    var vx = -uz*Math.sin(ta), vy = Math.cos(ta), vz = ux*Math.sin(ta);
    var wobAmp = 0.23*(o.wobMul||1);
    var baseR = o.faceOn ? R/(1+0.85*wobAmp) : R;
    var lanes = o.lanes||5, segs = o.segs||88;
    for (var li = 0; li < lanes; li++) {
      var laneR = baseR*(0.6+0.4*(li/Math.max(1,lanes-1)));
      for (var si = 0; si <= segs; si++) {
        var f = si/segs;
        var wob = wobAmp*Math.sin(f*2*Math.PI*(o.bandMul||3.9)+t*1.8);
        var rr2 = laneR*(1+wob);
        var x = (ux*Math.cos(f*2*Math.PI)+vx*Math.sin(f*2*Math.PI))*rr2;
        var y = vy*Math.sin(f*2*Math.PI)*rr2;
        var z = (uz*Math.cos(f*2*Math.PI)+vz*Math.sin(f*2*Math.PI))*rr2;
        var p2 = pt(x, y, z);
        var depth2 = (p2[2]/R+1)/2;
        dots.push({x:p2[0],y:p2[1],z:p2[2],r:((o.rBase||1.1)+(o.rDepth||1.7)*depth2)*rs,white:0.55-0.45*depth2});
      }
    }
    paint(ctx, dots, dark, o.rMin);
  }

  // ─── Presets ───────────────────────────────────────────

  var BASE = {
    globe: {latRings:17,lonDensity:44,rBase:0.6,rDepth:1.7,rBoost:1,inkFar:0.62,inkSpan:0.54,rsPow:0.6,rMin:0.3},
    orbits: {orbitN:12,ghostN:40,ghostR:0.9,ghostA:0.5,particles:3,partR:1.2,partRDepth:1.6,rsPow:0.6,rMin:0.3},
    rubik: {latRings:15,lonDensity:40,moveCount:14,rBase:0.6,rDepth:1.7,rActive:0.3,inkFar:0.62,inkSpan:0.54,rsPow:0.6,rMin:0.3},
    wave: {rings:15,lonDensity:40,rBase:0.6,rDepth:1.7,rsPow:0.6,rMin:0.3},
    web: {nodeN:30,thr:0.72,signals:5,nodeR:1.4,nodeRDepth:1.8,lineW:0.8,rsPow:0.6,rMin:0.3},
    braid: {strandN:52,turns:3,ghostN:150,rBase:1.2,rDepth:1.8,rsPow:0.6,rMin:0.3},
    ribbon: {lanes:5,segs:88,ghostN:150,rBase:1.1,rDepth:1.7,rsPow:0.6,rMin:0.3},
    ring: {lanes:5,segs:88,ghostN:0,faceOn:1,rBase:1.1,rDepth:1.7,rsPow:0.6,rMin:0.3},
    morph: {rDot:0.021,iconD:1,rMin:0.25}
  };

  var PRESETS = {
    orbits: {64:{speed:1.885,count:1,size:1},20:{speed:3.9,count:0.238,size:2.4}},
    globe: {64:{speed:2.015,count:0.42,size:1.15,extra:{scanMul:4.08,dimBase:0.45}},20:{speed:2.665,count:0.105,size:1.75,extra:{scanMul:4.335,dimBase:0.45}}},
    rubik: {64:{speed:1.82,count:0.35,size:1.05},20:{speed:1.95,count:0.088,size:1.9}},
    wave: {64:{speed:4.388,count:0.341,size:1},20:{speed:3.998,count:0.105,size:1.6}},
    web: {64:{speed:3.315,count:1.35,size:0.95},20:{speed:6.63,count:0.25,size:1.52}},
    braid: {64:{speed:1.625,count:0.5,size:1},20:{speed:2.75,count:0.1125,size:1.36}},
    ribbon: {64:{speed:2.34,count:0.25,size:0.85,extra:{spin:0,bandMul:3.9,wobMul:1}},20:{speed:3.12,count:0.051,size:1.073,extra:{spin:0,bandMul:4.94,wobMul:1}}},
    ring: {64:{speed:3.24,count:0.25,size:0.956,extra:{spin:0,bandMul:3.627,wobMul:0.368}},20:{speed:3.78,count:0.028,size:1.622,extra:{spin:0,bandMul:3.968,wobMul:0.565}}},
    morph: {64:{speed:2.405,count:0.702,size:0.395,extra:{spread:1.45}},20:{speed:2.08,count:0.53,size:1.011,extra:{spread:1.45}}}
  };

  var STATE_TO_MODE = {
    working:'orbits',searching:'globe',solving:'rubik',listening:'wave',
    connecting:'web',weaving:'braid',composing:'ribbon',breathing:'ring',shaping:'morph'
  };

  function scaleCounts(opts, scale) {
    var out = Object.assign({}, opts);
    var rt = Math.sqrt(scale);
    if (out.latRings && out.lonDensity) { out.latRings = Math.max(2, Math.round(out.latRings*rt)); out.lonDensity = Math.max(2, Math.round(out.lonDensity*rt)); }
    if (out.rings && out.lonDensity) { out.rings = Math.max(2, Math.round(out.rings*rt)); }
    if (out.lanes && out.segs) { out.lanes = Math.max(2, Math.round(out.lanes*rt)); out.segs = Math.max(2, Math.round(out.segs*rt)); }
    if (out.orbitN && out.orbitN > 0) out.orbitN = Math.max(1, Math.round(out.orbitN*scale));
    if (out.ghostN && out.ghostN > 0) out.ghostN = Math.max(1, Math.round(out.ghostN*scale));
    if (out.nodeN) out.nodeN = Math.max(1, Math.round(out.nodeN*scale));
    if (out.strandN) out.strandN = Math.max(1, Math.round(out.strandN*scale));
    if (out.signals) out.signals = Math.max(1, Math.round(out.signals*scale));
    if (out.iconD) out.iconD = Math.max(0.02, out.iconD*scale);
    return out;
  }

  function scaleRadii(opts, scale) {
    var out = Object.assign({}, opts);
    var keys = ['rBase','rDepth','rActive','rDot','ghostR','partR','partRDepth','nodeR','nodeRDepth'];
    for (var i = 0; i < keys.length; i++) { if (out[keys[i]] != null) out[keys[i]] *= scale; }
    return out;
  }

  function resolvePreset(state, size) {
    var mode = STATE_TO_MODE[state];
    var preset = PRESETS[mode][size];
    var opts = Object.assign({}, BASE[mode]);
    if (preset.count !== 1) opts = scaleCounts(opts, preset.count);
    if (preset.size !== 1) opts = scaleRadii(opts, preset.size);
    if (preset.extra) opts = Object.assign(opts, preset.extra);
    return { mode: mode, speed: preset.speed, opts: opts };
  }

  var MODE_DRAWS = {
    orbits: drawOrbits, globe: drawGlobe, rubik: drawWave, wave: drawWave,
    web: drawWeb, braid: drawBraid, ribbon: drawRibbon, ring: drawRibbon, morph: drawWave
  };

  // ─── ThinkingOrb class ─────────────────────────────────

  window.ThinkingOrb = function(canvas, state, opts) {
    opts = opts || {};
    var size = opts.size || 64;
    var theme = opts.theme || 'auto';
    var speedMul = opts.speed || 1;
    var dark = theme === 'dark';

    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    var resolved = resolvePreset(state, size >= 40 ? 64 : 20);
    var start = performance.now();
    var running = true;
    var dpr = window.devicePixelRatio || 1;

    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    // Auto-detect dark mode
    if (theme === 'auto') {
      dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function frame() {
      if (!running) return;
      requestAnimationFrame(frame);
      var t = ((performance.now() - start) / 1000) * resolved.speed * speedMul;
      ctx.clearRect(0, 0, size, size);
      MODE_DRAWS[resolved.mode](ctx, size, t, dark, resolved.opts);
    }

    frame();

    return {
      stop: function() { running = false; },
      start: function() { if (!running) { running = true; frame(); } },
      setState: function(newState) {
        resolved = resolvePreset(newState, size >= 40 ? 64 : 20);
      }
    };
  };
})();