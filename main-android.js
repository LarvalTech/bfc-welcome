import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { ARButton } from "./vendor/three/addons/webxr/ARButton.js";

// -----------------------------------------------
// Scene / XR setup
// -----------------------------------------------
let scene, camera, renderer;
let clock = new THREE.Clock();

const bannerEl = document.getElementById("banner");

// Root that we place ONCE at session start, so everything is always in front.
const experienceRoot = new THREE.Group();

let started = false;
let hasPlacedRoot = false;

// -----------------------------------------------
// Plane + flight
// -----------------------------------------------
let airplane = null;

const MODEL_NOSE_YAW_OFFSET = -Math.PI / 2; // adjust so nose points along flight direction

const START_DISTANCE_METERS = 4.0;       // initial distance in front of user
const BASE_HEIGHT_ABOVE_CAMERA = 1.0;    // 1m above head is great
const FLIGHT_INITIAL_SPEED_MPS = 1.0;    // launch speed
const FLIGHT_ACCEL_MPS2 = 1.15;          // accelerates as it flies away
const FLIGHT_MAX_SPEED_MPS = 4.4;        // cap for comfort/perf
const FLIGHT_SPAN_METERS = 28.0;         // longer run before reset
const CLIMB_RATE_PER_METER = 0.18;       // stronger linear climb
const CLIMB_QUADRATIC_PER_M2 = 0.015;    // extra high fly-off toward the end

let previousPhase = 0;
let currentFlightSpeed = FLIGHT_INITIAL_SPEED_MPS;
let explosionTriggered = false;
let flightCompleted = false;

// -----------------------------------------------
// Ribbon trail (B)
// -----------------------------------------------
const trailPoints = [];
let ribbonMesh = null;

// Rebuild tube geometry at lower rate for performance
let ribbonRebuildAccumulator = 0;
const RIBBON_REBUILD_INTERVAL = 1 / 20; // 20 Hz

// -----------------------------------------------
// Eurovision particles (C)
// -----------------------------------------------
const MAX_PARTICLES = 1600;

const particlePositions = new Float32Array(MAX_PARTICLES * 3);
const particleVelocities = new Float32Array(MAX_PARTICLES * 3);
const particleLife = new Float32Array(MAX_PARTICLES);
let particleCount = 0;

let particleGeometry, particleMaterial, particlePoints;

// -----------------------------------------------
// Falling rabbits
// -----------------------------------------------
const RABBIT_TEXTURE_PATHS = [
  "./assets/orange.png",
  "./assets/red.png",
  "./assets/yellow.png",
];

const rabbits = [];
const rabbitTextures = [];
const rabbitRealTextures = [];
let rabbitSpawnAccumulator = 0;
let rabbitFallbackTexture = null;
let rabbitSpawnLeadApplied = false;
let rabbitSpawnCount = 0;  // tracks total spawned so far
let lastRabbitTextureIdx = -1;  // tracks last used texture to avoid repeats
// Change this to scale all rabbits up/down.
const RABBIT_SIZE_MULTIPLIER = 5.5;
const RABBIT_SPAWN_LEAD_SECONDS = 0.5;
const RABBIT_PARACHUTE_FALL_DRAG = 0.58;
const CHUTE_MAX_SWAY_RADIANS = Math.PI / 4; // 45deg max from upright
let rabbitParachuteTexture = null;
const RABBIT_FALL_STYLES = Object.freeze({
  LEAF: "LEAF",
  SNOW: "SNOW",
  PAPER: "PAPER",
  SPIRAL: "SPIRAL",
  CHUTE: "CHUTE",
});
// Switch rabbit motion behavior here.
const RABBIT_FALL_STYLE = RABBIT_FALL_STYLES.CHUTE;

// -----------------------------------------------
// Temp vectors (avoid GC)
// -----------------------------------------------
const TMP_FORWARD = new THREE.Vector3();
const TMP_POS = new THREE.Vector3();
const TMP_LOOK = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// -----------------------------------------------
// Init
// -----------------------------------------------
init();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  // Lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));

  // Root (we place this once at session start)
  scene.add(experienceRoot);

  // Particles
  setupParticles();
  setupRabbitTextures();

  // AR Button
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: [],
      optionalFeatures: ["local-floor", "dom-overlay"],
      domOverlay: { root: document.body },
    })
  );

  window.addEventListener("resize", onResize);

  // Render loop
  renderer.setAnimationLoop(onXRFrame);
}

