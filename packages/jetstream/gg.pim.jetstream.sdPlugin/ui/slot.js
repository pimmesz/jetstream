'use strict';

const byId = (id) => document.getElementById(id);
const basicKinds = ['empty', 'app', 'url', 'project'];
const names = {
  run: 'Run command', stopall: 'Stop all', build: 'Build version', fleet: 'Fleet',
  volup: 'Volume up', voldown: 'Volume down', volmute: 'Mute output',
  usage: 'Usage', attention: 'Attention', chat: 'Chat', logo: 'Jetstream logo',
};
let ws;
let uuid;
let actionId;
let settings = {};
let hasLoaded = false;
let isReadOnly = true;
let pending;

function status(text, isError = false) {
  byId('status').textContent = text;
  byId('status').dataset.error = String(isError);
}

// Point a screen reader and the keyboard at the input an error is about; clear every other mark.
function markInvalid(fieldId) {
  for (const id of ['target', 'color']) {
    if (id === fieldId) {
      byId(id).setAttribute('aria-invalid', 'true');
      byId(id).setAttribute('aria-errormessage', 'status');
    } else {
      byId(id).removeAttribute('aria-invalid');
      byId(id).removeAttribute('aria-errormessage');
    }
  }
  if (fieldId) byId(fieldId).focus();
}

function controls() {
  const isConnected = ws?.readyState === WebSocket.OPEN;
  byId('fields').disabled = !isConnected || !hasLoaded || isReadOnly || !!pending;
  byId('save').disabled = !isConnected || !hasLoaded || isReadOnly || !!pending;
  byId('cancel').disabled = !isConnected || !!pending;
}

function showKind() {
  const kind = byId('kind').value;
  const hasTarget = ['app', 'url', 'project', 'run'].includes(kind);
  byId('targetRow').hidden = !hasTarget;
  byId('cosmetics').hidden = kind === 'empty';
  byId('appIconHint').hidden = kind !== 'app';
  byId('targetLabel').textContent = kind === 'project' ? 'Project path' : kind === 'app' ? 'App or folder path' : kind === 'url' ? 'URL' : 'Command';
  byId('target').placeholder = kind === 'project' ? '/Users/you/projects/repo' : kind === 'app' ? '/Applications/Telegram.app' : 'https://example.com';
  byId('target').required = hasTarget && !isReadOnly;
  byId('kindHint').textContent = isReadOnly
    ? "You can't change this key here. To change it, run jetstream chat in Terminal."
    : kind === 'project'
      ? 'Shows live project status. Press to open the folder; hold while working to stop the current turn.'
      : kind === 'empty'
        ? 'Save to make this key blank.'
        : kind === 'app'
          ? 'Enter the full path, such as /Applications/Telegram.app. A script or program only runs when run keys are turned on.'
          : 'Changes apply only when you choose Save. Leave Label blank for the default.';
}

function populate(next) {
  settings = next;
  const kind = settings.kind ?? 'empty';
  byId('currentKind')?.remove();
  if (!basicKinds.includes(kind)) {
    const option = document.createElement('option');
    option.id = 'currentKind';
    option.value = kind;
    option.textContent = Object.hasOwn(names, kind) ? names[kind] : 'Unsupported slot';
    if (kind === 'usage') option.textContent += settings.provider === 'codex' ? ' (Codex)' : ' (Claude)';
    byId('kind').append(option);
  }
  isReadOnly = ['run', 'stopall'].includes(kind) || (!basicKinds.includes(kind) && !Object.hasOwn(names, kind));
  byId('kind').value = kind;
  byId('target').value = kind === 'app' ? settings.app ?? '' : kind === 'url' ? settings.url ?? '' : kind === 'project' ? settings.path ?? '' : kind === 'run' ? [settings.command, ...(settings.args ?? [])].join(' ') : '';
  byId('label').value = settings.label ?? '';
  byId('color').value = settings.color ?? '';
  hasLoaded = true;
  showKind();
  controls();
}

function request(slot, edit) {
  if (pending || ws?.readyState !== WebSocket.OPEN) return;
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => {
    pending = undefined;
    hasLoaded = false;
    status('No answer from Jetstream. Choose Cancel to load the key again, then check it.', true);
    controls();
  }, 8000);
  pending = { requestId, slot, timer };
  controls();
  status(slot === 'save' ? 'Saving...' : 'Loading...');
  ws.send(JSON.stringify({
    event: 'sendToPlugin', action: 'gg.pim.jetstream.slot', context: uuid,
    payload: { slot, requestId, ...(slot === 'save' ? { expect: settings, edit } : {}) },
  }));
}

// Stream Deck calls this global after loading the inspector.
function connectElgatoStreamDeckSocket(port, inUUID, registerEvent, info, actionInfo) {
  uuid = inUUID;
  actionId = JSON.parse(actionInfo).context;
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: registerEvent, uuid }));
    request('read');
  };
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const result = message.payload;
    if (message.event !== 'sendToPropertyInspector' || result?.slot !== 'result' ||
        result.actionId !== actionId || result.requestId !== pending?.requestId) return;
    const { slot, timer } = pending;
    clearTimeout(timer);
    pending = undefined;
    if (result.ok) {
      populate(result.settings);
      markInvalid(undefined);
      status(slot === 'save' ? 'Saved.' : 'Ready. Edits are saved only when you choose Save.');
    } else {
      status(result.error, true);
      controls(); // a disabled input cannot take focus
      markInvalid(result.field);
    }
  };
  const disconnected = () => {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
    hasLoaded = false;
    status('Lost the connection to Jetstream. Click another key, then click this key again.', true);
    controls();
  };
  ws.onclose = disconnected;
  ws.onerror = disconnected;
}

byId('kind').addEventListener('change', () => {
  byId('target').value = byId('kind').value === settings.kind
    ? settings.app ?? settings.url ?? settings.path ?? '' : '';
  showKind();
});
byId('slotForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!hasLoaded || isReadOnly) return;
  request('save', {
    kind: byId('kind').value, target: byId('target').value,
    label: byId('label').value, color: byId('color').value,
  });
});
byId('cancel').addEventListener('click', () => request('read'));
