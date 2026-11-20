// -----------------------------------------------------------------------------
// The monitor against the simulated CodeProject.AI server and cameras
// (test/helpers, answers recorded on a real server): states, images, scene
// events on appearance only, regular analyses for the added devices only,
// faces, failures (camera, server, modules), actions shown in red on
// failure, the widget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseConfidence, parseLabels } from '../src/config.js';
import { CpaiClient, CpaiError, parseServerUrl } from '../src/cpai.js';
import { SnapshotError, fetchSnapshot, redact } from '../src/snapshot.js';
import { BASE_CONFIG, CAMERA_HOST, FakeCpai, createAll, createWorld } from './helpers/world.js';

const ID = {
  server: 'ext:test-integration:server:server',
  front: 'ext:test-integration:camera:1',
  garden: 'ext:test-integration:camera:2',
};
const FACES = { ...BASE_CONFIG, faces: 'on' };
const last = (world, id) => world.fake.lastState(id);
const text = (world, id) => {
  const state = world.fake.states.filter((item) => item.device_feature_external_id === id).pop();
  return state?.text;
};

test('configuration: labels, confidence, slots, faces, defaults', () => {
  assert.deepEqual(parseLabels(' Person, CAR;; traffic  light,person '), [
    'person',
    'car',
    'traffic light',
  ]);
  assert.deepEqual(parseLabels('person, *'), ['*']);
  assert.equal(parseConfidence('55 %'), 55);
  assert.equal(parseConfidence('abc'), null);

  const config = normalizeConfig({
    ...BASE_CONFIG,
    confidence: '70',
    camera_2_labels: 'dog',
    camera_2_confidence: '40',
    camera_3_url: '   ',
    camera_4_url: 'rtsp://192.0.2.30/stream',
  });
  assert.equal(config.intervalSeconds, 60);
  assert.equal(config.faces, false);
  assert.deepEqual(
    config.cameras.map((camera) => [
      camera.slot,
      camera.labels,
      camera.confidence,
      camera.validUrl,
    ]),
    [
      [1, ['person', 'car', 'cat', 'dog'], 70, true],
      [2, ['dog'], 40, true],
      // RTSP needs ffmpeg: not a camera address here.
      [4, ['person', 'car', 'cat', 'dog'], 70, false],
    ],
  );
  const defaults = normalizeConfig({});
  assert.equal(defaults.language, 'fr');
  assert.equal(defaults.validUrl, false);
  assert.equal(normalizeConfig({ faces: 'on' }).faces, true);
});

test('addresses: port 32168 by default, camera credentials never shown', () => {
  assert.equal(parseServerUrl('192.0.2.10'), 'http://192.0.2.10:32168');
  assert.equal(parseServerUrl('cpai.lan:5000/'), 'http://cpai.lan:5000');
  assert.equal(parseServerUrl('https://cpai.example/'), 'https://cpai.example');
  assert.equal(parseServerUrl('ftp://x'), null);
  assert.equal(parseServerUrl(''), null);
  assert.equal(redact('http://admin:secret@192.0.2.30:8080/snap.jpg'), 'http://192.0.2.30:8080');
  assert.equal(redact('nope'), '(invalid address)');
});

test('the client uploads the picture and reads the recorded answers and errors', async () => {
  const server = new FakeCpai();
  const client = new CpaiClient({ url: '192.0.2.10', fetch: server.fetch });
  assert.equal(await client.ping(), '2.9.7');
  const modules = await client.modules();
  assert.deepEqual(
    modules.filter((item) => item.running).map((item) => item.id),
    ['FaceProcessing', 'ObjectDetectionYOLOv5-6.2'],
  );
  const image = server.cameras.get('garden').bytes;
  const result = await client.detect(image, 0.7);
  assert.equal(server.requests.at(-1).fields.min_confidence, '0.7');
  assert.equal(server.requests.at(-1).fields.image, image.toString('base64'));
  assert.deepEqual(
    result.predictions.map((item) => item.label),
    ['truck', 'car', 'car'],
  );
  assert.equal(result.inferenceMs, 650);
  assert.deepEqual(Object.keys(result.predictions[0]).sort(), [
    'confidence',
    'label',
    'x_max',
    'x_min',
    'y_max',
    'y_min',
  ]);
  // A picture without a face is no face, not an error.
  assert.deepEqual(await client.recognize(image, 0.6), []);
  await assert.rejects(client.register(image, 'Alice'), (err) => err.kind === 'noFace');
  // Bytes that are not an image: the module's error, HTTP 200 and success false.
  await assert.rejects(client.detect(Buffer.from('nope'), 0.5), (err) => err.kind === 'http');
  server.faceModule = false;
  await assert.rejects(client.recognize(image, 0.6), (err) => err.kind === 'module');
  server.down = true;
  await assert.rejects(
    client.ping(),
    (err) => err instanceof CpaiError && err.kind === 'unreachable',
  );
});

