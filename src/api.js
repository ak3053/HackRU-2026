import { db } from './db';

// The triage server (main.py). Defaults to this page's own address: the Vite dev server
// forwards /api and /ws to main.py (see vite.config.js), so phones need only one address.
const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

// A record has been through Laya once it carries per-category scores
export const isTriaged = (record) => Boolean(record && record.category_scores);

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, { signal: AbortSignal.timeout(15000), ...options });
  if (!response.ok) throw new Error(`Triage server returned ${response.status} for ${path}`);
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

// Record a resolution in the server database
export function resolveOnServer(id) {
  return request(`/api/incidents/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
}

// Store an incoming record without losing a triage or a resolution this device already has
export async function mergeRecord(record) {
  const existing = await db.sosRequests.get(record.id);
  if (!existing) {
    await db.sosRequests.put(record);
    return;
  }
  const resolved = existing.status === 'Resolved' || record.status === 'Resolved';
  const status = resolved ? 'Resolved' : existing.status;
  if (isTriaged(record) && !isTriaged(existing)) {
    await db.sosRequests.put({ ...record, status });
  } else if (status !== existing.status) {
    await db.sosRequests.update(record.id, { status });
  }
}

// Bring this device and the server database into line. Runs whenever the server becomes reachable.
// onTriaged is called with each record the server triaged on this pass.
let syncing = false;
export async function syncWithServer(onTriaged) {
  if (syncing) return;
  syncing = true;
  try {
    // 1. Past incidents the server holds, with their resolved state
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
          if (onTriaged) onTriaged({ ...triaged, status: local.status });
        }
        // 3. Resolutions made while offline
        if (local.status === 'Resolved' && serverStatus.has(local.id) && serverStatus.get(local.id) !== 'Resolved') {
          await resolveOnServer(local.id);
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
      // Either a status change ({type: 'status', id, status}) or a freshly triaged record
      const data = JSON.parse(event.data);
      const store = data.type === 'status'
        ? db.sosRequests.update(data.id, { status: data.status })
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
