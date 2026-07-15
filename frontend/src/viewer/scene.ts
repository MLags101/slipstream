/**
 * Shared three.js viewer setup: renderer + camera + OrbitControls + lights,
 * with a swappable content group and camera framing. Used by both the
 * new-run STL preview and the result viewer.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface Viewer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Replace the current content group (previous group is disposed). */
  setContent(group: THREE.Object3D | null): void;
  /** Frame the camera around a bounding sphere. */
  frame(center: THREE.Vector3, radius: number): void;
  dispose(): void;
}

export const VIEWER_BG = 0x0b0c0e;

export function createViewer(container: HTMLElement): Viewer {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(VIEWER_BG);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
  camera.up.set(0, 0, 1); // contract: +Z is up
  camera.position.set(-2, -3, 1.5);

  // preserveDrawingBuffer lets us read the canvas back for image export.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Lighting tuned for a dark engineering viewport.
  scene.add(new THREE.HemisphereLight(0x8899bb, 0x14161a, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-3, -4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x99aacc, 0.5);
  fill.position.set(4, 3, -2);
  scene.add(fill);

  let content: THREE.Object3D | null = null;

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  const disposeObject = (obj: THREE.Object3D) => {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
  };

  return {
    scene,
    camera,
    renderer,
    controls,
    setContent(group) {
      if (content) {
        scene.remove(content);
        disposeObject(content);
      }
      content = group;
      if (group) scene.add(group);
    },
    frame(center, radius) {
      const r = Math.max(radius, 1e-6);
      const dir = new THREE.Vector3(-1.3, -1.8, 1.0).normalize();
      camera.position.copy(center).addScaledVector(dir, r * 2.6);
      camera.near = r / 100;
      camera.far = r * 200;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (content) {
        scene.remove(content);
        disposeObject(content);
      }
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Grid + axes + a wind-direction arrow along +X, sized to the model. */
export function buildSceneHelpers(radius: number, center: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const r = Math.max(radius, 1e-6);

  const grid = new THREE.GridHelper(r * 6, 20, 0x2e3238, 0x1d2024);
  grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; we want XY (Z-up)
  grid.position.set(center.x, center.y, center.z - r * 1.05);
  g.add(grid);

  const axes = new THREE.AxesHelper(r * 0.9);
  axes.position.copy(grid.position);
  g.add(axes);

  // Wind hint: arrows flowing along +X toward the model.
  const arrowColor = 0x3987e5;
  const origin = new THREE.Vector3(center.x - r * 2.4, center.y, center.z);
  const main = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    origin,
    r * 1.1,
    arrowColor,
    r * 0.22,
    r * 0.1,
  );
  g.add(main);
  for (const dy of [-0.5, 0.5]) {
    const a = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(origin.x, center.y + dy * r, center.z),
      r * 0.7,
      arrowColor,
      r * 0.16,
      r * 0.07,
    );
    (a.line.material as THREE.LineBasicMaterial).transparent = true;
    (a.line.material as THREE.LineBasicMaterial).opacity = 0.5;
    (a.cone.material as THREE.MeshBasicMaterial).transparent = true;
    (a.cone.material as THREE.MeshBasicMaterial).opacity = 0.5;
    g.add(a);
  }
  return g;
}
