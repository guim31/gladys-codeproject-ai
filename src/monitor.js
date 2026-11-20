// -----------------------------------------------------------------------------
// The monitor: the configured cameras, their analyses by CodeProject.AI and
// what Gladys gets of them.
//
// An analysis: read the camera picture (src/snapshot.js), upload it to
// CodeProject.AI for object detection, then, face recognition on and a
// person in view, for face recognition; publish
//   - the states of the device (only what changed, a heartbeat every 12 h);
//   - the picture with the boxes drawn, as the camera image (shrunk to the
//     150 KB Gladys takes, src/image.js);
//   - an `object_detected` scene event for each label that APPEARS (absent at
//     the previous regular analysis, present now), and a `face_recognized`
//     one for each face (a name, or "unknown") that appears, never one per
//     analysis.
// Regular analyses run on the integration's timer, one camera after the
// other (the server takes one CPU-heavy image at a time anyway), for the
// devices added in Gladys only. The analyses a scene asks for publish states
// and the image but fire no event (a scene bound to the event would loop).
// The server device carries the modules running and the detection time.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ALL_LABELS } from './config.js';
import {
  FEATURE_KEYS,
  MAX_COUNT,
  MAX_INFERENCE_MS,
  buildDevice,
  buildServer,
  countKey,
  countedLabels,
  deviceIds,
  facesText,
  labelName,
  serverIds,
  slotOf,
  summarize,
} from './devices.js';
import { CpaiClient, CpaiError, parseServerUrl } from './cpai.js';
import { asCameraImage, fitJpeg } from './image.js';
import { fetchSnapshot, parseCameraUrl, redact } from './snapshot.js';
import { ActionFailure, CONNECTION_TEXT, FAILURE, unknownFace } from './texts.js';

const logger = createLogger({ name: 'codeproject-ai' });

export const TRIGGERS = {
  OBJECT: 'object_detected',
  FACE: 'face_recognized',
  UNREACHABLE: 'camera_unreachable',
};

// The key of a stranger in the faces seen (names are the registered ids).
export const UNKNOWN_FACE = 'unknown';

// Box colours: red for a person, amber for any other object, green for a
// recognized face, blue for a stranger's.
const COLORS = {
  person: [230, 40, 40],
  object: [255, 170, 0],
  known: [40, 200, 60],
  unknown: [40, 140, 255],
};

// ObjectDetectionYOLOv5-6.2, ObjectDetectionYOLOv8, ObjectDetectionCoral… (not a
// training module such as TrainingObjectDetectionYOLOv5).
// Analyses failing in a row (timeouts, module errors) before the status turns red.
const FAILURES_BEFORE_RED = 3;

const isDetectionModule = (module) => /^(objectdetection|yolo)/i.test(module.id);

export const WIDGET_KEY = 'camera';

export const DEFAULT_TIMINGS = {
  // Housekeeping: a server down is checked again, unchanged states re-sent.
  housekeepingMs: 60_000,
  heartbeatMs: 12 * 60 * 60 * 1000,
  // Gladys takes 12 camera images a minute per device.
  minImageGapMs: 5000,
  // What an image asked by Gladys may wait for a new analysis (Gladys: 15 s).
  imageWaitMs: 12_000,
};

export class CpaiMonitor {
  /**
   * @param {{ gladys: object, fetch?: typeof fetch, timers?: boolean,
   *   clock?: () => number, timings?: object }} options
   */
  constructor({ gladys, fetch: fetchImpl, timers = true, clock = () => Date.now(), timings }) {
    this.gladys = gladys;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.useTimers = timers;
    this.clock = clock;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.config = null;
    this.client = null;
    // null until checked; then { ok, problem?, version, modules }
    this.server = null;
    // Face recognition: null until tried, false when no module serves it.
    this.faceModule = null;
    // Detection times since the last publication; their mean is published
    // with the housekeeping (cameras differ: one state a minute, not one per
    // analysis).
    this.inferenceSamples = [];
    this.inferenceMs = null;
    this.cameras = new Map();
    this.timers = [];
    this.timeouts = [];
    this.ticking = false;
    // Bumped by each configuration: a run started before drops its result.
    this.generation = 0;
    // One analysis at a time on the server.
    this.queue = Promise.resolve();
    this.statesFailing = false;
  }

