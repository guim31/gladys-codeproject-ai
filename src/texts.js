// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, action messages and failures, the "Check the
// connection" report. Four languages, the four of the Gladys interface;
// German says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

/**
 * A failure shown in red by Gladys: the message is the multi-language object
 * (a returned value is shown in green, a thrown one in red).
 */
export class ActionFailure extends Error {
  constructor(text) {
    super(text.en);
    this.name = 'ActionFailure';
    this.message = text;
  }
}

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of your CodeProject.AI server (e.g. 192.168.1.20, port 32168 by default) in the configuration.',
    fr: "Saisissez l'adresse de votre serveur CodeProject.AI (ex. 192.168.1.20, port 32168 par défaut) dans la configuration.",
    de: 'Gib die Adresse deines CodeProject.AI-Servers (z. B. 192.168.1.20, standardmäßig Port 32168) in der Konfiguration ein.',
    es: 'Introduzca la dirección de su servidor CodeProject.AI (p. ej. 192.168.1.20, puerto 32168 por defecto) en la configuración.',
  },
  unreachable: {
    en: 'CodeProject.AI does not answer at this address.',
    fr: 'CodeProject.AI ne répond pas à cette adresse.',
    de: 'CodeProject.AI antwortet unter dieser Adresse nicht.',
    es: 'CodeProject.AI no responde en esta dirección.',
  },
  error: {
    en: 'Something answers, but not like CodeProject.AI: check the address and port, and the logs.',
    fr: "Quelque chose répond, mais pas comme CodeProject.AI : vérifiez l'adresse, le port et les logs.",
    de: 'Etwas antwortet, aber nicht wie CodeProject.AI: Prüfe Adresse, Port und die Protokolle.',
    es: 'Algo responde, pero no como CodeProject.AI: compruebe la dirección, el puerto y los registros.',
  },
  noDetection: {
    en: 'CodeProject.AI runs no object detection module: start one in its dashboard (Install Modules).',
    fr: "CodeProject.AI ne fait tourner aucun module de détection d'objets : démarrez-en un dans son tableau de bord (Install Modules).",
    de: 'CodeProject.AI führt kein Modul zur Objekterkennung aus: Starte eines in seinem Dashboard (Install Modules).',
    es: 'CodeProject.AI no ejecuta ningún módulo de detección de objetos: inicie uno en su panel (Install Modules).',
  },
};

// Failures of an analysis or an action asked by the user or a scene (thrown:
// shown in red).
export const FAILURE = {
  notConfigured: {
    en: 'The CodeProject.AI server is not configured or does not answer.',
    fr: "Le serveur CodeProject.AI n'est pas configuré ou ne répond pas.",
    de: 'Der CodeProject.AI-Server ist nicht konfiguriert oder antwortet nicht.',
    es: 'El servidor CodeProject.AI no está configurado o no responde.',
  },
  pickCamera: {
    en: 'Choose a camera.',
    fr: 'Choisissez une caméra.',
    de: 'Wähle eine Kamera aus.',
    es: 'Elija una cámara.',
  },
  unknownCamera: {
    en: 'This camera is no longer in the CodeProject.AI configuration.',
    fr: "Cette caméra n'est plus dans la configuration CodeProject.AI.",
    de: 'Diese Kamera ist nicht mehr in der CodeProject.AI-Konfiguration.',
    es: 'Esta cámara ya no está en la configuración de CodeProject.AI.',
  },
  camera: {
    en: 'The camera image could not be read: check its address, user and password.',
    fr: "L'image de la caméra n'a pas pu être lue : vérifiez son adresse, l'utilisateur et le mot de passe.",
    de: 'Das Kamerabild konnte nicht gelesen werden: Prüfe Adresse, Benutzer und Passwort.',
    es: 'No se pudo leer la imagen de la cámara: compruebe su dirección, usuario y contraseña.',
  },
  server: {
    en: 'CodeProject.AI did not answer, or not in time: check the server and its logs.',
    fr: "CodeProject.AI n'a pas répondu, ou pas à temps : vérifiez le serveur et ses logs.",
    de: 'CodeProject.AI hat nicht oder nicht rechtzeitig geantwortet: Prüfe den Server und seine Protokolle.',
    es: 'CodeProject.AI no respondió, o no a tiempo: compruebe el servidor y sus registros.',
  },
  pickName: {
    en: 'Enter the name of the person.',
    fr: 'Saisissez le nom de la personne.',
    de: 'Gib den Namen der Person ein.',
    es: 'Introduzca el nombre de la persona.',
  },
  noFaceModule: {
    en: 'CodeProject.AI has no face module: install and start Face Processing in its dashboard.',
    fr: "CodeProject.AI n'a pas de module de visages : installez et démarrez Face Processing dans son tableau de bord.",
    de: 'CodeProject.AI hat kein Gesichtsmodul: Installiere und starte Face Processing in seinem Dashboard.',
    es: 'CodeProject.AI no tiene módulo de rostros: instale e inicie Face Processing en su panel.',
  },
  noFace: {
    en: 'No face found in the camera image: stand facing the camera, close enough, and try again.',
    fr: "Aucun visage trouvé dans l'image de la caméra : placez-vous face à elle, assez près, et réessayez.",
    de: 'Kein Gesicht im Kamerabild gefunden: Stell dich nah genug vor die Kamera und versuche es erneut.',
    es: 'No se encontró ningún rostro en la imagen de la cámara: colóquese frente a ella, lo bastante cerca, e inténtelo de nuevo.',
  },
};