test('a snapshot URL with credentials becomes a Basic header; a page is not an image', async () => {
  const server = new FakeCpai();
  server.camera('locked', 'car', { auth: 'admin:p@ss' });
  const bytes = await fetchSnapshot(new URL(`http://admin:p%40ss@192.0.2.20/locked.jpg`), {
    fetch: server.fetch,
  });
  assert.equal(bytes[0], 0xff);
  const request = server.requests.at(-1);
  assert.equal(request.url, `${CAMERA_HOST}/locked.jpg`);
  await assert.rejects(
    fetchSnapshot(new URL(`${CAMERA_HOST}/locked.jpg`), { fetch: server.fetch }),
    (err) => err instanceof SnapshotError && err.kind === 'auth',
  );
  server.camera('login', 'car', { html: true });
  await assert.rejects(
    fetchSnapshot(new URL(`${CAMERA_HOST}/login.jpg`), { fetch: server.fetch }),
    (err) => err instanceof SnapshotError && err.kind === 'format',
  );
  await assert.rejects(
    fetchSnapshot(new URL(`http://admin:p%zz@192.0.2.20/front.jpg`), { fetch: server.fetch }),
    (err) => err instanceof SnapshotError && err.kind === 'format',
  );
});

test('connected: the devices are published and the status is green', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.external_id),
    [ID.server, ID.front, ID.garden],
  );
  assert.equal(world.fake.discoveredDevices[0].model, 'CodeProject.AI Server 2.9.7');
  // Nothing is analyzed before the user adds a device.
  await world.monitor.tick();
  assert.equal(world.server.calls('/v1/vision/detection'), 0);
});

test('adding the devices analyzes the cameras and sends every state, the image and the badge', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(last(world, `${ID.front}:object`), 1);
  // Recorded on a real street photo, above 60 %.
  assert.equal(text(world, `${ID.front}:objects`), 'Car ×5, Person ×5');
  assert.equal(last(world, `${ID.front}:count-person`), 5);
  assert.equal(last(world, `${ID.front}:count-car`), 5);
  assert.equal(last(world, `${ID.front}:count-dog`), 0);
  assert.equal(text(world, `${ID.garden}:objects`), 'Car ×3');
  // The server: the modules running, the time of the last detection.
  assert.equal(
    text(world, `${ID.server}:modules`),
    'Face Processing, Object Detection (YOLOv5 6.2)',
  );
  await world.monitor.housekeeping();
  // The mean of the two analyses (838 and 650 ms, recorded).
  assert.equal(last(world, `${ID.server}:inference`), 744);
  assert.deepEqual(
    world.fake.cameraImages.map((item) => item.device_external_id),
    [ID.front, ID.garden],
  );
  // The boxes are drawn: the picture is re-encoded, not the camera's bytes.
  const sent = Buffer.from(world.fake.cameraImages[0].image.split(',')[1], 'base64');
  assert.equal(sent[0], 0xff);
  assert.notDeepEqual(sent, world.server.cameras.get('front').bytes);
  assert.deepEqual(
    world.fake.transports.map((item) => [item.device_external_id, item.transport]),
    [
      [ID.server, 'local'],
      [ID.front, 'local'],
      [ID.garden, 'local'],
    ],
  );
  // The device creation is not a regular analysis: no scene event.
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.ok(world.fake.widgetRefreshes.length > 0);
  // Face recognition off: no face asked, no face feature.
  assert.equal(world.server.calls('/v1/vision/face/recognize'), 0);
  assert.ok(!world.fake.discoveredDevices[1].features.some((f) => f.external_id.endsWith(':face')));
});

test('regular analyses: only changes are published, an event when an object appears', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.clock.advance(60_000);
  await world.monitor.tick();
  // Already in view when the device was added: nothing "appeared".
  assert.deepEqual(world.fake.sceneEvents, []);
  const states = world.fake.states.length;
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.equal(world.fake.states.length, states, 'nothing changed, nothing published');

  world.server.scene('garden', 'empty');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.equal(last(world, `${ID.garden}:object`), 0);
  assert.equal(text(world, `${ID.garden}:objects`), 'None');
  world.server.scene('garden', 'street');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => [event.key, event.data.camera, event.data.label]),
    [
      ['object_detected', ID.garden, 'car'],
      ['object_detected', ID.garden, 'person'],
    ],
  );
  assert.deepEqual(world.fake.sceneEvents[1].data, {
    camera: ID.garden,
    camera_name: 'Garden',
    label: 'person',
    label_name: 'Person',
    count: 5,
    confidence: 86,
  });
});