function setupParticles() {
  particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setDrawRange(0, 0);

  particleMaterial = new THREE.PointsMaterial({
    size: 0.06,
    color: 0xff2222,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });

  particlePoints = new THREE.Points(particleGeometry, particleMaterial);
  experienceRoot.add(particlePoints);
}

// -----------------------------------------------
// XR Frame
// -----------------------------------------------
function onXRFrame() {
  const dt = Math.min(clock.getDelta(), 0.033);

  // Place root and spawn plane once we are inside an AR session and have a pose
  if (!hasPlacedRoot) {
    const session = renderer.xr.getSession();
    if (session) {
      placeRootInFrontOfViewer();
      spawnPlane();
      started = true;
      hasPlacedRoot = true;
    }
  }

  if (started && airplane) {
    if (!flightCompleted) {
      updateFlight(dt);
      updateRibbon(dt);
    } else if (rabbits.length > 0) {
      updateRabbits(dt, previousPhase, false);
    }
    updateParticles(dt);
  }

  renderer.render(scene, camera);
}

// -----------------------------------------------
// Place experience root in front of viewer (fixes “plane behind me”)
// -----------------------------------------------
function placeRootInFrontOfViewer() {
  // camera in WebXR is driven by the XR pose; at this moment it matches the viewer
  camera.getWorldDirection(TMP_FORWARD); // forward in world
  TMP_FORWARD.y = 0;
  if (TMP_FORWARD.lengthSq() < 1e-6) TMP_FORWARD.set(0, 0, -1);
  TMP_FORWARD.normalize();

  // Put the root START_DISTANCE in front, and slightly up
  experienceRoot.position.copy(camera.position).addScaledVector(TMP_FORWARD, START_DISTANCE_METERS);
  experienceRoot.position.y = camera.position.y + BASE_HEIGHT_ABOVE_CAMERA;

  // Face the same direction as the camera’s horizontal forward
  const yaw = Math.atan2(TMP_FORWARD.x, -TMP_FORWARD.z);
  experienceRoot.quaternion.setFromAxisAngle(Y_AXIS, yaw);

  // Reset effects state (safe if user exits/enters AR again)
  trailPoints.length = 0;
  explosionTriggered = false;
  previousPhase = 0;
  currentFlightSpeed = FLIGHT_INITIAL_SPEED_MPS;
  flightCompleted = false;
  bannerEl?.classList.remove("show");
  clearRabbits();

  // Clear particles
  for (let i = 0; i < particleLife.length; i++) particleLife[i] = 0;
  particleCount = 0;
  particleGeometry.setDrawRange(0, 0);
  particleGeometry.attributes.position.needsUpdate = true;
}

