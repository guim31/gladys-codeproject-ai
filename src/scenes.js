// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// `analyze`: analyze one camera now, e.g. when a door opens or the alarm goes
// off, and hand what CodeProject.AI saw to the next actions of the scene (a
// condition on `persons` or `known_face`, the objects in a message). The
// camera image is updated too, so the core's "Send a camera image" action
// that follows sends the picture with its boxes. No scene event is fired from
// here (no loop).
// -----------------------------------------------------------------------------

async function analyze(monitor, { fields }) {
  const camera = monitor.require(fields?.camera);
  const summary = await monitor.analyze(camera, { events: false });
  return {
    detected: summary.total > 0,
    objects: summary.text,
    count: summary.total,
    // Every person above the threshold, even when "person" is not a searched label.
    persons: camera.detections.filter(
      (item) => item.label === 'person' && item.confidence >= camera.confidence,
    ).length,
    confidence: summary.confidence,
    // Face recognition off, or no face module: no face, nobody known.
    faces: monitor.facesIn(camera, monitor.config.language) ?? '',
    // camera.faces is this analysis's (null when not read): never an old face.
    known_face: (camera.faces ?? []).some((face) => face.name),
  };
}

export const SCENE_ACTIONS = { analyze };