test('after a restart, the first regular analysis records the scene without an event', async (t) => {
  const created = (await createWorld()).fake.discoveredDevices;
  const world = await createWorld({ created });
  t.after(() => world.app.stop());
  await world.monitor.tick();
  assert.deepEqual(world.fake.sceneEvents, []);
  world.server.scene('garden', 'portrait');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => event.data.label),
    ['person'],
  );
});

test('faces: a stranger, then the face registered from a camera is recognized', async (t) => {
  const world = await createWorld({ config: FACES });
  t.after(() => world.app.stop());
  await createAll(world);
  // A street seen from afar: persons, but no face the module can read.
  assert.equal(text(world, `${ID.front}:face`), 'None');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.deepEqual(world.fake.sceneEvents, []);

  // A stranger comes to the garden.
  world.server.scene('garden', 'portrait');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.equal(text(world, `${ID.garden}:face`), 'Unknown');
  const faces = world.fake.sceneEvents.filter((event) => event.key === 'face_recognized');
  assert.deepEqual(faces[0].data, {
    camera: ID.garden,
    camera_name: 'Garden',
    known: 'unknown',
    face_name: 'Unknown',
    confidence: 0,
  });

  // Registered from the garden camera: recognized next time it appears.
  const failed = await world.fake.action('register_face', { camera: ID.front, name: 'Alice' });
  assert.equal(failed.success, false, 'no face in the street picture');
  assert.match(failed.error.fr, /Aucun visage/);
  const missing = await world.fake.action('register_face', { camera: ID.garden, name: ' ' });
  assert.equal(missing.success, false);
  assert.match(missing.error.fr, /nom/);
  const ok = await world.fake.action('register_face', { camera: ID.garden, name: 'Alice' });
  assert.equal(ok.success, true);
  assert.match(ok.data.message.fr, /Visage de Alice enregistré depuis Garden/);
  assert.equal(world.server.requests.at(-1).fields.userid, 'Alice');

  world.server.scene('garden', 'empty');
  world.clock.advance(60_000);
  await world.monitor.tick();
  world.server.scene('garden', 'portrait');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.equal(text(world, `${ID.garden}:face`), 'Alice');
  const known = world.fake.sceneEvents.filter((event) => event.key === 'face_recognized').pop();
  assert.deepEqual(known.data, {
    camera: ID.garden,
    camera_name: 'Garden',
    known: 'known',
    face_name: 'Alice',
    confidence: 80,
  });
  // No person, no face asked: the empty scene cost one upload, not two.
  const ack = await world.fake.sceneAction('analyze', { camera: ID.garden });
  assert.equal(ack.success, true);
  assert.equal(ack.data.outputs.faces, 'Alice');
  assert.equal(ack.data.outputs.known_face, true);

  // Deleted: a stranger again.
  const check = await world.fake.action('check', {});
  assert.match(check.data.message.en, /Faces registered: Alice/);
  const unknown = await world.fake.action('delete_face', { name: 'Bob' });
  assert.equal(unknown.success, false);
  assert.match(
    unknown.error.fr,
    /Aucun visage enregistré sous « Bob »\. Visages enregistrés : Alice/,
  );
  const deleted = await world.fake.action('delete_face', { name: 'Alice' });
  assert.equal(deleted.success, true);
  assert.equal(deleted.data.message.fr, 'Visage de Alice supprimé.');
  await world.fake.sceneAction('analyze', { camera: ID.garden });
  assert.equal(text(world, `${ID.garden}:face`), 'Unknown');
});

test('faces on without the face module: one warning, the objects still work', async (t) => {
  const server = new FakeCpai();
  server.faceModule = false;
  const world = await createWorld({ server, config: FACES });
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(text(world, `${ID.front}:objects`), 'Car ×5, Person ×5');
  assert.equal(text(world, `${ID.front}:face`), undefined);
  const recognize = server.calls('/v1/vision/face/recognize');
  world.server.scene('garden', 'portrait');
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.equal(server.calls('/v1/vision/face/recognize'), recognize, 'not asked again');
  const check = await world.fake.action('check', {});
  assert.equal(check.success, true);
  assert.match(check.data.message.en, /no face module answers/);
  const register = await world.fake.action('register_face', { camera: ID.garden, name: 'Alice' });
  assert.equal(register.success, false);
  assert.match(register.error.en, /Face Processing/);
  const remove = await world.fake.action('delete_face', { name: 'Alice' });
  assert.equal(remove.success, false);
  assert.match(remove.error.en, /Face Processing/);
});

