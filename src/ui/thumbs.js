import * as THREE from 'three';
import { makeVariantModel } from '../game/bikeMesh.js';

// One shared offscreen renderer turns variant models into <img> thumbnails.
// A dozen live WebGL contexts would trip browser context limits; snapshots
// cost one render each and cache forever (models are deterministic).

let renderer = null, scene = null, cam = null, mount = null;
const cache = new Map();

function ensure() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(220, 150);
  // if the browser evicts our context (live-context cap, GPU reset), drop
  // the renderer so the next snapshot rebuilds on a fresh one instead of
  // rendering blanks forever
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (renderer) renderer.dispose();
    renderer = null;
  });
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdde4ee, 0x2e2b26, 1.25));
  const key = new THREE.DirectionalLight(0xfff0da, 1.5);
  key.position.set(2.5, 3.5, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8ab0ff, 0.6);
  rim.position.set(-2.5, 1.5, -2.5);
  scene.add(rim);
  cam = new THREE.PerspectiveCamera(32, 220 / 150, 0.1, 20);
  cam.position.set(0, 0.55, 2.2);
  cam.lookAt(0, 0.05, 0);
  mount = new THREE.Group();
  scene.add(mount);
}

// the snapshot lives on as a data URL; the model's GPU buffers need not
function disposeModel(model) {
  model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

// dataURL for (kind, lvl); angle lets arrows nudge the pose so browsing
// feels alive even though thumbnails are stills
export function variantThumb(kind, lvl, angle = 0.6) {
  const k = `${kind}:${lvl}:${angle.toFixed(2)}`;
  if (cache.has(k)) return cache.get(k);
  ensure();
  while (mount.children.length) mount.remove(mount.children[0]);
  const model = makeVariantModel(kind, lvl);
  model.rotation.y = angle;
  mount.add(model);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL();
  mount.remove(model);
  disposeModel(model);
  // a dead context renders nothing and toDataURL yields a blank — show it
  // this paint, but don't cache it; the next call retries on a fresh renderer
  if (renderer.getContext().isContextLost()) {
    renderer.dispose();
    renderer = null;
    return url;
  }
  cache.set(k, url);
  return url;
}
