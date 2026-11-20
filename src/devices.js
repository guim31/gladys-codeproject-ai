// -----------------------------------------------------------------------------
// What Gladys gets: one device per camera slot, with
//   - `image` (`camera/image`): the last analyzed picture, the boxes
//     CodeProject.AI found drawn on it;
//   - `object` (`motion-sensor/binary`): one of the searched objects is in
//     the picture (1 = detected, like every Gladys detector);
//   - `objects` (`text/text`): what is in the picture ("Person ×2, Car"), or
//     "None";
//   - `count-<label>` (`counter-sensor/integer`, 0 to 100): how many of each
//     searched label, when the camera searches a list of labels (not `*`);
//   - `face` (`text/text`, face recognition on): the names of the faces
//     recognized in the picture, "Unknown" for a stranger, else "None".
// And one device for the server: the modules it runs (`modules`, text) and
// the time of its last detection (`inference`, `duration/integer` in ms).
// Feature keys are forever: they are part of the external ids.
// -----------------------------------------------------------------------------

import { ALL_LABELS } from './config.js';

export const DEVICE_TYPE = 'camera';
export const SERVER_TYPE = 'server';

export const FEATURE_KEYS = {
  IMAGE: 'image',
  OBJECT: 'object',
  OBJECTS: 'objects',
  FACE: 'face',
  MODULES: 'modules',
  INFERENCE: 'inference',
};

// Bounds of the inference time (ms): beyond, the detection timed out anyway.
export const MAX_INFERENCE_MS = 60_000;

export const COUNT_PREFIX = 'count-';
// Bounds of a count feature: more is shown as 100.
export const MAX_COUNT = 100;

// Feature names, frozen when the user adds the device.
export const NAMES = {
  en: {
    image: 'Image',
    object: 'Object detected',
    objects: 'Objects detected',
    count: (label) => `${label} (count)`,
    none: 'None',
    face: 'Recognized face',
    unknownFace: 'Unknown',
    server: 'CodeProject.AI server',
    modules: 'Active modules',
    inference: 'Detection time',
  },
  fr: {
    image: 'Image',
    object: 'Objet détecté',
    objects: 'Objets détectés',
    count: (label) => `${label} (nombre)`,
    none: 'Aucun',
    face: 'Visage reconnu',
    unknownFace: 'Inconnu',
    server: 'Serveur CodeProject.AI',
    modules: 'Modules actifs',
    inference: 'Durée de détection',
  },
  de: {
    image: 'Bild',
    object: 'Objekt erkannt',
    objects: 'Erkannte Objekte',
    count: (label) => `${label} (Anzahl)`,
    none: 'Keine',
    face: 'Erkanntes Gesicht',
    unknownFace: 'Unbekannt',
    server: 'CodeProject.AI-Server',
    modules: 'Aktive Module',
    inference: 'Erkennungsdauer',
  },
  es: {
    image: 'Imagen',
    object: 'Objeto detectado',
    objects: 'Objetos detectados',
    count: (label) => `${label} (número)`,
    none: 'Ninguno',
    face: 'Rostro reconocido',
    unknownFace: 'Desconocido',
    server: 'Servidor CodeProject.AI',
    modules: 'Módulos activos',
    inference: 'Duración de la detección',
  },
};