test('a failure first seen on demand still fires one "camera unreachable" event', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.cameras.get('front').down = true;
  const ack = await world.fake.sceneAction('analyze', { camera: ID.front });
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /caméra/);
  assert.deepEqual(world.fake.sceneEvents, []);
  for (let round = 0; round < 2; round += 1) {
    world.clock.advance(60_000);
    await world.monitor.tick();
  }
  assert.equal(world.fake.sceneEvents.filter((e) => e.key === 'camera_unreachable').length, 1);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  // Gladys asks for the image: no old picture passed off as current.
  const image = await world.fake.getImage({ external_id: ID.front });
  assert.equal(image.success, false);
  // Back.
  world.server.cameras.get('front').down = false;
  world.clock.advance(60_000);
  await world.monitor.tick();
  assert.equal(
    world.fake.transports.filter((item) => item.device_external_id === ID.front).at(-1).transport,
    'local',
  );
});

test('the check action: green with the modules and each camera, red when none can be read', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ok = await world.fake.action('check', {});
  assert.equal(ok.success, true);
  assert.match(ok.data.message.fr, /CodeProject\.AI 2\.9\.7 répond à http:\/\/192\.0\.2\.10:32168/);
  assert.match(ok.data.message.fr, /Object Detection \(YOLOv5 6\.2\)/);
  assert.match(ok.data.message.fr, /Garden : Voiture ×3 \(84 %\)/);
  world.server.cameras.get('front').down = true;
  world.server.cameras.get('garden').down = true;
  const ack = await world.fake.action('check', {});
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /Front door : image non lue/);
});

test('the threshold and the labels of a camera are applied', async (t) => {
  const world = await createWorld({
    config: { ...BASE_CONFIG, camera_1_labels: 'person, truck', camera_1_confidence: '80' },
  });
  t.after(() => world.app.stop());
  await createAll(world);
  const upload = world.server.requests.find(
    (item) => item.url.endsWith('/v1/vision/detection') && item.fields.min_confidence === '0.8',
  );
  assert.ok(upload, 'the camera threshold is sent');
  assert.equal(text(world, `${ID.front}:objects`), 'Person ×3');
  assert.equal(last(world, `${ID.front}:count-truck`), 0);
});

test('every label (*): any object above the threshold, no counter', async (t) => {
  const world = await createWorld({ config: { ...BASE_CONFIG, camera_2_labels: '*' } });
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(text(world, `${ID.garden}:objects`), 'Car ×3, Truck');
});

test('a regular analysis skips a camera analyzed on demand less than half an interval ago', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.clock.advance(60_000);
  await world.fake.sceneAction('analyze', { camera: ID.front });
  const uploads = world.server.calls('/v1/vision/detection');
  world.clock.advance(10_000);
  await world.monitor.tick();
  assert.equal(world.server.calls('/v1/vision/detection'), uploads + 1, 'the garden only');
});

test('the scene action analyzes now and returns outputs, without firing an event', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.scene('garden', 'street');
  const ack = await world.fake.sceneAction('analyze', { camera: ID.garden });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, {
    detected: true,
    objects: 'Car ×5, Person ×5',
    count: 10,
    persons: 5,
    confidence: 91,
    faces: '',
    known_face: false,
  });
  assert.deepEqual(world.fake.sceneEvents, []);
  const missing = await world.fake.sceneAction('analyze', {});
  assert.equal(missing.success, false);
  assert.match(missing.error.fr, /Choisissez une caméra/);
});