// -----------------------------------------------
// Plane spawn
// -----------------------------------------------
function spawnPlane() {
  // If GLB fails, we still show something
  const fallback = () => {
    const geo = new THREE.ConeGeometry(0.12, 0.45, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    airplane = new THREE.Mesh(geo, mat);
    airplane.rotation.x = Math.PI / 2;
    airplane.position.set(0, 0, 0); // local to experienceRoot
    experienceRoot.add(airplane);
  };

  const loader = new GLTFLoader();
  loader.load(
    "./cesna_airplane.glb",
    (gltf) => {
      airplane = gltf.scene;
      airplane.scale.setScalar(0.5);
      airplane.position.set(0, 0, 0);
      experienceRoot.add(airplane);
    },
    undefined,
    (err) => {
      console.warn("GLB load failed; using fallback.", err);
      fallback();
    }
  );
}

// -----------------------------------------------
// Flight update (forward, not circling)
// -----------------------------------------------
function updateFlight(dt) {
  currentFlightSpeed = Math.min(
    FLIGHT_MAX_SPEED_MPS,
    currentFlightSpeed + FLIGHT_ACCEL_MPS2 * dt
  );
  const phase = previousPhase + currentFlightSpeed * dt;

  // One-shot flight: stop plane at end and let remaining rabbits finish falling.
  if (phase >= FLIGHT_SPAN_METERS) {
    previousPhase = FLIGHT_SPAN_METERS;
    currentFlightSpeed = 0;
    flightCompleted = true;
    airplane.visible = false;
    return;
  }

  previousPhase = phase;

  // Move forward along root’s -Z (we’ll interpret local forward as -Z)
  // Using +Z is fine too, just be consistent.
  // Here we move along local -Z so "forward" is away from user.
  const z = -phase;
  const y =
    phase * CLIMB_RATE_PER_METER +
    phase * phase * CLIMB_QUADRATIC_PER_M2;

  airplane.position.set(0, y, z);

  // Look forward along -Z direction in local space
  TMP_LOOK.set(0, y, z - 1);
  airplane.lookAt(TMP_LOOK);

  // Optional model offset if nose points wrong
  airplane.rotateY(MODEL_NOSE_YAW_OFFSET);

  // Emit trail points in world space (for ribbon)
  TMP_POS.copy(airplane.position);
  airplane.localToWorld(TMP_POS);

  trailPoints.push(TMP_POS.clone());
  if (trailPoints.length > 80) trailPoints.shift();

  // Trigger B+C moment
  if (!explosionTriggered && phase > FLIGHT_SPAN_METERS * 0.65) {
    triggerEurovisionBurst();
    explosionTriggered = true;
  }

  // Ambient particles from engines (subtle)
  emitAmbientParticles(dt);

  // Rabbits dropped from plane, fluttering down and growing near "ground"
  updateRabbits(dt, phase, true);
}

// -----------------------------------------------
// Ribbon (B)
// -----------------------------------------------
function updateRibbon(dt) {
  if (trailPoints.length < 2) return;

  ribbonRebuildAccumulator += dt;
  if (ribbonRebuildAccumulator < RIBBON_REBUILD_INTERVAL) return;
  ribbonRebuildAccumulator = 0;

  if (ribbonMesh) {
    experienceRoot.remove(ribbonMesh);
    ribbonMesh.geometry.dispose();
    // material reused? here we recreate, but you can reuse too.
  }

  const curve = new THREE.CatmullRomCurve3(trailPoints);
  const geometry = new THREE.TubeGeometry(curve, 60, 0.05, 10, false);
  const material = new THREE.MeshBasicMaterial({
    color: 0xcc0000,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });

  ribbonMesh = new THREE.Mesh(geometry, material);
  experienceRoot.add(ribbonMesh);
}

// -----------------------------------------------
// Eurovision particles (C)
// -----------------------------------------------
function emitAmbientParticles(dt) {
  // small rate, looks like sparkly contrail
  const rate = 40; // particles/sec
  const spawnCount = Math.floor(rate * dt);
  if (!spawnCount) return;

  const worldPos = TMP_POS.copy(airplane.position);
  airplane.localToWorld(worldPos);

  for (let i = 0; i < spawnCount; i++) {
    spawnParticle(worldPos, /*burst=*/false);
  }
}

function triggerEurovisionBurst() {
  bannerEl?.classList.add("show");

  const worldPos = TMP_POS.copy(airplane.position);
  airplane.localToWorld(worldPos);

  // Big star burst
  for (let i = 0; i < 700; i++) spawnParticle(worldPos, /*burst=*/true);

  // Optional: add a “ribbon branch feel” using a directional bias (still particles)
  for (let i = 0; i < 220; i++) spawnParticle(worldPos, /*burst=*/true, /*branchy=*/true);
}

function spawnParticle(worldPos, burst, branchy = false) {
  // Find a dead slot
  let idx = -1;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (particleLife[i] <= 0) { idx = i; break; }
  }
  if (idx === -1) return;

  const base = idx * 3;

  particlePositions[base + 0] = worldPos.x;
  particlePositions[base + 1] = worldPos.y;
  particlePositions[base + 2] = worldPos.z;

  // Velocity: burst spreads, ambient trails
  const spread = burst ? 1.8 : 0.35;
  const up = burst ? 1.0 : 0.2;

  let vx = (Math.random() - 0.5) * spread;
  let vy = Math.random() * up;
  let vz = (Math.random() - 0.5) * spread;

  if (branchy) {
    // Push outward more in a fan, Eurovision “light ribbon” vibe
    vx *= 1.6;
    vz *= 1.6;
    vy *= 0.7;
  }

  particleVelocities[base + 0] = vx;
  particleVelocities[base + 1] = vy;
  particleVelocities[base + 2] = vz;

  particleLife[idx] = burst ? 2.8 : 1.4;

  // Expand draw range
  particleCount = Math.max(particleCount, idx + 1);
}

