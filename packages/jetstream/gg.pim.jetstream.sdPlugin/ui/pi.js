/* Minimal Stream Deck property-inspector bridge: populate the form from the
 * action's settings, persist every change with setSettings (the plugin receives
 * didReceiveSettings and re-renders the key). No frameworks, no network. */
/* eslint-disable no-unused-vars */
'use strict';

let ws = null;
let piUuid = null;

// Stream Deck calls this global when the inspector loads.
function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  piUuid = inUUID;
  let settings = {};
  try {
    settings = JSON.parse(inActionInfo).payload.settings || {};
  } catch (_e) {
    /* fresh key: empty settings */
  }
  for (const field of document.querySelectorAll('[data-setting]')) {
    const value = settings[field.dataset.setting];
    if (typeof value === 'string') field.value = value;
    field.addEventListener('input', save);
    field.addEventListener('change', save);
  }
  ws = new WebSocket(`ws://127.0.0.1:${inPort}`);
  ws.onopen = () => ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }));
}

function save() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = {};
  for (const field of document.querySelectorAll('[data-setting]')) {
    if (field.value.trim() !== '') payload[field.dataset.setting] = field.value;
  }
  ws.send(JSON.stringify({ event: 'setSettings', context: piUuid, payload }));
}