test('server down: the status turns red, comes back by itself; actions fail in red', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.down = true;
  const ack = await world.fake.sceneAction('analyze', { camera: ID.front });
  assert.equal(ack.success, false);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /ne répond pas/);
  assert.equal(world.fake.transports.at(-1).device_external_id, ID.server);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  const check = await world.fake.action('check', {});
  assert.equal(check.success, false);
  world.server.down = false;
  await world.monitor.housekeeping();
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('no object detection module running: said in the status', async (t) => {
  const server = new FakeCpai();
  server.detectionRunning = false;
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /no object detection module/);
  server.detectionRunning = true;
  await world.monitor.housekeeping();
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('no address: the status asks for one, nothing is published', async (t) => {
  const world = await createWorld({ config: { language: 'en' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /Saisissez l'adresse/);
  assert.deepEqual(world.fake.discoveredDevices, []);
});

test('a configuration change re-publishes the devices; face recognition adds its feature', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  await world.fake.configUpdated({ ...FACES, camera_2_labels: 'car' });
  const garden = world.fake.discoveredDevices.find((device) => device.external_id === ID.garden);
  assert.deepEqual(
    garden.features.map((item) => item.external_id.split(':').pop()),
    ['image', 'object', 'objects', 'face', 'count-car'],
  );
});

test('the image Gladys asks for: the last one when fresh, else a new analysis', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const uploads = world.server.calls('/v1/vision/detection');
  const fresh = await world.fake.getImage({ external_id: ID.front });
  assert.equal(fresh.success, true);
  assert.match(fresh.data.image, /^image\/jpg;base64,/);
  assert.equal(world.server.calls('/v1/vision/detection'), uploads);
  world.clock.advance(120_000);
  await world.fake.getImage({ external_id: ID.front });
  assert.equal(world.server.calls('/v1/vision/detection'), uploads + 1);
});

test('the widget: valid content, faces, the button hidden on demand, analyze now', async (t) => {
  const world = await createWorld({ config: FACES });
  t.after(() => world.app.stop());
  await createAll(world);
  const pick = await world.fake.widgetGet('camera', { settings: {}, language: 'fr' });
  assert.equal(pick.success, true);
  assert.match(pick.data.content.components[0].text, /Choisissez une caméra/);

  const got = await world.fake.widgetGet('camera', {
    settings: { camera: ID.front },
    language: 'de',
  });
  assert.equal(got.success, true);
  const content = got.data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  const types = content.components.map((item) => item.type);
  assert.deepEqual(types, ['text', 'image', 'status', 'button']);
  const status = content.components[2].items;
  assert.equal(status[0].value, 'Auto ×5, Person ×5');
  assert.deepEqual(
    status.find((item) => item.label === 'Gesichter'),
    { label: 'Gesichter', icon: 'user-check', value: 'Keine', color: 'neutral' },
  );
  const image = await world.fake.widgetGetImage(content.components[1].key);
  assert.equal(image.success, true);

  const hidden = await world.fake.widgetGet('camera', {
    settings: { camera: ID.front, hide_button: true },
    language: 'en',
  });
  assert.ok(!hidden.data.content.components.some((item) => item.type === 'button'));

  const run = await world.fake.widgetAction(
    'camera',
    'analyze_1',
    {},
    { settings: { camera: ID.front } },
  );
  assert.equal(run.success, true);
  assert.equal(run.data.message.fr, 'Front door: Voiture ×5, Personne ×5 (91 %) · Aucun');
  world.server.cameras.get('front').down = true;
  const failed = await world.fake.widgetAction(
    'camera',
    'analyze_1',
    {},
    { settings: { camera: ID.front } },
  );
  assert.equal(failed.success, false);
  assert.ok(failed.error.fr);
});

test('the widget shows the name given in Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const device = world.fake.devices.find((item) => item.external_id === ID.front);
  await world.fake.deviceUpdated({ ...device, name: 'Entrée' });
  const got = await world.fake.widgetGet('camera', {
    settings: { camera: ID.front },
    language: 'fr',
  });
  assert.equal(got.data.content.components[1].alt, 'Entrée');
});

test('the heartbeat re-sends unchanged states after 12 hours', async (t) => {
  const world = await createWorld({ config: { ...BASE_CONFIG, interval: '0' } });
  t.after(() => world.app.stop());
  await createAll(world);
  // The first housekeeping publishes the mean detection time.
  await world.monitor.housekeeping();
  const count = world.fake.states.length;
  await world.monitor.housekeeping();
  assert.equal(world.fake.states.length, count);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 13 * 60 * 60 * 1000 });
  await world.monitor.housekeeping();
  assert.ok(world.fake.states.length > count);
});

test('cameras missed at start (server not ready) are analyzed at the next housekeeping', async (t) => {
  const server = new FakeCpai();
  server.down = true;
  const created = (await createWorld()).fake.discoveredDevices;
  const world = await createWorld({ server, created });
  t.after(() => world.app.stop());
  assert.equal(server.calls('/v1/vision/detection'), 0);
  server.down = false;
  await world.monitor.housekeeping();
  assert.equal(text(world, `${ID.garden}:objects`), 'Car ×3');
});
