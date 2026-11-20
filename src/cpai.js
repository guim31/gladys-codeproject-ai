// -----------------------------------------------------------------------------
// CodeProject.AI Server client (its HTTP API, DeepStack-compatible):
//   GET  /v1/server/status/ping       is the server up, its version;
//   GET  /v1/module/list/status       the modules installed, with their status;
//   POST /v1/vision/detection         multipart `image` + `min_confidence`
//                                     (0-1) → `predictions` with a label, a
//                                     confidence (0-1) and a box in pixels;
//   POST /v1/vision/face/recognize    same, the box of each face and its
//                                     `userid` ("unknown" for a stranger);
//   POST /v1/vision/face/register     multipart `image` + `userid`;
//   POST /v1/vision/face/list         the names registered;
//   POST /v1/vision/face/delete       multipart `userid`: forget that face.
// Recorded on codeproject/ai-server 2.9.7: a vision route that fails answers
// HTTP 200 with `{ success: false, error, code: 500 }` ("Error occurred on the
// server" for bytes that are not an image, "No face found in image" for a
// picture without a face); a route no installed module serves answers a bare
// HTTP 404 (`application/problem+json`).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 32168;
// A CPU detection takes a fraction of a second, but the first one loads the
// model: the whole request, upload included, gets this long.
export const DETECT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 8000;

export class CpaiError extends Error {
  /**
   * @param {'unreachable'|'timeout'|'module'|'noFace'|'http'|'format'} kind
   */
  constructor(kind, message) {
    super(message);
    this.name = 'CpaiError';
    this.kind = kind;
  }
}

/**
 * The base URL of a CodeProject.AI server from what the user typed
 * ("192.0.2.5", "cpai.lan:32168", "https://cpai.example/"), or null.
 */