function updateParticles(dt) {
  let aliveMaxIndex = 0;

  for (let i = 0; i < particleCount; i++) {
    const life = particleLife[i];
    if (life <= 0) continue;

    const base = i * 3;

    // Integrate
    particlePositions[base + 0] += particleVelocities[base + 0] * dt;
    particlePositions[base + 1] += particleVelocities[base + 1] * dt;
    particlePositions[base + 2] += particleVelocities[base + 2] * dt;

    // Drag + gentle “festival float”
    particleVelocities[base + 0] *= 0.985;
    particleVelocities[base + 1] *= 0.985;
    particleVelocities[base + 2] *= 0.985;
    particleVelocities[base + 1] += 0.15 * dt; // slight lift

    // Life
    particleLife[i] = life - dt;

    aliveMaxIndex = Math.max(aliveMaxIndex, i + 1);
  }

  // Update GPU
  particleGeometry.setDrawRange(0, aliveMaxIndex);
  particleGeometry.attributes.position.needsUpdate = true;
}

function setupRabbitTextures() {
  const textureLoader = new THREE.TextureLoader();

  rabbitFallbackTexture = createRabbitFallbackTexture();
  rabbitParachuteTexture = createParachuteTexture();
  rabbitTextures.push(rabbitFallbackTexture);

  for (const path of RABBIT_TEXTURE_PATHS) {
    textureLoader.load(
      path,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        rabbitTextures.push(texture);
        rabbitRealTextures.push(texture);
      },
      undefined,
      () => {}
    );
  }
}