  // --- Life cycle ------------------------------------------------------------

  async start(config) {
    this.applyConfig(config);
    // Timers first: a failed publication below must not leave the
    // integration without its housekeeping.
    this.schedule();
    await this.checkServer();
    await this.publishDevices();
  }

  async reconfigure(config) {
    this.stopTimers();
    this.applyConfig(config);
    this.schedule();
    await this.checkServer();
    await this.publishDevices();
    this.requestWidgetRefresh();
  }

  /** Gladys came back (a reconnection): what it may have lost, again. */
  async resync(config) {
    // Gladys restarted: the status it held is gone.
    this.statusSent = null;
    await this.reconfigure(config);
    for (const camera of this.cameras.values()) {
      this.gladys.forgetPublishedStates?.(this.ids(camera).device);
      await this.publishStates(camera);
    }
    this.gladys.forgetPublishedStates?.(serverIds(this.gladys).device);
    this.serverTransport = null;
    await this.publishServerTransport();
    await this.publishServerStates();
  }

  stop() {
    this.stopTimers();
  }

  stopTimers() {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    for (const timer of this.timeouts) {
      clearTimeout(timer);
    }
    this.timers = [];
    this.timeouts = [];
  }

  applyConfig(config) {
    const languageChanged = this.config && this.config.language !== config.language;
    const facesChanged = this.config && this.config.faces !== config.faces;
    this.config = config;
    this.generation += 1;
    const url = parseServerUrl(config.url);
    if (url !== this.client?.base) {
      this.faceModule = null;
    }
    this.client = url ? new CpaiClient({ url, fetch: this.fetch }) : null;
    const previous = this.cameras;
    this.cameras = new Map();
    for (const item of config.cameras) {
      const known = previous.get(item.slot);
      // A camera keeps its last result when its settings stay the same.
      const same =
        known &&
        known.url === item.url &&
        JSON.stringify(known.labels) === JSON.stringify(item.labels) &&
        known.confidence === item.confidence &&
        !languageChanged &&
        !facesChanged;
      this.cameras.set(item.slot, {
        ...item,
        result: same ? known.result : null,
        detections: same ? known.detections : [],
        faces: same ? known.faces : null,
        facesSeen: same ? known.facesSeen : new Set(),
        facesSeeded: same ? known.facesSeeded : false,
        image: same ? known.image : null,
        present: same ? known.present : new Set(),
        // `present` holds what the last analysis saw (see fireAppeared).
        seeded: same ? known.seeded : false,
        failure: same ? known.failure : null,
        analyzedAt: same ? known.analyzedAt : 0,
        imagePublishedAt: same ? known.imagePublishedAt : 0,
        imageSeq: known?.imageSeq ?? 0,
        running: null,
      });
    }
  }

