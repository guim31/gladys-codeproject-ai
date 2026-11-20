# CodeProject.AI

Brings the **local object detection and face recognition** of
[CodeProject.AI Server](https://www.codeproject.com/ai) to the images of your cameras: Gladys knows
whether a person, a car, a dog… is in view, how many, who it is when you registered their face, and
shows the picture with the boxes drawn. Everything stays at home: no cloud, no account.
CodeProject.AI analyzes one picture at a time; it is not a video recorder (see Frigate or Viseron for
that).

Tested against a real CodeProject.AI Server in Docker (`codeproject/ai-server` 2.9.7, CPU, Object
Detection YOLOv5 6.2 and Face Processing modules) with free photos (a street with people and cars, a
car, a portrait), not yet with real cameras in service: feedback welcome on
[GitHub](https://github.com/guim31/gladys-codeproject-ai/issues) or on the Gladys forum.

## What you need

- Gladys 5.1 or later.
- A CodeProject.AI Server (Docker image `codeproject/ai-server`, or the Windows / Linux installer),
  reachable from Gladys on its port (32168 by default), with an **object detection** module started
  (Object Detection YOLOv5 6.2 is installed by default). For faces, the **Face Processing** module.
- For each camera, the address of a **JPEG snapshot** (most IP cameras have one, e.g.
  `http://user:password@192.168.1.30/snapshot.jpg`; Frigate, go2rtc, Shinobi, Blue Iris… give one for
  each camera). RTSP streams are not read: the integration would need ffmpeg.

An integration cannot read the image of a camera already in Gladys (no such access for external
integrations): give the camera's own snapshot address.

## Installation

1. Start CodeProject.AI, for example:
   `docker run -d --restart unless-stopped -p 32168:32168 codeproject/ai-server`.
2. In Gladys, **Integrations → Install from GitHub**, address
   `https://github.com/guim31/gladys-codeproject-ai`.
3. In the configuration, fill in **CodeProject.AI address**, then for each camera (up to four) a
   **Name** and an **Image address**.
4. Run the **Check the connection** action: it lists the modules running and analyzes each camera
   once.
5. Open the **Discovery** tab and add the devices: one per camera, and one for the server.

Settings:

- **Objects to look for**: object labels in English, separated by commas: `person`, `car`, `truck`,
  `bicycle`, `motorcycle`, `cat`, `dog`, `bird`… (the 80 COCO labels of the default models). `*`
  keeps every label. Each camera can have its own list in **Objects (optional)**.
- **Minimum confidence**: detections below it are ignored. A camera can have its own in
  **Confidence in % (optional)**.
- **Analysis interval**: how often each added camera is analyzed, one after the other. **On demand
  only** analyzes nothing by itself (scene action, widget button, image asked by Gladys).
- **Face recognition**: with a person in view, also asks the Face Processing module who it is. Adds a
  **Recognized face** feature to each camera (open the Discovery tab again and update the devices).
- **Language of the names**: feature names, objects and scene texts.

**CPU load**: each analysis uploads a picture and runs the model on the CodeProject.AI machine (about
0.7 s on a CPU for YOLOv5 6.2, plus 0.5 s for the faces when a person is in view). With four cameras
every 10 seconds, a small machine is busy all the time; 1 minute is a sensible start. Nothing is sent
outside your network.

## Registering faces

Face recognition knows only the faces registered on your server. With the **Register a face**
action: stand alone facing an added camera, close enough, choose the camera, type the name, and run.
The face of the current picture is saved under that name on the CodeProject.AI server (not in Gladys).
Register a person several times (different light, angles) to make recognition more reliable.
**Check the connection** lists the names registered; **Delete a face** forgets every picture of a
name.

## The Gladys devices

One device per camera, with:

- **Image**: the last analyzed picture, with the boxes drawn (red: person, amber: other objects,
  green: recognized face, blue: unknown face), shrunk to fit Gladys.
- **Object detected**: one of the searched objects is in view (Yes/No).
- **Objects detected**: what is in view, e.g. "Person ×2, Car", or "None".
- **Recognized face** (face recognition on): the names recognized, "Unknown" for a stranger, or
  "None".
- One counter per searched label, e.g. **Person (count)**, **Car (count)** (not with `*`).

The badge of the device turns to "unreachable" when the camera image cannot be read.

And one device for the server, **CodeProject.AI server**:

- **Active modules**: the modules running, e.g. "Face Processing, Object Detection (YOLOv5 6.2)".
- **Detection time**: the mean time of the detections, in milliseconds, over the last minute.

Its badge turns to "unreachable" when the server does not answer. The date of each value in Gladys
tells when it last changed: the time of the last detection.

## Dashboard widget

**CodeProject.AI camera**: the analyzed image, the objects found, the best confidence, the faces
(face recognition on), the count of each searched label, when the analysis ran, and an **Analyze
now** button (the **Hide the Analyze button** setting hides it).

## Scenes

### Triggers

- **Object detected by CodeProject.AI**: an object appears in a regular analysis (it was absent from
  the previous one), on one camera or any. Filter on the objects. Variables: camera, object, count,
  confidence. One event when the object appears, not one per analysis. What is already in view when
  the device is added, after a restart or a change of settings does not count. The filter lists the
  common objects: for another label, leave it empty.
- **Face seen by CodeProject.AI**: a face appears in a regular analysis (face recognition on). Filter:
  known (registered) or unknown. Variables: camera, name ("Unknown" for a stranger), confidence. One
  event per person appearing.
- **Camera image not read**: the picture of a camera could not be read (the first failure in a row).

Triggers come from the regular analyses only: with **On demand only**, they never fire.

### Actions

- **Analyze a camera with CodeProject.AI**: analyzes the camera now and updates its image. Outputs:
  object detected, objects detected, number of objects, number of persons, best confidence, faces
  seen, known face. It fires no trigger.

### Scene ideas

- When the front door opens, **Analyze a camera with CodeProject.AI**, then if the number of persons
  is above 0, the core's "Send a camera image" action sends you the picture with its boxes.
- **Face seen by CodeProject.AI** (unknown, entrance camera) while the alarm is on → notification.
- **Face seen by CodeProject.AI** (known) at the door → message "Welcome home, {name}".
- A car in the driveway at night → turn on the outdoor light.

## Troubleshooting

- **CodeProject.AI does not answer**: check the address and port (32168), and that the server runs
  (its dashboard opens at `http://<server>:32168`).
- **No object detection module**: open the CodeProject.AI dashboard, Install Modules tab, and start
  (or install) Object Detection (YOLOv5 6.2, YOLOv8, Coral…).
- **No face module**: install and start Face Processing in the same dashboard.
- **Image not read**: open the camera address in a browser from the Gladys machine. It must give a
  JPEG picture, not a page. Digest authentication is not supported: use an address with Basic
  authentication, or the snapshot URL of Frigate or go2rtc.
- **Nothing is detected**: lower **Minimum confidence**, or try a larger model in the CodeProject.AI
  dashboard.
- **A registered face is not recognized**: register it again from the camera that sees it, in its
  usual light.
- Detailed logs: `LOG_LEVEL=debug`.

## Limits

- Four cameras at most, and eight counted labels per camera.
- The camera address, password included, is stored in the integration configuration and visible
  there to the Gladys administrators: prefer a camera user that can only view.
- No video: one picture per analysis; an object passing between two analyses is missed.
- No RTSP stream, no license plate reading, no custom models in this version.
- Faces are kept on the CodeProject.AI server (**Delete a face** forgets one); Gladys keeps no face
  picture.
- Camera images go to Gladys at most every 5 seconds per camera.
- Not affiliated with CodeProject. Developed without real cameras: feedback welcome.
