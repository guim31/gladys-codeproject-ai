# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local object detection with CodeProject.AI Server on up to four cameras
  (JPEG snapshot URL): one Gladys device per camera with its analyzed image
  (the boxes drawn), "Object detected", "Objects detected" and one counter per
  searched label.
- Face recognition (Face Processing module), on demand in the configuration:
  a "Recognized face" feature, the actions "Register a face" (from the current
  picture of a camera) and "Delete a face".
- A device for the server: the modules running and the detection time.
- Searched labels and minimum confidence, per camera if needed; analysis
  interval from 10 seconds to 1 hour, or on demand only.
- Scene triggers "Object detected by CodeProject.AI" (when an object
  appears), "Face seen by CodeProject.AI" (known or unknown) and "Camera image
  not read"; scene action "Analyze a camera with CodeProject.AI" with its
  outputs (objects, counts, persons, confidence, faces).
- Dashboard widget "CodeProject.AI camera" with an "Analyze now" button.
- "Check the connection" action: the server version, its modules, the faces
  registered, one analysis per camera.
- English, French, German and Spanish.
