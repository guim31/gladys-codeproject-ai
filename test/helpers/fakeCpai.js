// -----------------------------------------------------------------------------
// A simulated CodeProject.AI Server and IP cameras, behind one `fetch`.
//
// The server (http://192.0.2.10:32168) answers what a real
// codeproject/ai-server 2.9.7 answered on real photos (test/fixtures/cpai,
// recorded with the YOLOv5 6.2 and Face Processing modules on CPU): detection
// filtered by `min_confidence` as the server does, face recognition ("unknown"
// until the face is registered), registration, the face list, the module
// list; and its errors: HTTP 200 with `success: false` for a picture without a
// face or bytes that are not an image, a bare 404 for a route no module serves.
// Cameras (http://192.0.2.20/<name>.jpg): each serves a small JPEG standing
// for one recorded scene; `scene(name, sceneName)` changes what it "sees".
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { smallJpeg } from './jpeg.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/cpai/${name}`, import.meta.url), 'utf8'));

// Scene name → recorded detection, and the face in view (null: none).
export const SCENES = {
  street: { detection: fixture('detect-people.json'), face: null },
  car: { detection: fixture('detect-car.json'), face: null },
  portrait: { detection: fixture('detect-face1.json'), face: 'portrait' },
  empty: {
    detection: { message: 'No objects found', count: 0, predictions: [], success: true },
    face: null,
  },
};

export const SERVER_URL = 'http://192.0.2.10:32168';
export const CAMERA_HOST = 'http://192.0.2.20';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notFound = () =>
  new Response(JSON.stringify({ title: 'Not Found', status: 404 }), {
    status: 404,
    headers: { 'content-type': 'application/problem+json' },
  });

const failure = (error, command) =>
  json(200, { success: false, error, code: 500, command, moduleId: 'FaceProcessing' });

export class FakeCpai {
  constructor() {
    this.down = false;
    this.faceModule = true;
    this.detectionRunning = true;
    this.registered = new Set();
    this.requests = [];
    // camera name → { scene, bytes, auth?, down?, html? }
    this.cameras = new Map();
    this.byImage = new Map(); // base64 → scene name
    this.shade = 40;
    this.camera('front', 'street');
    this.camera('garden', 'car');
    this.fetch = this.fetch.bind(this);
  }

  camera(name, scene, options = {}) {
    const bytes = smallJpeg(64, 36, (this.shade += 20));
    this.byImage.set(bytes.toString('base64'), scene);
    this.cameras.set(name, { scene, bytes, ...options });
    return `${CAMERA_HOST}/${name}.jpg`;
  }

  scene(name, scene) {
    const camera = this.cameras.get(name);
    camera.scene = scene;
    this.byImage.set(camera.bytes.toString('base64'), scene);
  }

  calls(path) {
    return this.requests.filter((item) => item.url.endsWith(path)).length;
  }

  async fetch(input, init = {}) {
    const url = new URL(String(input));
    const fields = {};
    if (init.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        fields[key] =
          typeof value === 'string'
            ? value
            : Buffer.from(await value.arrayBuffer()).toString('base64');
      }
    }
    this.requests.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      fields,
    });
    if (url.origin === new URL(SERVER_URL).origin) {
      if (this.down) {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      }
      return this.server(url, fields);
    }
    if (url.origin === CAMERA_HOST) {
      const camera = this.cameras.get(url.pathname.replace(/^\/|\.jpg$/g, ''));
      if (!camera || camera.down) {
        throw new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
      }
      if (
        camera.auth &&
        init.headers?.authorization !== `Basic ${Buffer.from(camera.auth).toString('base64')}`
      ) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (camera.html) {
        return new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      this.byImage.set(camera.bytes.toString('base64'), camera.scene);
      return new Response(camera.bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  }

  server(url, fields) {
    const scene = SCENES[this.byImage.get(fields.image)];
    switch (url.pathname) {
      case '/v1/server/status/ping':
        return json(200, fixture('ping.json'));
      case '/v1/module/list/status': {
        const modules = fixture('modules.json');
        modules.statuses = modules.statuses
          .filter((item) => this.faceModule || item.moduleId !== 'FaceProcessing')
          .map((item) =>
            item.moduleId.startsWith('ObjectDetection') && !this.detectionRunning
              ? { ...item, status: 'Stopped' }
              : item,
          );
        return json(200, modules);
      }
      case '/v1/vision/detection': {
        if (!this.detectionRunning) {
          return notFound();
        }
        if (!scene) {
          return json(200, { success: false, error: 'Error occurred on the server', code: 500 });
        }
        const min = Number(fields.min_confidence ?? 0.4);
        const recorded = scene.detection;
        const predictions = recorded.predictions.filter((item) => item.confidence >= min);
        return json(200, { ...recorded, predictions, count: predictions.length });
      }
      case '/v1/vision/face/recognize':
        if (!this.faceModule) {
          return notFound();
        }
        if (!scene?.face) {
          return failure('No face found in image', 'recognize');
        }
        return json(
          200,
          fixture(
            this.registered.has(scene.face) ? 'recognize-known.json' : 'recognize-unknown.json',
          ),
        );
      case '/v1/vision/face/register':
        if (!this.faceModule) {
          return notFound();
        }
        if (!scene?.face) {
          return failure('No face detected', 'register');
        }
        this.registered.add(scene.face);
        return json(200, { success: true, message: 'face added', moduleId: 'FaceProcessing' });
      case '/v1/vision/face/delete':
        if (!this.faceModule) {
          return notFound();
        }
        this.registered.clear();
        return json(200, { success: true, moduleId: 'FaceProcessing' });
      case '/v1/vision/face/list':
        if (!this.faceModule) {
          return notFound();
        }
        return json(200, {
          success: true,
          faces: [...this.registered].map(() => 'Alice'),
          moduleId: 'FaceProcessing',
        });
      default:
        return notFound();
    }
  }
}
