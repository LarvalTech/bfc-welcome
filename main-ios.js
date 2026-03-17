import * as THREE from "three";
import { GLTFLoader } from "../phoenix/vendor/three/addons/loaders/GLTFLoader.js";

let scene, camera, renderer;
let airplane;
let clock = new THREE.Clock();
let cameraFeed;
let welcomeBanner;
let cameraStream = null;
let started = false;

let trailPoints = [];
let ribbon;
let explosionTriggered = false;

let particles = [];
let particleMesh;
let previousFlightPhase = 0;
const MODEL_NOSE_YAW_OFFSET = Math.PI / 2;
let orientationTrackingActive = false;
let hasDeviceOrientation = false;
let deviceAlpha = 0;
let deviceBeta = 0;
let deviceGamma = 0;
let worldFlightHeight = 0;
const flightOrigin = new THREE.Vector3();
const flightDirection = new THREE.Vector3(0, 0, 1);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DEVICE_EULER = new THREE.Euler();
const SCREEN_TRANSFORM = new THREE.Quaternion();
const DEVICE_TRANSFORM = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const RAW_DEVICE_QUAT = new THREE.Quaternion();
const HEADING_CORRECTION_QUAT = new THREE.Quaternion();
const TEMP_FLIGHT_POS = new THREE.Vector3();
const TEMP_LOOK_TARGET = new THREE.Vector3();
const TEMP_FORWARD = new THREE.Vector3();
const START_DISTANCE_METERS = 4;
const FLIGHT_SPEED = 1.2;
const FLIGHT_SPAN = 20;
const CLIMB_RATE_PER_METER = 0.28;
const ORIENTATION_WAIT_TIMEOUT_MS = 1200;
const BASE_HEIGHT_ABOVE_CAMERA = 2.6;
let hasHeadingCorrection = false;

init();

function init() {
  cameraFeed = document.getElementById("cameraFeed");
  welcomeBanner = document.getElementById("welcomeBanner");
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 1.6, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  scene.add(light);

  window.addEventListener("resize", onResize);

  document.getElementById("startBtn").addEventListener("click", () => {
    startExperience().catch((err) => {
      const startBtn = document.getElementById("startBtn");
      startBtn.disabled = false;
      startBtn.textContent = "Allow Camera & Retry";
      console.error("Start failed:", err);
    });
  });
}

async function startExperience() {
  if (started) return;

  const startBtn = document.getElementById("startBtn");
  startBtn.disabled = true;

  await startCamera();
  try {
    await startOrientationTracking();
    await waitForInitialOrientationSample();
  } catch (err) {
    console.warn("Device orientation unavailable:", err);
  }
  calibrateHeadingToCurrentView();
  updateCameraFromDeviceOrientation();
  initializeWorldFlightPath();
  started = true;
  startBtn.style.display = "none";
  spawnPlane();
  animate();
}

async function startCamera() {
  if (cameraStream) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API unavailable. Use HTTPS or localhost.");
  }

  const attempts = [
    { video: { facingMode: { ideal: "environment" } }, audio: false },
    { video: { facingMode: "user" }, audio: false },
    { video: true, audio: false },
  ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!cameraStream) throw lastError || new Error("Unable to open camera.");

  cameraFeed.srcObject = cameraStream;
  await cameraFeed.play();
}

async function startOrientationTracking() {
  if (orientationTrackingActive) return;
  if (!window.isSecureContext) return;
  if (typeof DeviceOrientationEvent === "undefined") return;

  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const permission = await DeviceOrientationEvent.requestPermission();
    if (permission !== "granted") {
      throw new Error("Motion permission denied. Please allow motion access.");
    }
  }

  window.addEventListener("deviceorientation", onDeviceOrientation, true);
  orientationTrackingActive = true;
}

function waitForInitialOrientationSample() {
  if (hasDeviceOrientation) return Promise.resolve();

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(resolve, ORIENTATION_WAIT_TIMEOUT_MS);

    function handleFirstSample(event) {
      if (event.alpha == null || event.beta == null || event.gamma == null) return;
      window.removeEventListener("deviceorientation", handleFirstSample, true);
      window.clearTimeout(timeoutId);
      resolve();
    }

    window.addEventListener("deviceorientation", handleFirstSample, true);
  });
}

function onDeviceOrientation(event) {
  if (event.alpha == null || event.beta == null || event.gamma == null) return;
  hasDeviceOrientation = true;
  deviceAlpha = THREE.MathUtils.degToRad(event.alpha);
  deviceBeta = THREE.MathUtils.degToRad(event.beta);
  deviceGamma = THREE.MathUtils.degToRad(event.gamma);
}

function updateCameraFromDeviceOrientation() {
  if (!hasDeviceOrientation) return;

  getRawDeviceQuaternion(RAW_DEVICE_QUAT);
  camera.quaternion.copy(RAW_DEVICE_QUAT);
  if (hasHeadingCorrection) {
    camera.quaternion.premultiply(HEADING_CORRECTION_QUAT);
  }
}