  schedule() {
    if (!this.useTimers) {
      return;
    }
    const every = (ms, fn) => {
      const timer = setInterval(() => fn().catch((err) => logger.debug(err.message)), ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    if (this.config.intervalSeconds > 0) {
      every(this.config.intervalSeconds * 1000, () => this.tick());
      // The first analyses without waiting a full interval.
      const first = setTimeout(() => this.tick().catch((err) => logger.debug(err.message)), 1000);
      first.unref?.();
      this.timeouts.push(first);
    }
    every(this.timings.housekeepingMs, () => this.housekeeping());
  }

  // --- CodeProject.AI server ---------------------------------------------------

  async checkServer() {
    if (!this.client) {
      this.server = { ok: false, problem: 'noUrl', version: '', modules: [] };
      await this.setStatus(false, CONNECTION_TEXT.noUrl);
      return this.server;
    }
    const wasOk = this.server?.ok;
    const previous = this.server;
    try {
      const version = await this.client.ping();
      const modules = await this.client.modules().catch(() => null);
      const running = (modules ?? []).filter((module) => module.running);
      // A server that does not list its modules (an older one): trust it.
      if (modules && !running.some(isDetectionModule)) {
        this.server = { ok: false, problem: 'noDetection', version, modules: running };
        await this.setStatus(false, CONNECTION_TEXT.noDetection);
        logger[previous?.problem === 'noDetection' ? 'debug' : 'warn'](
          'CodeProject.AI runs no object detection module',
        );
      } else {
        this.server = { ok: true, version, modules: running };
        // Up, but its analyses keep failing: stays red until one works.
        if ((this.analysisFailures ?? 0) >= FAILURES_BEFORE_RED) {
          await this.setStatus(false, CONNECTION_TEXT.failing);
        } else {
          await this.setStatus(true);
        }
        if (wasOk === false || wasOk === undefined) {
          logger.info(
            `CodeProject.AI ${version} answers, modules: ${running.map((m) => m.id).join(', ') || '?'}`,
          );
        }
      }
    } catch (err) {
      const problem = err instanceof CpaiError && err.kind === 'format' ? 'error' : 'unreachable';
      if (previous?.ok !== false || previous?.problem !== problem) {
        logger.warn(`CodeProject.AI check failed: ${err.message}`);
      } else {
        logger.debug(`CodeProject.AI check failed: ${err.message}`);
      }
      this.server = { ok: false, problem, version: '', modules: [] };
      await this.setStatus(false, CONNECTION_TEXT[problem]);
    }
    await this.publishServerTransport();
    if (this.server.version !== previous?.version) {
      // The model of the server device names the version.
      if (previous && this.server.ok) {
        await this.publishDevices().catch((err) => logger.debug(err.message));
      }
    }
    await this.publishServerStates();
    return this.server;
  }

  /** The names of the modules running, for the `modules` feature. */
  modulesText() {
    const names = (this.server?.modules ?? []).map((module) => module.name);
    return names.length ? names.join(', ').slice(0, 200) : '-';
  }

  async setStatus(connected, message) {
    // Housekeeping checks every minute: tell Gladys the changes only, and
    // count a status as sent once Gladys took it (a failed POST is retried).
    const key = JSON.stringify([connected, connected ? null : message]);
    if (key === this.statusSent) {
      return;
    }
    await this.gladys
      .setConnectionStatus(connected, connected ? undefined : message)
      .then(() => {
        this.statusSent = key;
      })
      .catch((err) => {
        this.statusSent = null;
        logger.debug(`Cannot set the connection status: ${err.message}`);
      });
  }

  // --- Devices -------------------------------------------------------------------

  ids(camera) {
    return deviceIds(this.gladys, camera.slot);
  }

  async publishDevices() {
    const devices = [...this.cameras.values()]
      .filter((camera) => camera.validUrl)
      .map((camera) =>
        buildDevice(this.gladys, camera, this.config.language, { faces: this.config.faces }),
      );
    if (this.client) {
      devices.unshift(buildServer(this.gladys, this.config.language, this.server?.version));
    }
    await this.gladys.publishDiscoveredDevices(devices);
  }

  serverCreated() {
    const externalId = serverIds(this.gladys).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  async publishServerStates() {
    if (!this.client || !this.serverCreated() || !this.server?.ok) {
      return;
    }
    if (this.inferenceSamples.length > 0) {
      const sum = this.inferenceSamples.reduce((total, value) => total + value, 0);
      this.inferenceMs = sum / this.inferenceSamples.length;
      this.inferenceSamples = [];
    }
    const ids = serverIds(this.gladys);
    const states = [
      { device_feature_external_id: ids.feature(FEATURE_KEYS.MODULES), text: this.modulesText() },
    ];
    if (this.inferenceMs !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE_KEYS.INFERENCE),
        state: Math.min(Math.round(this.inferenceMs), MAX_INFERENCE_MS),
      });
    }
    await this.gladys
      .publishChangedStates(states, { heartbeat: this.timings.heartbeatMs })
      .catch((err) => logger.debug(`Cannot publish the server states: ${err.message}`));
  }

