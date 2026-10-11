import { db } from './db';

// The triage server (main.py). Defaults to this page's own address: the Vite dev server
// forwards /api and /ws to main.py (see vite.config.js), so phones need only one address.
const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

// An incident moves between these, in any direction
export const STATUSES = ['Pending', 'In Progress', 'Resolved'];

// A record has been through Laya once it carries per-category scores
export const isTriaged = (record) => Boolean(record && record.category_scores);

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, { signal: AbortSignal.timeout(15000), ...options });
  if (!response.ok) {
    const detail = await response.json().then((body) => body.detail, () => null);
    throw new Error(typeof detail === 'string' ? detail : `Triage server returned ${response.status} for ${path}`);
  }
  return response.json();
}

// Send an SOS record to the server; resolves to the record with Laya's triage merged in
export async function submitSos(record) {
  const body = await request('/api/submit_sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record)
  });
  return body.triage;
}

// Record a status change in the server database
export function setStatusOnServer(id, status) {
  return request(`/api/incidents/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
}

// Turn a voice recording into text (ElevenLabs, via the server)
export async function transcribeAudio(blob) {
  const body = await request('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    signal: AbortSignal.timeout(60000)
  });
  return body.text;
}

// When a record's status was last changed; records that never changed status count as oldest
const statusTime = (record) => Date.parse(record.status_updated_at || '') || 0;

// Apply a status change from elsewhere (mesh or server) unless this device has a newer one
export async function applyStatus(id, status, statusUpdatedAt) {
  const existing = await db.sosRequests.get(id);
  if (!existing) return;
  const incoming = { status, status_updated_at: statusUpdatedAt };
  if (statusTime(incoming) >= statusTime(existing)) {
    await db.sosRequests.update(id, incoming);
  }
}

// Store an incoming record. Triage is never lost, and the most recent status change wins.
export async function mergeRecord(record) {
  const existing = await db.sosRequests.get(record.id);
  if (!existing) {
    await db.sosRequests.put(record);
    return;
  }
  const latest = statusTime(record) > statusTime(existing) ? record : existing;
  const status = { status: latest.status, status_updated_at: latest.status_updated_at };
  if (isTriaged(record) && !isTriaged(existing)) {
    await db.sosRequests.put({ ...record, ...status });
  } else if (latest === record && record.status !== existing.status) {
    await db.sosRequests.update(record.id, status);
  }
}

// Bring this device and the server database into line. Runs whenever the server becomes reachable.
// onTriaged is called with each record the server triaged on this pass.
let syncing = false;
export async function syncWithServer(onTriaged) {
  if (syncing) return;
  syncing = true;
  try {
    // 1. Past incidents the server holds, with their current status
    const incidents = await request('/api/incidents?limit=500');
    const serverStatus = new Map(incidents.map((incident) => [incident.id, incident.status]));
    for (const incident of incidents) await mergeRecord(incident);

    for (const local of await db.sosRequests.toArray()) {
      try {
        // 2. Untriaged SOS (sent while the server was unreachable): submit on the victim's behalf
        if (!isTriaged(local)) {
          const triaged = await submitSos(local);
          await mergeRecord(triaged);
          serverStatus.set(triaged.id, triaged.status);
          if (onTriaged) onTriaged({ ...triaged, status: local.status, status_updated_at: local.status_updated_at });
        }
        // 3. Status changes made while offline. After the merge above, a local status that
        //    still differs from the server's is the newer one.
        if (serverStatus.has(local.id) && serverStatus.get(local.id) !== local.status) {
          await setStatusOnServer(local.id, local.status);
        }
      } catch (error) {
        console.warn(`Could not sync SOS ${local.id}; will retry:`, error);
      }
    }
  } finally {
    syncing = false;
  }
}

// Live feed from the server; reconnects on drop. Returns a stop function.
export function connectDispatch(onStatusChange) {
  let socket = null;
  let retryTimer = null;
  let stopped = false;

  const open = () => {
    socket = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws/dispatch`);
    socket.onopen = () => onStatusChange && onStatusChange(true);
    socket.onmessage = (event) => {
      // Either a status change ({type: 'status', id, status, status_updated_at}) or a freshly triaged record
      const data = JSON.parse(event.data);
      const store = data.type === 'status'
        ? applyStatus(data.id, data.status, data.status_updated_at)
        : mergeRecord(data);
      store.catch((error) => console.error('Failed to store server update:', error));
    };
    socket.onclose = () => {
      if (onStatusChange) onStatusChange(false);
      if (!stopped) retryTimer = setTimeout(open, 3000);
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    if (socket) socket.close();
  };
}
