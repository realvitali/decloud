// ===== Module: legos3d =====
function toggleLegosAddSpread() {
  if (legosAddSpreadOpen) { closeLegosAddSpread(); return; }
  legosAddSpreadOpen = true;

  var btn = document.getElementById('legos-add-fab');
  if (!btn) return;
  var rect = btn.getBoundingClientRect();
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;

  var overlay = document.getElementById('legos-spread-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'legos-spread-overlay';
    overlay.className = 'ai-spread-overlay';
    document.body.appendChild(overlay);
  }
  overlay.onclick = closeLegosAddSpread;

  var itemSize = 68;
  var margin = 14;
  var n = LEGOS_BRICK_OPTIONS.length;
  var r = 120;
  // Fan upward (away from bottom of screen)
  var fanAngle = -Math.PI / 2;
  var arcDeg = Math.min(160, 35 + (n - 1) * 22);
  var halfArc = (arcDeg / 2) * Math.PI / 180;

  // Clamp radius to available space
  var maxR = Math.min(
    (cy - margin - itemSize) / Math.sin(fanAngle + halfArc > -Math.PI/2 ? fanAngle + halfArc : fanAngle),
    (cx - margin) / Math.cos(fanAngle - halfArc),
    (window.innerWidth - cx - margin) / Math.cos(fanAngle + halfArc)
  );
  r = Math.max(80, Math.min(r, Math.abs(maxR) - itemSize));

  overlay.innerHTML = LEGOS_BRICK_OPTIONS.map(function(opt, i) {
    var frac = n === 1 ? 0.5 : i / (n - 1);
    var angle = fanAngle - halfArc + frac * (halfArc * 2);
    var dx = Math.cos(angle) * r;
    var dy = Math.sin(angle) * r;
    var hex = '#' + opt.color.toString(16).padStart(6, '0');
    return '<div class="ai-spread-item" style="left:' + (cx - itemSize/2) + 'px;top:' + (cy - itemSize/2) + 'px;--tx:' + dx + 'px;--ty:' + dy + 'px;--delay:' + (i * 0.05) + 's" onclick="addBrickFromSpread(' + opt.rows + ',' + opt.cols + ',' + opt.color + ')">' +
      '<div class="ai-spread-item-visual" style="color:' + hex + '">' +
      '<div style="width:24px;height:14px;background:' + hex + ';border-radius:3px;box-shadow:0 1px 0 rgba(0,0,0,0.15)"></div>' +
      '</div>' +
      '<div class="ai-spread-item-label">' + opt.label + '</div>' +
    '</div>';
  }).join('');

  requestAnimationFrame(function() {
    overlay.classList.add('active');
    overlay.querySelectorAll('.ai-spread-item').forEach(function(el) { el.classList.add('show'); });
  });
  btn.classList.add('ai-spread-active');
}

function closeLegosAddSpread() {
  legosAddSpreadOpen = false;
  var overlay = document.getElementById('legos-spread-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.querySelectorAll('.ai-spread-item').forEach(function(el) { el.classList.remove('show'); });
    setTimeout(function() { if (overlay) overlay.innerHTML = ''; }, 400);
  }
  var btn = document.getElementById('legos-add-fab');
  if (btn) btn.classList.remove('ai-spread-active');
}

function addBrickFromSpread(rows, cols, color) {
  closeLegosAddSpread();
  addBrick(rows, cols, color);
  // Haptic
  if (navigator.vibrate) navigator.vibrate(15);
}

// ─── 3D Legos Engine ───────────────────────────────────