/** The message of a successful analysis ("Front door: Person ×2, Car (87 %)"). */
export function analysisMessage(name, summary, faces) {
  const found = resultText(summary);
  return `${name}: ${faces ? `${found} · ${faces}` : found}`.slice(0, 200);
}

/** What an analysis found, with its best confidence ("Person ×2, Car (87 %)"). */
export const resultText = (summary) =>
  summary.total > 0 ? `${summary.text} (${summary.confidence} %)` : summary.text;

/** The face registered: a success message. */
export function registeredMessage(name, camera) {
  return {
    en: `Face of ${name} registered from ${camera}.`,
    fr: `Visage de ${name} enregistré depuis ${camera}.`,
    de: `Gesicht von ${name} von ${camera} gespeichert.`,
    es: `Rostro de ${name} registrado desde ${camera}.`,
  };
}

/** The face deleted: a success message. */
export function deletedMessage(name) {
  return {
    en: `Face of ${name} deleted.`,
    fr: `Visage de ${name} supprimé.`,
    de: `Gesicht von ${name} gelöscht.`,
    es: `Rostro de ${name} eliminado.`,
  };
}

/** No face registered under this name: the names there are. */
export function unknownFace(name, faces) {
  const list = faces.length ? faces.slice(0, 10).join(', ') : '-';
  return {
    en: `No face registered as "${name}". Faces registered: ${list}.`,
    fr: `Aucun visage enregistré sous « ${name} ». Visages enregistrés : ${list}.`,
    de: `Kein Gesicht als „${name}“ gespeichert. Gespeicherte Gesichter: ${list}.`,
    es: `Ningún rostro registrado como «${name}». Rostros registrados: ${list}.`,
  };
}

const MAX_LISTED = 4;

// The pieces of the "Check the connection" report, one table per language.
export const CHECK_TEXT = {
  en: {
    connected: (url, version) => `CodeProject.AI ${version} answers at ${url}.`,
    modules: (list) => `Modules running: ${list}.`,
    faces: (list) => `Faces registered: ${list}.`,
    noFaceModule: 'Face recognition is on, but no face module answers.',
    camera: (name, text) => `- ${name}: ${text}`,
    failed: 'image not read',
    noCamera: 'No camera configured yet.',
  },
  fr: {
    connected: (url, version) => `CodeProject.AI ${version} répond à ${url}.`,
    modules: (list) => `Modules en marche : ${list}.`,
    faces: (list) => `Visages enregistrés : ${list}.`,
    noFaceModule:
      'La reconnaissance des visages est activée, mais aucun module de visages ne répond.',
    camera: (name, text) => `- ${name} : ${text}`,
    failed: 'image non lue',
    noCamera: 'Aucune caméra configurée pour le moment.',
  },
  de: {
    connected: (url, version) => `CodeProject.AI ${version} antwortet unter ${url}.`,
    modules: (list) => `Laufende Module: ${list}.`,
    faces: (list) => `Gespeicherte Gesichter: ${list}.`,
    noFaceModule: 'Die Gesichtserkennung ist an, aber kein Gesichtsmodul antwortet.',
    camera: (name, text) => `- ${name}: ${text}`,
    failed: 'Bild nicht gelesen',
    noCamera: 'Noch keine Kamera konfiguriert.',
  },
  es: {
    connected: (url, version) => `CodeProject.AI ${version} responde en ${url}.`,
    modules: (list) => `Módulos en marcha: ${list}.`,
    faces: (list) => `Rostros registrados: ${list}.`,
    noFaceModule:
      'El reconocimiento de rostros está activado, pero ningún módulo de rostros responde.',
    camera: (name, text) => `- ${name}: ${text}`,
    failed: 'imagen no leída',
    noCamera: 'Aún no hay ninguna cámara configurada.',
  },
};

/**
 * The report of the "Check the connection" action, in the four languages.
 * @param {{ url: string, version: string, modules: string[], faces: string[]|null,
 *   cameras: Array<{ name: string, summary?: object, failed?: boolean }> }} report
 *   faces: null when face recognition is on and no face module answers,
 *   undefined when it is off
 */
export function checkMessage(report) {
  const message = {};
  for (const [language, text] of Object.entries(CHECK_TEXT)) {
    const lines = [text.connected(report.url, report.version).replace('  ', ' ')];
    if (report.modules.length > 0) {
      lines.push(text.modules(report.modules.join(', ')));
    }
    if (report.faces === null) {
      lines.push(text.noFaceModule);
    } else if (report.faces?.length > 0) {
      lines.push(text.faces(report.faces.slice(0, 10).join(', ')));
    }
    if (report.cameras.length === 0) {
      lines.push(text.noCamera);
    }
    for (const camera of report.cameras.slice(0, MAX_LISTED)) {
      lines.push(
        text.camera(
          camera.name,
          camera.failed ? text.failed : resultText(camera.summary[language]),
        ),
      );
    }
    message[language] = lines.join('\n');
  }
  return message;
}