  async publishServerTransport() {
    const transport = this.server?.ok ? 'local' : 'unreachable';
    if (!this.client || !this.serverCreated() || this.serverTransport === transport) {
      return;
    }
    this.serverTransport = transport;
    await this.gladys
      .publishTransports([
        {
          external_id: serverIds(this.gladys).device,
          transport,
        },
      ])
      .catch((err) => logger.debug(err.message));
  }

  /** The device Gladys holds for this camera, when the user added it. */
  createdDevice(camera) {
    const externalId = this.ids(camera).device;
    return (this.gladys.devices ?? []).find((device) => device.external_id === externalId) ?? null;
  }

  /** The camera of a device external id, or null. */
  resolve(externalId) {
    const slot = slotOf(externalId);
    const camera = slot === null ? null : this.cameras.get(slot);
    return camera && this.ids(camera).device === externalId ? camera : null;
  }

  /** The camera of a device external id, or an ActionFailure. */
  require(externalId) {
    if (!externalId) {
      throw new ActionFailure(FAILURE.pickCamera);
    }
    const camera = this.resolve(externalId);
    if (!camera || !camera.validUrl) {
      throw new ActionFailure(FAILURE.unknownCamera);
    }
    return camera;
  }

  /** The name the user gave the camera in Gladys, else the configured one. */
  nameOf(camera) {
    return this.createdDevice(camera)?.name || camera.name;
  }