function initLegos3D() {
  if (legos3D) { legos3D.animate(); return; }
  var canvas = document.getElementById('legos-canvas');
  if (!canvas || !window.THREE) return;
  if (!window.CANNON) { setTimeout(initLegos3D, 200); return; }

  // Scene — white, bright, minimal
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f5);
  scene.fog = new THREE.Fog(0xf0f0f5, 16, 36);

  var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setClearColor(0xf0f0f5, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Lights — soft daylight
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  var keyLight = new THREE.DirectionalLight(0xffffff, 0.5);
  keyLight.position.set(6, 14, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left = -8; keyLight.shadow.camera.right = 8;
  keyLight.shadow.camera.top = 8; keyLight.shadow.camera.bottom = -8;
  keyLight.shadow.bias = -0.0005;
  scene.add(keyLight);
  var fillLight = new THREE.DirectionalLight(0xccddff, 0.25);
  fillLight.position.set(-5, 4, -3);
  scene.add(fillLight);

  // Physics
  var world = new CANNON.World({ gravity: new CANNON.Vec3(0, -18, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;

  // Collision groups
  var GROUP_FLOOR = 1, GROUP_BRICK = 2;
  var brickMask = GROUP_FLOOR | GROUP_BRICK;

  // Baseplate
  var baseplateSize = 12;
  var studSize = 0.4;
  var brickH = studSize * 0.72;

  var floorMat = new THREE.MeshStandardMaterial({
    color: 0xeaeaf2, roughness: 0.5, metalness: 0.05,
    transparent: true, opacity: 0.85
  });
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(baseplateSize, baseplateSize), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Baseplate studs — subtle dots
  var studMat = new THREE.MeshStandardMaterial({ color: 0xd8d8e4, roughness: 0.4, metalness: 0.1 });
  var studGeo = new THREE.CylinderGeometry(studSize * 0.26, studSize * 0.26, studSize * 0.07, 12);
  var gridN = Math.floor(baseplateSize / studSize);
  var studGroup = new THREE.Group();
  for (var gx = 0; gx < gridN; gx++) {
    for (var gz = 0; gz < gridN; gz++) {
      var stud = new THREE.Mesh(studGeo, studMat);
      stud.position.set(-baseplateSize/2 + studSize/2 + gx * studSize, 0.012, -baseplateSize/2 + studSize/2 + gz * studSize);
      stud.receiveShadow = true;
      studGroup.add(stud);
    }
  }
  scene.add(studGroup);

  // Floor physics
  var floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  floorBody.collisionFilterGroup = GROUP_FLOOR;
  world.addBody(floorBody);

  // Invisible walls
  [
    [baseplateSize/2, 0, 0, 0, 1, 0, -Math.PI/2],
    [-baseplateSize/2, 0, 0, 0, 1, 0, Math.PI/2],
    [0, 0, baseplateSize/2, 0, 1, 0, Math.PI],
    [0, 0, -baseplateSize/2, 0, 1, 0, 0],
  ].forEach(function(w) {
    var body = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    body.position.set(w[0], w[1], w[2]);
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(w[3], w[4], w[5]), w[6]);
    body.collisionFilterGroup = GROUP_FLOOR;
    world.addBody(body);
  });

  // Bricks
  var bricks = [];
  var colorIdx = 0;
  var palette = [0xef4444, 0x3b82f6, 0xf59e0b, 0x22c55e, 0xa855f7, 0xec4899, 0x06b6d4, 0xf97316];

  function updateCounter() {
    var el = document.getElementById('legos-counter');
    if (el) el.textContent = bricks.length + (bricks.length === 1 ? ' brick' : ' bricks');
  }

  function createBrick(rows, cols, color) {
    if (!color) color = palette[colorIdx++ % palette.length];
    var w = cols * studSize;
    var d = rows * studSize;

    var group = new THREE.Group();
    var mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.2, metalness: 0.15 });
    var box = new THREE.Mesh(new THREE.BoxGeometry(w, brickH, d), mat);
    box.castShadow = true; box.receiveShadow = true;
    group.add(box);

    // Studs on top
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var stud = new THREE.Mesh(
          new THREE.CylinderGeometry(studSize * 0.28, studSize * 0.28, studSize * 0.2, 12), mat
        );
        stud.position.set(-w/2 + studSize/2 + c * studSize, brickH/2 + studSize * 0.1, -d/2 + studSize/2 + r * studSize);
        stud.castShadow = true;
        group.add(stud);
      }
    }

    var body = new CANNON.Body({ mass: rows * cols * 0.12, shape: new CANNON.Box(new CANNON.Vec3(w/2, brickH/2, d/2)) });
    body.position.set((Math.random() - 0.5) * 3, 5 + Math.random() * 2, (Math.random() - 0.5) * 3);
    body.linearDamping = 0.4;
    body.angularDamping = 0.6;
    body.collisionFilterGroup = GROUP_BRICK;
    body.collisionFilterMask = brickMask;

    scene.add(group);
    world.addBody(body);
    bricks.push({ mesh: group, body: body, w: w, d: d, color: color, grabbed: false });
    updateCounter();
    return bricks[bricks.length - 1];
  }

  // ─── Raycasting ──────────────────────────────────────
  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();
  var dragPlane = new THREE.Plane();
  var grabbedBrick = null;
  var dragOffset = new THREE.Vector3();
  var isCamDrag = false;
  var touchStartX = 0, touchStartY = 0;
  var pointerMoved = false;

  // Camera
  var camAngleH = Math.PI / 4;
  var camAngleV = Math.PI / 4;
  var camDist = 13;
  var camTarget = new THREE.Vector3(0, 0.5, 0);
  var camTargetDist = 13;
  var camTargetAngleH = camAngleH;
  var camTargetAngleV = camAngleV;

  function updateCamera() {
    // Smooth lerp toward target
    camAngleH += (camTargetAngleH - camAngleH) * 0.15;
    camAngleV += (camTargetAngleV - camAngleV) * 0.15;
    camDist += (camTargetDist - camDist) * 0.15;
    camera.position.x = camTarget.x + Math.sin(camAngleH) * Math.cos(camAngleV) * camDist;
    camera.position.y = camTarget.y + Math.sin(camAngleV) * camDist;
    camera.position.z = camTarget.z + Math.cos(camAngleH) * Math.cos(camAngleV) * camDist;
    camera.lookAt(camTarget);
  }

  function getPointer(e) {
    var rect = canvas.getBoundingClientRect();
    var x, y;
    if (e.touches && e.touches.length > 0) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
    else { x = e.clientX; y = e.clientY; }
    pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
    return { x: x, y: y };
  }

  // ─── Delete mode ────────────────────────────────────
  var deleteMode = false;

  function setDeleteMode(on) {
    deleteMode = on;
    canvas.style.cursor = on ? 'crosshair' : 'grab';
    var fab = document.getElementById('legos-delete-fab');
    if (fab) fab.classList.toggle('active', on);
  }

  // ─── Stack height computation ────────────────────────
  function getStackHeight(x, z, brickW, brickD, excludeBrick) {
    var topY = 0;
    for (var i = 0; i < bricks.length; i++) {
      var b = bricks[i];
      if (b === excludeBrick) continue;
      // Check XZ overlap
      var dx = Math.abs(b.body.position.x - x);
      var dz = Math.abs(b.body.position.z - z);
      var overlapX = dx < (b.w + brickW) / 2 - 0.05;
      var overlapZ = dz < (b.d + brickD) / 2 - 0.05;
      if (overlapX && overlapZ) {
        var brickTop = b.body.position.y + brickH / 2;
        if (brickTop > topY) topY = brickTop;
      }
    }
    return topY + brickH / 2; // resting Y for new brick
  }

  // ─── Pointer handlers ────────────────────────────────
  function onPointerDown(e) {
    var pos = getPointer(e);
    touchStartX = pos.x; touchStartY = pos.y;
    pointerMoved = false;

    if (e.touches && e.touches.length === 2) { isCamDrag = true; return; }

    raycaster.setFromCamera(pointer, camera);
    var meshes = [];
    bricks.forEach(function(b) { b.mesh.traverse(function(c) { if (c.isMesh) meshes.push(c); }); });
    var hits = raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      var hitObj = hits[0].object;
      var brick = null;
      for (var i = 0; i < bricks.length; i++) {
        var found = false;
        bricks[i].mesh.traverse(function(c) { if (c === hitObj) found = true; });
        if (found) { brick = bricks[i]; break; }
      }

      if (brick) {
        if (deleteMode) {
          scene.remove(brick.mesh);
          world.removeBody(brick.body);
          bricks.splice(bricks.indexOf(brick), 1);
          updateCounter();
          if (navigator.vibrate) navigator.vibrate(20);
          return;
        }
        // Grab
        grabbedBrick = brick;
        brick.grabbed = true;
        brick.body.type = CANNON.Body.KINEMATIC;
        brick.body.velocity.set(0, 0, 0);
        brick.body.angularVelocity.set(0, 0, 0);
        // Snap upright
        brick.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), 0);
        brick.mesh.quaternion.copy(brick.body.quaternion);
        // Disable collisions with other bricks while grabbed (only collide with floor)
        brick.body.collisionFilterMask = GROUP_FLOOR;

        var camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        camDir.negate();
        dragPlane.setFromNormalAndCoplanarPoint(camDir, brick.mesh.position);
        var intersect = new THREE.Vector3();
        raycaster.ray.intersectPlane(dragPlane, intersect);
        dragOffset.copy(intersect).sub(brick.mesh.position);
        e.preventDefault();
        return;
      }
    }
    isCamDrag = true;
  }

  function onPointerMove(e) {
    var pos = getPointer(e);
    if (Math.abs(pos.x - touchStartX) > 3 || Math.abs(pos.y - touchStartY) > 3) pointerMoved = true;

    if (isCamDrag) {
      if (e.touches && e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (legos3D._lastPinch > 0) {
          camTargetDist = Math.max(6, Math.min(22, camTargetDist + (legos3D._lastPinch - dist) * 0.025));
        }
        legos3D._lastPinch = dist;
      } else {
        camTargetAngleH -= (pos.x - touchStartX) * 0.006;
        camTargetAngleV = Math.max(0.12, Math.min(Math.PI/2 - 0.08, camTargetAngleV + (pos.y - touchStartY) * 0.006));
        touchStartX = pos.x; touchStartY = pos.y;
      }
      return;
    }

    if (grabbedBrick) {
      getPointer(e);
      raycaster.setFromCamera(pointer, camera);
      var intersect = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane, intersect)) {
        var target = intersect.sub(dragOffset);
        var snap = studSize;
        // Snap X/Z to grid
        target.x = Math.round(target.x / snap) * snap;
        target.z = Math.round(target.z / snap) * snap;
        var lim = baseplateSize/2 - studSize/2;
        target.x = Math.max(-lim, Math.min(lim, target.x));
        target.z = Math.max(-lim, Math.min(lim, target.z));
        // Auto-stack: compute how high this brick should sit at this X/Z
        target.y = getStackHeight(target.x, target.z, grabbedBrick.w, grabbedBrick.d, grabbedBrick);
        grabbedBrick.body.position.x = target.x;
        grabbedBrick.body.position.y = target.y;
        grabbedBrick.body.position.z = target.z;
      }
      e.preventDefault();
    }
  }

  function onPointerUp() {
    if (grabbedBrick) {
      grabbedBrick.grabbed = false;
      grabbedBrick.body.type = CANNON.Body.DYNAMIC;
      grabbedBrick.body.collisionFilterMask = brickMask;
      grabbedBrick.body.wakeUp();
      // Gentle settle
      grabbedBrick.body.velocity.set(0, -0.5, 0);
      if (navigator.vibrate) navigator.vibrate(10);
      grabbedBrick = null;
    }
    isCamDrag = false;
    legos3D._lastPinch = 0;
  }

  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  canvas.addEventListener('touchmove', function(e) {
    if (isCamDrag && e.touches.length === 2) { onPointerMove(e); e.preventDefault(); }
    else if (grabbedBrick) { onPointerMove(e); e.preventDefault(); }
  }, { passive: false });
  canvas.addEventListener('touchend', onPointerUp);
  canvas.addEventListener('wheel', function(e) {
    camTargetDist = Math.max(6, Math.min(22, camTargetDist + e.deltaY * 0.008));
    e.preventDefault();
  }, { passive: false });

  // ─── Animate ─────────────────────────────────────────
  var clock = new THREE.Clock();
  var running = true;
  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    var dt = Math.min(clock.getDelta(), 0.05);
    world.step(1/60, dt, 3);
    for (var i = 0; i < bricks.length; i++) {
      bricks[i].mesh.position.copy(bricks[i].body.position);
      bricks[i].mesh.quaternion.copy(bricks[i].body.quaternion);
    }
    updateCamera();
    renderer.render(scene, camera);
  }

  function resize() {
    var w = canvas.clientWidth;
    var h = canvas.clientHeight || 400;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // Seed
  setTimeout(function() {
    createBrick(2, 4, 0x3b82f6);
    createBrick(1, 2, 0xef4444);
    createBrick(2, 2, 0xf59e0b);
  }, 100);

  legos3D = {
    scene: scene, camera: camera, renderer: renderer, world: world, bricks: bricks,
    createBrick: createBrick,
    setDeleteMode: setDeleteMode,
    animate: function() { running = true; animate(); },
    stop: function() { running = false; },
    clear: function() {
      bricks.forEach(function(b) { scene.remove(b.mesh); world.removeBody(b.body); });
      bricks.length = 0;
      updateCounter();
    },
    removeLast: function() {
      if (bricks.length > 0) {
        var b = bricks.pop();
        scene.remove(b.mesh);
        world.removeBody(b.body);
        updateCounter();
      }
    },
    _lastPinch: 0,
    _deleteMode: false,
  };

  updateCamera();
  animate();
}

function addBrick(rows, cols, color) {
  if (!legos3D) { initLegos3D(); }
  if (!legos3D) return;
  legos3D.createBrick(rows, cols, color);
}

function clearLegos() {
  if (legos3D) legos3D.clear();
}

function removeLastBrick() {
  if (legos3D) legos3D.removeLast();
}

function toggleDeleteMode() {
  if (!legos3D) return;
  legos3D._deleteMode = !legos3D._deleteMode;
  legos3D.setDeleteMode(legos3D._deleteMode);
  if (navigator.vibrate) navigator.vibrate(15);
}

// ─── Settings App ───────────────────────────────────────

