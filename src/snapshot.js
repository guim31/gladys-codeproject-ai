// -----------------------------------------------------------------------------
// Camera images: where the picture CodeProject.AI analyzes comes from.
//
// An integration cannot read the image of a camera another integration put in
// Gladys (the SDK has no such call), so each camera is the address of a JPEG
// snapshot the user gives (http or https). The integration downloads it and
// uploads the bytes to CodeProject.AI, so "camera unreachable" and "server
// unreachable" stay two different problems. `user:password@` in the URL
// becomes an HTTP Basic header (fetch refuses credentials in a URL). An RTSP
// stream would need ffmpeg in the container: out of scope (most cameras, and
// Frigate, go2rtc, Shinobi, Blue Iris… serve a snapshot URL).
// The URL may hold a password: it is never logged, only `redact`ed.
// -----------------------------------------------------------------------------

export const SNAPSHOT_TIMEOUT_MS = 10_000;
// A camera snapshot is a few hundred kilobytes; this bounds a wrong URL.
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const PROTOCOLS = ['http:', 'https:'];

export class SnapshotError extends Error {
  /** @param {'unreachable'|'timeout'|'auth'|'http'|'format'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'SnapshotError';
    this.kind = kind;
  }
}

/** The URL object of a camera address, or null. */
export function parseCameraUrl(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  return PROTOCOLS.includes(url.protocol) && url.hostname ? url : null;
}

/** A camera address fit for the logs: scheme, host and port, nothing else. */
export function redact(text) {
  const url = parseCameraUrl(text);
  return url ? `${url.protocol}//${url.host}` : '(invalid address)';
}

/**
 * Download a JPEG snapshot.
 * @param {URL} url an http(s) camera address
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {Promise<Buffer>}
 */
export async function fetchSnapshot(url, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const target = new URL(url);
  const headers = { accept: 'image/jpeg,image/*;q=0.8' };
  if (target.username || target.password) {
    let user;
    let password;
    try {
      user = decodeURIComponent(target.username);
      password = decodeURIComponent(target.password);
    } catch {
      // A bare "%" in the password: write it %25 in the address.
      throw new SnapshotError('format', 'Invalid user or password in the camera address');
    }
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    target.username = '';
    target.password = '';
  }
  let response;
  try {
    response = await fetchImpl(target.toString(), {
      headers,
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new SnapshotError('timeout', 'The camera did not answer in time');
    }
    throw new SnapshotError(
      'unreachable',
      `The camera is unreachable (${err?.cause?.code ?? err?.message})`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new SnapshotError('auth', `The camera refuses the access (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new SnapshotError('http', `The camera answered HTTP ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotError('format', 'The camera answers something too large for a snapshot');
  }
  const bytes = await readBounded(response);
  if (bytes.length === 0) {
    throw new SnapshotError('format', 'The camera answers an empty file');
  }
  // A JPEG, the format of camera snapshots and of Gladys camera images;
  // anything else (a login page, a PNG) is refused here, said in clear.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new SnapshotError('format', 'The camera address does not give a JPEG image');
  }
  return bytes;
}

/**
 * The body, read chunk by chunk and dropped past MAX_SNAPSHOT_BYTES: a video
 * or MJPEG address given by mistake never fills the 256 MB of the sandbox.
 */
async function readBounded(response) {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > MAX_SNAPSHOT_BYTES) {
        throw new SnapshotError('format', 'The camera answers something too large for a snapshot');
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof SnapshotError) {
      throw err;
    }
    throw new SnapshotError('timeout', 'The camera did not send its picture in time');
  }
  return Buffer.concat(chunks);
}
