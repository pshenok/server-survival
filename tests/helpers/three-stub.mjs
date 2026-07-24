// Minimal THREE stub for headless sim tests (#155 PR 10).
//
// The game loads THREE r128 as a classic CDN global, so tests install this
// object as globalThis.THREE before importing any game module. Rendering
// classes are inert stand-ins, but everything gameplay logic depends on has
// REAL math: Vector3 (distanceTo drives placement collision, lerpVectors
// drives request flight), Object3D child bookkeeping (game reset loops on
// group.children.length), and Color hex round-trips (health tint logic).

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  lengthSq() {
    return this.dot(this);
  }
  distanceTo(v) {
    const dx = this.x - v.x,
      dy = this.y - v.y,
      dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }
}

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
}

export class Color {
  constructor(hex = 0) {
    this._hex = typeof hex === "number" ? hex : 0;
  }
  setHex(hex) {
    this._hex = hex;
    return this;
  }
  getHex() {
    return this._hex;
  }
  setRGB(r, g, b) {
    this._hex =
      (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
    return this;
  }
}

class Material {
  constructor(params = {}) {
    Object.assign(this, params);
    this.color = new Color(typeof params.color === "number" ? params.color : 0);
    if (!("opacity" in params)) this.opacity = 1;
    if (!("transparent" in params)) this.transparent = false;
  }
  dispose() {}
}
export class MeshStandardMaterial extends Material {}
export class MeshBasicMaterial extends Material {}
export class MeshLambertMaterial extends Material {}
export class LineBasicMaterial extends Material {}

class Geometry {
  dispose() {}
}
export class BoxGeometry extends Geometry {}
export class ConeGeometry extends Geometry {}
export class CylinderGeometry extends Geometry {}
export class SphereGeometry extends Geometry {}
export class RingGeometry extends Geometry {}
export class TorusGeometry extends Geometry {}
export class OctahedronGeometry extends Geometry {}
export class DodecahedronGeometry extends Geometry {}
export class TetrahedronGeometry extends Geometry {}
export class BufferGeometry extends Geometry {
  setFromPoints(points) {
    this.points = points;
    return this;
  }
}

export class Object3D {
  constructor() {
    this.children = [];
    this.parent = null;
    this.position = new Vector3();
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1 };
    this.userData = {};
    this.visible = true;
  }
  add(child) {
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    return this;
  }
  remove(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) {
      this.children.splice(i, 1);
      child.parent = null;
    }
    return this;
  }
  lookAt() {}
  // Real THREE.Object3D is JSON-serializable via toJSON() — saveGameState
  // stringifies STATE.internetNode.mesh, so without this the stub's
  // parent/children links would make JSON.stringify throw on a cycle.
  toJSON() {
    return {};
  }
}

export class Group extends Object3D {}

export class Scene extends Object3D {
  constructor() {
    super();
    this.background = null;
    this.fog = null;
  }
}

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.castShadow = false;
    this.receiveShadow = false;
  }
}

export class Line extends Mesh {}

export class OrthographicCamera extends Object3D {
  constructor(left, right, top, bottom, near, far) {
    super();
    this.left = left;
    this.right = right;
    this.top = top;
    this.bottom = bottom;
    this.near = near;
    this.far = far;
    this.zoom = 1;
  }
  updateProjectionMatrix() {}
}

class Light extends Object3D {
  constructor(color, intensity) {
    super();
    this.color = new Color(color);
    this.intensity = intensity;
    this.castShadow = false;
    this.shadow = { mapSize: { width: 0, height: 0 } };
  }
}
export class AmbientLight extends Light {}
export class DirectionalLight extends Light {}

export class GridHelper extends Object3D {}

export class WebGLRenderer {
  constructor() {
    this.domElement = globalThis.document.createElement("canvas");
    this.shadowMap = { enabled: false };
  }
  setSize() {}
  setPixelRatio() {}
  render() {}
}

export class Plane {
  constructor(normal = new Vector3(0, 1, 0), constant = 0) {
    this.normal = normal;
    this.constant = constant;
  }
}

export class Raycaster {
  constructor() {
    this.ray = {
      // Tests never raycast for real; the ground-plane intersection just
      // needs to produce a point so callers don't crash.
      intersectPlane(plane, target) {
        target.set(0, 0, 0);
        return target;
      },
    };
  }
  setFromCamera() {}
  intersectObjects() {
    return [];
  }
}

// Real point-to-segment math: getConnectionAtPoint uses this for line picking.
export class Line3 {
  constructor(start = new Vector3(), end = new Vector3()) {
    this.start = start;
    this.end = end;
  }
  closestPointToPoint(point, clampToLine, target) {
    const dir = this.end.clone().sub(this.start);
    const lenSq = dir.lengthSq();
    let t = lenSq === 0 ? 0 : point.clone().sub(this.start).dot(dir) / lenSq;
    if (clampToLine) t = Math.max(0, Math.min(1, t));
    return target.copy(this.start).add(dir.multiplyScalar(t));
  }
}

export class FogExp2 {
  constructor(color, density) {
    this.color = new Color(color);
    this.density = density;
  }
}

export const DoubleSide = 2;

export const THREE_STUB = {
  Vector2,
  Vector3,
  Color,
  MeshStandardMaterial,
  MeshBasicMaterial,
  MeshLambertMaterial,
  LineBasicMaterial,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
  RingGeometry,
  TorusGeometry,
  OctahedronGeometry,
  DodecahedronGeometry,
  TetrahedronGeometry,
  BufferGeometry,
  Object3D,
  Group,
  Scene,
  Mesh,
  Line,
  Line3,
  OrthographicCamera,
  AmbientLight,
  DirectionalLight,
  GridHelper,
  WebGLRenderer,
  Plane,
  Raycaster,
  FogExp2,
  DoubleSide,
};