export function parseServerUrl(text) {
  const value = String(text ?? '').trim();
  if (!value) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  if (!url.port && url.protocol === 'http:' && !/:\d+/.test(withScheme.split('/')[2])) {
    url.port = String(DEFAULT_PORT);
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

const NO_FACE = /no face/i;

/** A box in pixels, the way every prediction carries it. */
function boxOf(item) {
  return {
    x_min: Number(item?.x_min) || 0,
    y_min: Number(item?.y_min) || 0,
    x_max: Number(item?.x_max) || 0,
    y_max: Number(item?.y_max) || 0,
  };
}

export class CpaiClient {
  /**
   * @param {{ url: string, fetch?: typeof fetch }} options
   */
  constructor({ url, fetch: fetchImpl = globalThis.fetch }) {
    this.base = parseServerUrl(url);
    if (!this.base) {
      throw new CpaiError('format', 'Invalid CodeProject.AI address');
    }
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', form, timeoutMs }) {
    let response;
    try {
      response = await this.fetch(`${this.base}${path}`, {
        method,
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new CpaiError(
          'timeout',
          `CodeProject.AI did not answer within ${timeoutMs / 1000} s`,
        );
      }
      throw new CpaiError(
        'unreachable',
        `CodeProject.AI is unreachable (${err?.cause?.code ?? err?.message})`,
      );
    }
    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const error = typeof data?.error === 'string' ? data.error : '';
    if (response.status === 404) {
      throw new CpaiError('module', `No CodeProject.AI module serves ${path}`);
    }
    if (!data || typeof data !== 'object') {
      if (!response.ok) {
        throw new CpaiError('http', `CodeProject.AI answered HTTP ${response.status}`);
      }
      throw new CpaiError('format', 'CodeProject.AI did not answer JSON: is it the right address?');
    }
    if (!response.ok || data.success === false) {
      throw new CpaiError(
        NO_FACE.test(error) ? 'noFace' : 'http',
        `CodeProject.AI answered HTTP ${response.status}${error ? `: ${error}` : ''}`,
      );
    }
    return data;
  }

  /** Is the server up: its version ("2.9.7", '' if unsaid), or a CpaiError. */
  async ping() {
    const data = await this.request('/v1/server/status/ping', { timeoutMs: STATUS_TIMEOUT_MS });
    const info = data.version;
    return info && [info.major, info.minor, info.patch].every((part) => Number.isInteger(part))
      ? `${info.major}.${info.minor}.${info.patch}`
      : '';
  }

  /**
   * The modules installed: `[{ id, name, running }]`, `running` true when the
   * server says the module is started.
   */
  async modules() {
    const data = await this.request('/v1/module/list/status', { timeoutMs: STATUS_TIMEOUT_MS });
    return (Array.isArray(data.statuses) ? data.statuses : [])
      .map((item) => {
        const status = String(item?.status ?? '').toLowerCase();
        return {
          id: String(item?.moduleId ?? ''),
          name: String(item?.name ?? item?.moduleId ?? ''),
          // "Started"; else "NoAutoStart", "Stopped", "FailedStart", "Installing"…
          running: status === 'started',
        };
      })
      .filter((item) => item.id);
  }

  form(image, fields = {}) {
    const form = new FormData();
    form.append('image', new Blob([image], { type: 'image/jpeg' }), 'image.jpg');
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, String(value));
    }
    return form;
  }

  /**
   * Objects in a picture.
   * @param {Buffer} image JPEG bytes
   * @param {number} minConfidence 0-1
   * @returns {Promise<{ predictions: Array<{ label: string, confidence: number,
   *   x_min: number, y_min: number, x_max: number, y_max: number }>, inferenceMs: number|null,
   *   moduleId: string }>}
   */
  async detect(image, minConfidence) {
    const data = await this.request('/v1/vision/detection', {
      method: 'POST',
      form: this.form(image, { min_confidence: minConfidence }),
      timeoutMs: DETECT_TIMEOUT_MS,
    });
    const predictions = (Array.isArray(data.predictions) ? data.predictions : [])
      .map((item) => ({
        label: String(item?.label ?? '')
          .trim()
          .toLowerCase(),
        confidence: Number(item?.confidence),
        ...boxOf(item),
      }))
      .filter((item) => item.label && Number.isFinite(item.confidence));
    return {
      predictions,
      inferenceMs: Number.isFinite(Number(data.inferenceMs)) ? Number(data.inferenceMs) : null,
      moduleId: String(data.moduleId ?? ''),
    };
  }

  /**
   * Faces in a picture, with the name each was registered under.
   * @returns {Promise<Array<{ name: string|null, confidence: number, x_min: number,
   *   y_min: number, x_max: number, y_max: number }>>} `name` null for a stranger
   */
  async recognize(image, minConfidence) {
    let data;
    try {
      data = await this.request('/v1/vision/face/recognize', {
        method: 'POST',
        form: this.form(image, { min_confidence: minConfidence }),
        timeoutMs: DETECT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof CpaiError && err.kind === 'noFace') {
        return []; // a person seen from behind, too far, too small
      }
      throw err;
    }
    return (Array.isArray(data.predictions) ? data.predictions : [])
      .map((item) => {
        const userid = String(item?.userid ?? '').trim();
        return {
          name: userid && userid.toLowerCase() !== 'unknown' ? userid : null,
          confidence: Number(item?.confidence) || 0,
          ...boxOf(item),
        };
      })
      .filter((item) => item.x_max > item.x_min || item.name);
  }

  /** Register the face in `image` under `name` (a 'noFace' CpaiError when none). */
  async register(image, name) {
    await this.request('/v1/vision/face/register', {
      method: 'POST',
      form: this.form(image, { userid: name }),
      timeoutMs: DETECT_TIMEOUT_MS,
    });
  }

  /** Forget every face registered under `name`. */
  async deleteFace(name) {
    const form = new FormData();
    form.append('userid', name);
    await this.request('/v1/vision/face/delete', {
      method: 'POST',
      form,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
  }

  /** The names registered on the server. */
  async faces() {
    const data = await this.request('/v1/vision/face/list', {
      method: 'POST',
      form: new FormData(),
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    return (Array.isArray(data.faces) ? data.faces : []).map((name) => String(name));
  }
}