  statesOf(camera) {
    const result = camera.result;
    if (!result) {
      return [];
    }
    const ids = this.ids(camera);
    const states = [
      {
        device_feature_external_id: ids.feature(FEATURE_KEYS.OBJECT),
        state: result.total > 0 ? 1 : 0,
      },
      { device_feature_external_id: ids.feature(FEATURE_KEYS.OBJECTS), text: result.text },
    ];
    if (this.config.faces && camera.faces) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE_KEYS.FACE),
        text: facesText(camera.faces, this.config.language),
      });
    }
    for (const label of countedLabels(camera)) {
      states.push({
        device_feature_external_id: ids.feature(countKey(label)),
        state: Math.min(result.counts[label] ?? 0, MAX_COUNT),
      });
    }
    // "teddy bear" and "teddy_bear" share a feature: one state.
    return states.filter(
      (state, index) =>
        states.findIndex(
          (other) => other.device_feature_external_id === state.device_feature_external_id,
        ) === index,
    );
  }

  async publishStates(camera) {
    if (!this.createdDevice(camera)) {
      return;
    }
    const states = this.statesOf(camera);
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      if (this.statesFailing) {
        this.statesFailing = false;
        logger.info('States are published to Gladys again');
      }
    } catch (err) {
      const log = this.statesFailing ? 'debug' : 'warn';
      this.statesFailing = true;
      logger[log](`Cannot publish the states of ${camera.name}: ${err.message}`);
    }
  }

  async publishImage(camera, { force = false } = {}) {
    if (!camera.image || !this.createdDevice(camera)) {
      return;
    }
    const now = this.clock();
    if (!force && now - camera.imagePublishedAt < this.timings.minImageGapMs) {
      return;
    }
    camera.imagePublishedAt = now;
    await this.gladys
      .publishCameraImage(this.ids(camera).device, asCameraImage(camera.image.jpeg))
      .catch((err) => logger.debug(`Cannot publish the image of ${camera.name}: ${err.message}`));
  }

  async publishTransport(camera) {
    if (!this.createdDevice(camera)) {
      return;
    }
    await this.gladys
      .publishTransports([
        {
          external_id: this.ids(camera).device,
          transport: camera.failure ? 'unreachable' : 'local',
        },
      ])
      .catch((err) => logger.debug(err.message));
  }

  /** The user added a device: the states sent before were dropped. */
  async onDeviceCreated(device) {
    if (this.client && device?.external_id === serverIds(this.gladys).device) {
      this.gladys.forgetPublishedStates?.(device.external_id);
      this.serverTransport = null;
      await this.publishServerTransport();
      await this.publishServerStates();
      return;
    }
    const camera = this.resolve(device?.external_id);
    if (!camera) {
      return;
    }
    this.gladys.forgetPublishedStates?.(device.external_id);
    camera.transportSent = false;
    const fresh = !camera.result && this.server?.ok;
    if (fresh) {
      // Publishes the states and the image itself.
      await this.analyze(camera, { events: false }).catch(() => {});
    } else {
      await this.publishStates(camera);
      await this.publishImage(camera, { force: true });
    }
    if (camera.analyzedAt && !camera.transportSent) {
      camera.transportSent = true;
      await this.publishTransport(camera);
    }
    this.requestWidgetRefresh();
  }

  requestWidgetRefresh() {
    Promise.resolve(this.gladys.requestWidgetRefresh?.(WIDGET_KEY)).catch(() => {});
  }

  // --- Analyses --------------------------------------------------------------------

  /** The regular analyses: each added camera in turn. */
  async tick() {
    if (this.ticking || !this.server?.ok) {
      return;
    }
    this.ticking = true;
    try {
      const halfPeriod = (this.config.intervalSeconds * 1000) / 2;
      for (const camera of [...this.cameras.values()]) {
        // A reconfiguration during the loop replaced the cameras: stop here.
        if (this.cameras.get(camera.slot) !== camera) {
          break;
        }
        if (!camera.validUrl || !this.createdDevice(camera)) {
          continue;
        }
        // Analyzed on demand a moment ago: no need to do it again.
        if (camera.analyzedAt && this.clock() - camera.analyzedAt < halfPeriod) {
          continue;
        }
        await this.analyze(camera, { events: true }).catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }

  async housekeeping() {
    if (!this.server?.ok) {
      await this.checkServer();
      if (this.server.ok) {
        this.requestWidgetRefresh();
      }
    } else {
      // Up: its modules may have been started or stopped meanwhile.
      await this.checkServer();
    }
    for (const camera of this.cameras.values()) {
      await this.publishStates(camera);
    }
    // The first analyses missed their start (the server was not ready yet):
    // do not wait a full interval for them.
    const waiting = [...this.cameras.values()].some(
      (camera) => camera.validUrl && !camera.analyzedAt && this.createdDevice(camera),
    );
    if (waiting && this.config.intervalSeconds > 0) {
      await this.tick();
    }
  }

  /**
   * Analyze one camera now. Two calls for the same camera while one runs
   * share it. Throws an ActionFailure on failure.
   * @param {object} camera
   * @param {{ events: boolean }} options events: fire the scene events (the
   *   regular analyses only)
   */
  analyze(camera, { events }) {
    if (camera.running) {
      return camera.running;
    }
    const generation = this.generation;
    const run = this.queue.then(() => this.runAnalysis(camera, { events, generation }));
    this.queue = run.catch(() => {});
    camera.running = run.finally(() => {
      camera.running = null;
    });
    return camera.running;
  }

  /** The camera object still the current one of its slot (no reconfiguration since). */
  isCurrent(camera, generation) {
    return generation === this.generation && this.cameras.get(camera.slot) === camera;
  }

  async runAnalysis(camera, { events, generation = this.generation }) {
    if (!this.isCurrent(camera, generation)) {
      // Queued before a reconfiguration: its settings are gone.
      throw new ActionFailure(FAILURE.unknownCamera);
    }
    if (!this.client || !this.server?.ok) {
      throw new ActionFailure(FAILURE.notConfigured);
    }
    const url = parseCameraUrl(camera.url);
    if (!url) {
      throw new ActionFailure(FAILURE.unknownCamera);
    }
    let snapshot;
    try {
      snapshot = await fetchSnapshot(url, { fetch: this.fetch });
    } catch (err) {
      if (this.isCurrent(camera, generation)) {
        await this.cameraFailed(camera, err, events);
      }
      throw new ActionFailure(FAILURE.camera);
    }
    let result;
    try {
      result = await this.client.detect(snapshot, camera.confidence / 100);
    } catch (err) {
      await this.serverFailed(err);
      throw new ActionFailure(FAILURE.server);
    }
    // Confidences in percent from here on, like the configuration.
    const detections = result.predictions.map((item) => ({
      ...item,
      confidence: item.confidence * 100,
    }));
    const summary = summarize(detections, camera, this.config.language);
    const faces = await this.recognizeFaces(camera, snapshot, detections);
    if (!this.isCurrent(camera, generation)) {
      // The configuration changed meanwhile: this camera object is gone.
      return summary;
    }
    const now = this.clock();
    const facesBefore = camera.faces ? facesText(camera.faces, 'en') : null;
    const changed =
      camera.result?.text !== summary.text ||
      facesBefore !== (faces ? facesText(faces, 'en') : null);
    camera.result = summary;
    camera.detections = detections;
    if (this.config.faces) {
      // null: asked and failed (or no module): no old face passed off as current.
      camera.faces = faces;
    }
    camera.analyzedAt = now;
    if (result.inferenceMs !== null) {
      // Bounded: emptied only when the server device is published.
      this.inferenceSamples = [...this.inferenceSamples.slice(-59), result.inferenceMs];
    }
    this.analysisFailures = 0;
    if (this.serverFailing) {
      this.serverFailing = false;
      logger.info('CodeProject.AI analyzes again');
      await this.setStatus(true);
    }
    await this.cameraBack(camera);
    try {
      const jpeg = await fitJpeg(snapshot, this.boxes(camera, detections));
      if (!this.isCurrent(camera, generation)) {
        return summary;
      }
      camera.image = { jpeg, at: now };
      camera.imageSeq += 1;
      // The gap guards the regular analyses; one asked for is shown.
      await this.publishImage(camera, { force: !events });
    } catch (err) {
      logger.debug(`The picture of ${camera.name} does not fit Gladys: ${err.message}`);
    }
    await this.publishStates(camera);
    if (events) {
      await this.fireAppeared(camera, summary);
    } else if (!camera.seeded) {
      // The first look (device added, restart, new settings): what is
      // already in view did not "appear".
      camera.present = new Set(summary.labels);
      camera.facesSeen = faceKeys(camera.faces);
      // Faces not read on this first look: the next ones that are only record.
      camera.facesSeeded = camera.faces !== null;
      camera.seeded = true;
    }
    if (changed) {
      this.requestWidgetRefresh();
    }
    logger.debug(
      `${camera.name}: ${summary.text} (${result.inferenceMs ?? '?'} ms, ${redact(camera.url)})`,
    );
    return summary;
  }

  /**
   * Face recognition on the picture, when it is on and a person is in view
   * (a face needs a person: no upload for an empty garden). Null when not
   * run or failed (the last faces stay), else the faces found.
   */
  async recognizeFaces(camera, snapshot, detections) {
    if (!this.config.faces || this.faceModule === false) {
      return null;
    }
    const person = detections.some(
      (item) => item.label === 'person' && item.confidence >= camera.confidence,
    );
    if (!person) {
      return [];
    }
    try {
      const faces = await this.client.recognize(snapshot, camera.confidence / 100);
      if (this.faceModule !== true) {
        this.faceModule = true;
      }
      return faces.map((face) => ({ ...face, confidence: face.confidence * 100 }));
    } catch (err) {
      if (err instanceof CpaiError && err.kind === 'module') {
        this.faceModule = false;
        logger.warn('Face recognition is on, but CodeProject.AI has no face module');
      } else {
        logger.debug(`Face recognition failed on ${camera.name}: ${err.message}`);
      }
      return null;
    }
  }

  /** The boxes drawn on the picture: the searched objects, then the faces. */
  boxes(camera, detections) {
    const searched = (item) =>
      (camera.labels.includes(ALL_LABELS) || camera.labels.includes(item.label)) &&
      item.confidence >= camera.confidence;
    const boxes = detections.filter(searched).map((item) => ({
      ...item,
      color: item.label === 'person' ? COLORS.person : COLORS.object,
    }));
    for (const face of camera.faces ?? []) {
      boxes.push({ ...face, color: face.name ? COLORS.known : COLORS.unknown });
    }
    return boxes;
  }

  async fireAppeared(camera, summary) {
    const now = new Set(summary.labels);
    // The first look since a start or new settings only records the scene.
    const seeded = camera.seeded;
    camera.seeded = true;
    const created = this.createdDevice(camera);
    for (const label of summary.labels) {
      if (!seeded || camera.present.has(label) || !created) {
        continue;
      }
      await this.gladys
        .publishSceneEvent(TRIGGERS.OBJECT, {
          camera: this.ids(camera).device,
          camera_name: this.nameOf(camera),
          label,
          label_name: labelName(label, this.config.language),
          count: summary.counts[label],
          confidence: summary.best[label],
        })
        .catch((err) => logger.debug(`Cannot fire ${TRIGGERS.OBJECT}: ${err.message}`));
    }
    camera.present = now;
    if (!this.config.faces || camera.faces === null) {
      return; // not read this time: nothing appeared, nothing left
    }
    const faces = faceKeys(camera.faces);
    const facesSeeded = seeded && camera.facesSeeded;
    camera.facesSeeded = true;
    for (const key of faces) {
      if (!facesSeeded || camera.facesSeen.has(key) || !created) {
        continue;
      }
      const known = key !== UNKNOWN_FACE;
      const best = Math.max(
        0,
        ...camera.faces
          .filter((face) => (known ? face.name === key : !face.name))
          .map((face) => face.confidence),
      );
      await this.gladys
        .publishSceneEvent(TRIGGERS.FACE, {
          camera: this.ids(camera).device,
          camera_name: this.nameOf(camera),
          known: known ? 'known' : 'unknown',
          face_name: known ? key : facesText([{ name: null }], this.config.language),
          confidence: Math.round(best),
        })
        .catch((err) => logger.debug(`Cannot fire ${TRIGGERS.FACE}: ${err.message}`));
    }
    camera.facesSeen = faces;
  }

  async cameraFailed(camera, err, events) {
    const previousNotified = camera.failure?.notified ?? false;
    const first = !camera.failure;
    camera.failure = { at: this.clock(), message: err.message, notified: false };
    if (!first) {
      camera.failure.notified = previousNotified;
    }
    camera.analyzedAt = this.clock();
    if (first) {
      logger.warn(`Camera ${camera.name} (${redact(camera.url)}): ${err.message}`);
      camera.transportSent = true;
      await this.publishTransport(camera);
      this.requestWidgetRefresh();
    } else {
      logger.debug(`${camera.name} (${redact(camera.url)}): ${err.message}`);
    }
    // Once per outage, from a regular analysis (even when an on-demand one
    // saw the failure first).
    if (events && !camera.failure.notified && this.createdDevice(camera)) {
      camera.failure.notified = true;
      await this.gladys
        .publishSceneEvent(TRIGGERS.UNREACHABLE, {
          camera: this.ids(camera).device,
          camera_name: this.nameOf(camera),
        })
        .catch((e) => logger.debug(`Cannot fire ${TRIGGERS.UNREACHABLE}: ${e.message}`));
    }
  }

  async cameraBack(camera) {
    if (camera.failure) {
      camera.failure = null;
      camera.transportSent = true;
      logger.info(`Camera ${camera.name} answers again`);
      await this.publishTransport(camera);
      this.requestWidgetRefresh();
    } else if (!camera.transportSent) {
      // First analysis since the start: the badge says "local".
      camera.transportSent = true;
      await this.publishTransport(camera);
    }
  }

  async serverFailed(err) {
    if (err instanceof CpaiError && ['unreachable', 'module', 'format'].includes(err.kind)) {
      // The server itself: checking it again writes the line and tells Gladys.
      logger.debug(`CodeProject.AI analysis failed: ${err.message}`);
      await this.checkServer();
      return;
    }
    // A slow model, an error of the module: one line until an analysis works
    // again, and the status red after a few failures in a row.
    const log = this.serverFailing ? 'debug' : 'warn';
    this.serverFailing = true;
    this.analysisFailures = (this.analysisFailures ?? 0) + 1;
    logger[log](`CodeProject.AI analysis failed: ${err.message}`);
    if (this.analysisFailures >= FAILURES_BEFORE_RED) {
      await this.setStatus(false, CONNECTION_TEXT.failing);
    }
  }

  /**
   * Register the face in the current picture of a camera under `name`.
   * Throws an ActionFailure.
   */
  async registerFace(externalId, name) {
    const camera = this.require(externalId);
    const person = String(name ?? '').trim();
    if (!person) {
      throw new ActionFailure(FAILURE.pickName);
    }
    if (!this.client || !this.server?.ok) {
      throw new ActionFailure(FAILURE.notConfigured);
    }
    let snapshot;
    try {
      snapshot = await fetchSnapshot(parseCameraUrl(camera.url), { fetch: this.fetch });
    } catch {
      throw new ActionFailure(FAILURE.camera);
    }
    try {
      await this.client.register(snapshot, person.slice(0, 60));
    } catch (err) {
      if (err instanceof CpaiError && err.kind === 'module') {
        this.faceModule = false;
        throw new ActionFailure(FAILURE.noFaceModule);
      }
      if (err instanceof CpaiError && err.kind === 'noFace') {
        throw new ActionFailure(FAILURE.noFace);
      }
      logger.warn(`Face registration failed: ${err.message}`);
      throw new ActionFailure(FAILURE.server);
    }
    this.faceModule = true;
    logger.info(`Face registered from ${camera.name}`);
    return this.nameOf(camera);
  }

  /** Forget a registered face. Throws an ActionFailure. */
  async deleteFace(name) {
    const person = String(name ?? '').trim();
    if (!person) {
      throw new ActionFailure(FAILURE.pickName);
    }
    if (!this.client || !this.server?.ok) {
      throw new ActionFailure(FAILURE.notConfigured);
    }
    const faces = await this.registeredFaces();
    if (faces === null) {
      throw new ActionFailure(FAILURE.noFaceModule);
    }
    if (!faces.includes(person)) {
      throw new ActionFailure(unknownFace(person, faces));
    }
    try {
      await this.client.deleteFace(person);
    } catch (err) {
      logger.warn(`Face deletion failed: ${err.message}`);
      throw new ActionFailure(FAILURE.server);
    }
    logger.info('Face deleted');
  }

  /** The names registered, [] when none, null when no face module answers. */
  async registeredFaces() {
    try {
      const faces = await this.client.faces();
      this.faceModule = true;
      return faces;
    } catch (err) {
      if (err instanceof CpaiError && err.kind === 'module') {
        this.faceModule = false;
      }
      return null;
    }
  }

  /** The last result of a camera, worded in `language`. */
  summaryIn(camera, language) {
    return summarize(camera.detections ?? [], camera, language);
  }

  /** The last faces of a camera, worded in `language`, or null (off, not run). */
  facesIn(camera, language) {
    return this.config.faces && camera.faces ? facesText(camera.faces, language) : null;
  }

  /** A fresh image for Gladys (dashboard, chat, "Send a camera image"). */
  async imageFor(externalId) {
    const camera = this.require(externalId);
    const fresh =
      camera.image &&
      this.clock() - camera.image.at < Math.max(this.config.intervalSeconds, 10) * 1000;
    if (!fresh && this.server?.ok) {
      // Gladys waits 15 s: past that, the last picture (if the camera works).
      let timer;
      await Promise.race([
        this.analyze(camera, { events: false }).catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.timings.imageWaitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    // A camera down: no old picture passed off as the current one.
    if (!camera.image || camera.failure) {
      throw new ActionFailure(FAILURE.camera);
    }
    return asCameraImage(camera.image.jpeg);
  }
}

/** The keys of the faces in view: the names, and `unknown` for strangers. */
function faceKeys(faces) {
  return new Set((faces ?? []).map((face) => face.name ?? UNKNOWN_FACE));
}