function createParachuteTexture() {
  const width = 192;
  const height = 128;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture(canvas);

  ctx.clearRect(0, 0, width, height);

  // Canopy
  ctx.beginPath();
  ctx.moveTo(16, 90);
  ctx.quadraticCurveTo(width / 2, 8, width - 16, 90);
  ctx.lineTo(16, 90);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fill();

  // Panel stripes
  ctx.strokeStyle = "rgba(20, 20, 20, 0.75)";
  ctx.lineWidth = 2;
  for (let i = 1; i <= 4; i++) {
    const x = 16 + (i * (width - 32)) / 5;
    ctx.beginPath();
    ctx.moveTo(x, 88);
    ctx.quadraticCurveTo(width / 2, 20, x, 88);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createRabbitFallbackTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture(canvas);

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.ellipse(50, 42, 13, 26, 0, 0, Math.PI * 2);
  ctx.ellipse(78, 42, 13, 26, 0, 0, Math.PI * 2);
  ctx.ellipse(64, 74, 30, 30, 0, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function pickRabbitTexture() {
  const pool = rabbitRealTextures.length > 0 ? rabbitRealTextures : rabbitTextures;
  if (!pool.length) return rabbitFallbackTexture;

  // Always start with Bunny 1 (index 0)
  if (rabbitSpawnCount === 0) {
    lastRabbitTextureIdx = 0;
    return pool[0];
  }

  // Avoid picking the same character twice in a row
  // Use a round-robin with shuffle to ensure good variety
  const len = pool.length;
  let idx;
  if (len === 1) {
    idx = 0;
  } else {
    // Pick randomly but exclude the last used index
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * len);
      attempts++;
    } while (idx === lastRabbitTextureIdx && attempts < 10);
  }
  lastRabbitTextureIdx = idx;
  return pool[idx];
}

function getTextureAspect(texture) {
  const image = texture?.image;
  const width = image?.naturalWidth || image?.videoWidth || image?.width || 1;
  const height = image?.naturalHeight || image?.videoHeight || image?.height || 1;
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return 1;
  return width / height;
}

function spawnRabbit(planeAltitude) {
  const texture = pickRabbitTexture();
  const aspect = getTextureAspect(texture);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);
  let parachuteSprite = null;

  const groundY = -BASE_HEIGHT_ABOVE_CAMERA - 3.5 - Math.random() * 1.0;
  const spawnY = airplane.position.y - 0.05 - Math.random() * 0.12;
  const startScaleBase = THREE.MathUtils.clamp(0.18 / (1 + planeAltitude * 0.45), 0.045, 0.14);
  const endScaleBase = THREE.MathUtils.clamp(startScaleBase * (2.9 + Math.random() * 1.2), 0.2, 0.6);
  const startScale = startScaleBase * RABBIT_SIZE_MULTIPLIER;
  const endScale = endScaleBase * RABBIT_SIZE_MULTIPLIER;

  sprite.position.set(
    airplane.position.x + (Math.random() - 0.5) * 0.35,
    spawnY,
    airplane.position.z + (Math.random() - 0.5) * 0.35
  );
  sprite.scale.set(startScale * aspect, startScale, 1);
  experienceRoot.add(sprite);

  if (RABBIT_FALL_STYLE === RABBIT_FALL_STYLES.CHUTE && rabbitParachuteTexture) {
    const parachuteMaterial = new THREE.SpriteMaterial({
      map: rabbitParachuteTexture,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    parachuteSprite = new THREE.Sprite(parachuteMaterial);
    parachuteSprite.position.set(sprite.position.x, sprite.position.y + startScale * 1.7, sprite.position.z);
    parachuteSprite.scale.set(startScale * 2.2, startScale * 1.45, 1);
    experienceRoot.add(parachuteSprite);
  }

  rabbitSpawnCount++;

  rabbits.push({
    sprite,
    parachuteSprite,
    aspect,
    spawnY,
    groundY,
    startScale,
    endScale,
    fallSpeed: 0.10 + Math.random() * 0.08,
    driftAmpX: 0.22 + Math.random() * 0.22,
    driftAmpZ: 0.08 + Math.random() * 0.18,
    driftFreq: 1.6 + Math.random() * 1.8,
    rotationSpeed: (Math.random() - 0.5) * 2.4,
    phase: Math.random() * Math.PI * 2,
    age: 0,
  });
}

function getRabbitFallStep(rabbit, dt, phase) {
  if (RABBIT_FALL_STYLE === RABBIT_FALL_STYLES.SNOW) {
    const wave = 0.75 + 0.2 * Math.sin(rabbit.phase + rabbit.age * 2.1);
    return {
      dy: rabbit.fallSpeed * 0.72 * wave * dt,
      dx: Math.sin(rabbit.phase * 0.4 + rabbit.age * 1.2) * rabbit.driftAmpX * 1.25 * dt,
      dz: Math.cos(rabbit.phase + rabbit.age * 1.05) * rabbit.driftAmpZ * 1.45 * dt,
      rot: rabbit.rotationSpeed * rabbit.age * 0.35 + Math.sin(rabbit.age * 1.8) * 0.2,
    };
  }

  if (RABBIT_FALL_STYLE === RABBIT_FALL_STYLES.PAPER) {
    const flap = 0.55 + 0.55 * Math.abs(Math.sin(rabbit.phase + rabbit.age * 3.8));
    return {
      dy: rabbit.fallSpeed * 0.65 * flap * dt,
      dx: Math.sin(rabbit.phase + rabbit.age * rabbit.driftFreq * 2.0) * rabbit.driftAmpX * 1.7 * dt,
      dz: Math.cos(rabbit.phase * 0.65 + rabbit.age * rabbit.driftFreq * 1.6) * rabbit.driftAmpZ * 1.9 * dt,
      rot: rabbit.rotationSpeed * rabbit.age * 1.3 + Math.sin(rabbit.age * 8.2 + rabbit.phase) * 0.35,
    };
  }

  if (RABBIT_FALL_STYLE === RABBIT_FALL_STYLES.SPIRAL) {
    const angle = rabbit.phase + rabbit.age * (rabbit.driftFreq * 1.35);
    return {
      dy: rabbit.fallSpeed * 0.94 * dt,
      dx: Math.cos(angle) * rabbit.driftAmpX * 1.45 * dt,
      dz: Math.sin(angle) * rabbit.driftAmpZ * 2.05 * dt,
      rot: rabbit.rotationSpeed * rabbit.age * 0.85 + angle * 0.3,
    };
  }

  if (RABBIT_FALL_STYLE === RABBIT_FALL_STYLES.CHUTE) {
    const sway = Math.sin(rabbit.phase + rabbit.age * 1.35);
    const boundedSway = sway * CHUTE_MAX_SWAY_RADIANS;
    return {
      dy: rabbit.fallSpeed * RABBIT_PARACHUTE_FALL_DRAG * dt,
      dx: sway * rabbit.driftAmpX * 0.9 * dt,
      dz: Math.cos(rabbit.phase * 0.6 + rabbit.age * 1.1) * rabbit.driftAmpZ * 1.1 * dt,
      rot: boundedSway,
    };
  }

  // LEAF default
  const flutter = 0.82 + 0.28 * Math.sin(rabbit.phase + rabbit.age * 6.0);
  return {
    dy: rabbit.fallSpeed * flutter * dt,
    dx: Math.sin(rabbit.phase + rabbit.age * rabbit.driftFreq) * rabbit.driftAmpX * dt,
    dz: Math.cos(rabbit.phase * 0.7 + rabbit.age * (rabbit.driftFreq * 0.78)) * rabbit.driftAmpZ * dt,
    rot: rabbit.rotationSpeed * rabbit.age + phase * 0.03,
  };
}

function updateRabbits(dt, phase, allowSpawn = true) {
  if (rabbitRealTextures.length === 0) return;

  const altitude = Math.max(0.2, airplane.position.y);
  const spawnRate = THREE.MathUtils.clamp(0.8 + altitude * 0.4, 0.8, 3.5);

  if (allowSpawn && !rabbitSpawnLeadApplied) {
    rabbitSpawnAccumulator += spawnRate * RABBIT_SPAWN_LEAD_SECONDS;
    rabbitSpawnLeadApplied = true;
  }

  if (allowSpawn) rabbitSpawnAccumulator += dt * spawnRate;

  while (allowSpawn && rabbitSpawnAccumulator >= 1) {
    rabbitSpawnAccumulator -= 1;
    spawnRabbit(altitude);
  }

  for (let i = rabbits.length - 1; i >= 0; i--) {
    const rabbit = rabbits[i];
    rabbit.age += dt;

    const fallStep = getRabbitFallStep(rabbit, dt, phase);
    rabbit.sprite.position.y -= fallStep.dy;
    rabbit.sprite.position.x += fallStep.dx;
    rabbit.sprite.position.z += fallStep.dz;

    const totalDrop = Math.max(0.001, rabbit.spawnY - rabbit.groundY);
    const dropped = rabbit.spawnY - rabbit.sprite.position.y;
    const progress = THREE.MathUtils.clamp(dropped / totalDrop, 0, 1);
    const currentScale = THREE.MathUtils.lerp(rabbit.startScale, rabbit.endScale, progress);
    rabbit.sprite.scale.set(currentScale * rabbit.aspect, currentScale, 1);
    rabbit.sprite.material.rotation = fallStep.rot;

    if (rabbit.parachuteSprite) {
      rabbit.parachuteSprite.position.set(
        rabbit.sprite.position.x,
        rabbit.sprite.position.y + currentScale * 1.7,
        rabbit.sprite.position.z
      );
      rabbit.parachuteSprite.scale.set(currentScale * 2.2, currentScale * 1.45, 1);
      rabbit.parachuteSprite.material.rotation = rabbit.sprite.material.rotation * 0.4;
    }

    if (rabbit.sprite.position.y <= rabbit.groundY) {
      experienceRoot.remove(rabbit.sprite);
      rabbit.sprite.material.dispose();
      if (rabbit.parachuteSprite) {
        experienceRoot.remove(rabbit.parachuteSprite);
        rabbit.parachuteSprite.material.dispose();
      }
      rabbits.splice(i, 1);
    }
  }
}

function clearRabbits() {
  rabbitSpawnAccumulator = 0;
  rabbitSpawnLeadApplied = false;
  for (const rabbit of rabbits) {
    experienceRoot.remove(rabbit.sprite);
    rabbit.sprite.material.dispose();
    if (rabbit.parachuteSprite) {
      experienceRoot.remove(rabbit.parachuteSprite);
      rabbit.parachuteSprite.material.dispose();
    }
  }
  rabbits.length = 0;
}

// -----------------------------------------------
// Resize
// -----------------------------------------------
function onResize() {
  // In WebXR, the camera is controlled by XR, but resizing renderer is still needed.
  renderer.setSize(window.innerWidth, window.innerHeight);
}