// The COCO labels of the CodeProject.AI models people watch for most, named in each
// language; any other label keeps the detector's own word.
export const LABELS = {
  person: { en: 'Person', fr: 'Personne', de: 'Person', es: 'Persona' },
  car: { en: 'Car', fr: 'Voiture', de: 'Auto', es: 'Coche' },
  truck: { en: 'Truck', fr: 'Camion', de: 'Lkw', es: 'Camión' },
  bus: { en: 'Bus', fr: 'Bus', de: 'Bus', es: 'Autobús' },
  bicycle: { en: 'Bicycle', fr: 'Vélo', de: 'Fahrrad', es: 'Bicicleta' },
  motorcycle: { en: 'Motorcycle', fr: 'Moto', de: 'Motorrad', es: 'Moto' },
  cat: { en: 'Cat', fr: 'Chat', de: 'Katze', es: 'Gato' },
  dog: { en: 'Dog', fr: 'Chien', de: 'Hund', es: 'Perro' },
  bird: { en: 'Bird', fr: 'Oiseau', de: 'Vogel', es: 'Pájaro' },
  horse: { en: 'Horse', fr: 'Cheval', de: 'Pferd', es: 'Caballo' },
  backpack: { en: 'Backpack', fr: 'Sac à dos', de: 'Rucksack', es: 'Mochila' },
  handbag: { en: 'Handbag', fr: 'Sac à main', de: 'Handtasche', es: 'Bolso' },
  suitcase: { en: 'Suitcase', fr: 'Valise', de: 'Koffer', es: 'Maleta' },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

export function labelName(label, language) {
  const known = LABELS[label];
  if (known) {
    return known[language] ?? known.en;
  }
  const text = String(label).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A label as a feature key: lower case, `[a-z0-9_]` ("traffic light" → `count-traffic_light`). */
export const countKey = (label) =>
  `${COUNT_PREFIX}${String(label)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')}`;

/** The labels that get a count feature: the searched list, unless it is `*`. */
export const countedLabels = (camera) => (camera.labels.includes(ALL_LABELS) ? [] : camera.labels);

/** The ids of one camera: its slot number, the one stable thing about it. */
export function deviceIds(gladys, slot) {
  return gladys.externalIds(DEVICE_TYPE, String(slot));
}

/** The slot behind a device external id (`…:camera:2`), or null. */
export function slotOf(externalId) {
  const match = /:(\d+)$/.exec(String(externalId ?? ''));
  return match ? Number(match[1]) : null;
}

export function featureSpecs(camera, language, { faces = false } = {}) {
  const names = namesFor(language);
  const specs = [
    {
      key: FEATURE_KEYS.IMAGE,
      category: 'camera',
      type: 'image',
      name: names.image,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      key: FEATURE_KEYS.OBJECT,
      category: 'motion-sensor',
      type: 'binary',
      name: names.object,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: true,
      keep_history: true,
    },
    {
      key: FEATURE_KEYS.OBJECTS,
      category: 'text',
      type: 'text',
      name: names.objects,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: true,
      keep_history: true,
    },
  ];
  if (faces) {
    specs.push({
      key: FEATURE_KEYS.FACE,
      category: 'text',
      type: 'text',
      name: names.face,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: true,
      keep_history: true,
    });
  }
  const seen = new Set();
  for (const label of countedLabels(camera)) {
    const key = countKey(label);
    if (seen.has(key)) {
      continue; // "teddy bear" and "teddy_bear": one feature
    }
    seen.add(key);
    specs.push({
      key,
      category: 'counter-sensor',
      type: 'integer',
      name: names.count(labelName(label, language)).slice(0, 40),
      min: 0,
      max: MAX_COUNT,
      read_only: true,
      has_feedback: true,
      keep_history: true,
    });
  }
  return specs;
}

export function buildDevice(gladys, camera, language, options = {}) {
  const ids = deviceIds(gladys, camera.slot);
  return {
    name: camera.name,
    external_id: ids.device,
    model: 'CodeProject.AI',
    // The analyses run on the integration's own timer (the interval chosen
    // in the configuration): the Gladys scheduler has no use here.
    should_poll: false,
    params: [{ name: 'CPAI_CAMERA_SLOT', value: String(camera.slot) }],
    features: featureSpecs(camera, language, options).map(({ key, ...spec }) => ({
      ...spec,
      external_id: ids.feature(key),
    })),
  };
}

/** The ids of the server device: one server per integration. */
export function serverIds(gladys) {
  return gladys.externalIds(SERVER_TYPE, 'server');
}

export function buildServer(gladys, language, version = '') {
  const ids = serverIds(gladys);
  const names = namesFor(language);
  return {
    name: names.server,
    external_id: ids.device,
    model: version ? `CodeProject.AI Server ${version}` : 'CodeProject.AI Server',
    should_poll: false,
    params: [],
    features: [
      {
        external_id: ids.feature(FEATURE_KEYS.MODULES),
        category: 'text',
        type: 'text',
        name: names.modules,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: true,
        keep_history: false,
      },
      {
        external_id: ids.feature(FEATURE_KEYS.INFERENCE),
        category: 'duration',
        type: 'integer',
        unit: 'milliseconds',
        name: names.inference,
        min: 0,
        max: MAX_INFERENCE_MS,
        read_only: true,
        has_feedback: true,
        keep_history: true,
      },
    ],
  };
}

/**
 * The faces of a picture as text: the names recognized, then "Unknown" (×n)
 * for the strangers, or "None".
 * @param {Array<{ name: string|null }>} faces
 */
export function facesText(faces, language) {
  const names = namesFor(language);
  const known = [...new Set(faces.filter((face) => face.name).map((face) => face.name))];
  const strangers = faces.filter((face) => !face.name).length;
  const parts = [...known];
  if (strangers > 0) {
    parts.push(strangers > 1 ? `${names.unknownFace} ×${strangers}` : names.unknownFace);
  }
  const text = parts.length ? parts.join(', ') : names.none;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * What a detection list means for one camera: the counts by searched label,
 * the best confidence, the text of the `objects` feature.
 * @param {Array<{ label: string, confidence: number }>} detections in
 *   percent, as the monitor keeps them
 */
export function summarize(detections, camera, language) {
  const counts = {};
  const best = {};
  for (const item of detections) {
    if (!camera.labels.includes(ALL_LABELS) && !camera.labels.includes(item.label)) {
      continue; // not a searched label
    }
    if (item.confidence < camera.confidence) {
      continue;
    }
    counts[item.label] = (counts[item.label] ?? 0) + 1;
    best[item.label] = Math.max(best[item.label] ?? 0, item.confidence);
  }
  const labels = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const text = labels.length
    ? labels
        .map((label) => {
          const name = labelName(label, language);
          return counts[label] > 1 ? `${name} ×${counts[label]}` : name;
        })
        .join(', ')
    : namesFor(language).none;
  return {
    counts,
    labels,
    // Best confidence by label, rounded to the percent.
    best: Object.fromEntries(labels.map((label) => [label, Math.round(best[label])])),
    total: labels.reduce((sum, label) => sum + counts[label], 0),
    confidence: Math.round(Math.max(0, ...Object.values(best))),
    text: text.length > 200 ? `${text.slice(0, 199)}…` : text,
  };
}