function getRawDeviceQuaternion(targetQuaternion) {
  const orientationAngle =
    window.screen?.orientation?.angle ??
    window.orientation ??
    0;
  const screenOrientation = THREE.MathUtils.degToRad(orientationAngle);

  DEVICE_EULER.set(deviceBeta, deviceAlpha, -deviceGamma, "YXZ");
  targetQuaternion.setFromEuler(DEVICE_EULER);
  targetQuaternion.multiply(DEVICE_TRANSFORM);
  targetQuaternion.multiply(
    SCREEN_TRANSFORM.setFromAxisAngle(Z_AXIS, -screenOrientation)
  );
  return targetQuaternion;
}

function calibrateHeadingToCurrentView() {
  if (!hasDeviceOrientation) return;

  getRawDeviceQuaternion(RAW_DEVICE_QUAT);
  TEMP_FORWARD.set(0, 0, -1).applyQuaternion(RAW_DEVICE_QUAT);
  TEMP_FORWARD.y = 0;
  if (TEMP_FORWARD.lengthSq() < 1e-5) {
    return;
  }
  TEMP_FORWARD.normalize();

  const yaw = Math.atan2(TEMP_FORWARD.x, -TEMP_FORWARD.z);
  HEADING_CORRECTION_QUAT.setFromAxisAngle(Y_AXIS, -yaw);
  hasHeadingCorrection = true;
}

function initializeWorldFlightPath() {
  worldFlightHeight = camera.position.y + BASE_HEIGHT_ABOVE_CAMERA;

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-5) {
    forward.set(0, 0, -1);
  }
  forward.normalize();

  flightOrigin.copy(camera.position).addScaledVector(forward, START_DISTANCE_METERS);
  flightOrigin.y = worldFlightHeight;
  flightDirection.copy(forward);
}

function spawnPlane() {
  const loader = new GLTFLoader();

  loader.load(
    "./cesna_airplane.glb",   // <-- relative path
    (gltf) => {
      airplane = gltf.scene;
      airplane.scale.set(0.5, 0.5, 0.5);
      airplane.position.copy(flightOrigin);
      scene.add(airplane);
    },
    undefined,
    (err) => {
      console.error("GLB load error:", err);
    }
  );
}
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  updateCameraFromDeviceOrientation();

  if (airplane) {
    movePlane(t);
    updateRibbon();
    updateParticles();
  }

  renderer.render(scene, camera);
}

function movePlane(t) {
  const phase = (t * FLIGHT_SPEED) % FLIGHT_SPAN;
  const position = TEMP_FLIGHT_POS
    .copy(flightOrigin)
    .addScaledVector(flightDirection, phase);
  position.y = worldFlightHeight + phase * CLIMB_RATE_PER_METER;

  if (phase < previousFlightPhase) {
    trailPoints.length = 0;
  }
  previousFlightPhase = phase;

  airplane.position.copy(position);
  TEMP_LOOK_TARGET.copy(position).add(flightDirection);
  airplane.lookAt(TEMP_LOOK_TARGET);
  airplane.rotateY(MODEL_NOSE_YAW_OFFSET);

  trailPoints.push(airplane.position.clone());
  if (trailPoints.length > 60) trailPoints.shift();

  if (!explosionTriggered && phase > FLIGHT_SPAN * 0.65) {
    revealText();
    explosionTriggered = true;
  }
}

function updateRibbon() {
  if (trailPoints.length < 2) return;

  if (ribbon) scene.remove(ribbon);

  const curve = new THREE.CatmullRomCurve3(trailPoints);
  const geometry = new THREE.TubeGeometry(curve, 40, 0.05, 8, false);

  const material = new THREE.MeshBasicMaterial({
    color: 0xff2fa3,
    transparent: true,
    opacity: 0.8,
  });

  ribbon = new THREE.Mesh(geometry, material);
  scene.add(ribbon);
}

function triggerExplosion() {
  for (let i = 0; i < 500; i++) {
    const p = new THREE.Vector3(
      airplane.position.x,
      airplane.position.y,
      airplane.position.z
    );

    const velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      Math.random() * 2,
      (Math.random() - 0.5) * 2
    );

    particles.push({ position: p, velocity, life: 3 });
  }

  revealText();
}

function updateParticles() {
  const positions = [];

  particles.forEach((p) => {
    p.position.addScaledVector(p.velocity, 0.016);
    p.life -= 0.016;

    positions.push(p.position.x, p.position.y, p.position.z);
  });

  particles = particles.filter((p) => p.life > 0);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );

  const material = new THREE.PointsMaterial({
    color: 0xffff00,
    size: 0.08,
  });

  if (particleMesh) scene.remove(particleMesh);

  particleMesh = new THREE.Points(geometry, material);
  scene.add(particleMesh);
}

function revealText() {
  welcomeBanner?.classList.add("show");
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
