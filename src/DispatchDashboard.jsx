import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { initMesh, broadcastSos, broadcastStatusUpdate } from './mesh';
import { connectDispatch, isTriaged, resolveOnServer, syncWithServer } from './api';
import IncidentMap from './IncidentMap';

// Most pressing first: untriaged (severity unknown), then life threats, then by Laya's urgency score
const sortRank = (req) => [
  isTriaged(req) ? 0 : 1,
  req.is_life_threatening ? 1 : 0,
  req.urgency_score || 0
];
const byPriority = (a, b) => {
  const [ra, rb] = [sortRank(a), sortRank(b)];
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return rb[i] - ra[i];
  }
  return 0;
};

export default function DispatchDashboard() {
  const [nodeCount, setNodeCount] = useState(1);
  const [serverOnline, setServerOnline] = useState(false);
  const [view, setView] = useState('active');

  // Fetch all requests and filter out resolved ones
  const requests = useLiveQuery(() => db.sosRequests.toArray(), []) || [];
  const activeRequests = requests.filter(req => req.status !== 'Resolved').sort(byPriority);
  // Resolved incidents, newest first
  const resolvedRequests = requests
    .filter(req => req.status === 'Resolved')
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const visibleRequests = view === 'active' ? activeRequests : resolvedRequests;
  const untriagedCount = requests.filter(req => !isTriaged(req)).length;

  useEffect(() => {
    initMesh((count) => setNodeCount(count));
    // Triaged records pushed by main.py land in the same local table the mesh fills
    return connectDispatch(setServerOnline);
  }, []);

  // Whenever the server is reachable: load past incidents, push offline resolutions, and get
  // any untriaged SOS (including ones that arrive over the mesh later) through Laya
  useEffect(() => {
    if (serverOnline) {
      syncWithServer(broadcastSos).catch((error) => console.warn('Server sync failed:', error));
    }
  }, [serverOnline, untriagedCount]);

  const handleResolve = async (id) => {
    await db.sosRequests.update(id, { status: 'Resolved' });
    broadcastStatusUpdate(id, 'Resolved');
    // Offline or not yet on the server: the next sync records it
    resolveOnServer(id).catch((error) => console.warn(`Resolution of ${id} not yet saved to server:`, error));
  };

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      <div className="bg-white p-4 rounded-lg shadow mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">First Responder Command</h1>
          <p className="text-sm text-gray-500">Live Local Mesh Grid</p>
        </div>
        <div className="flex gap-4">
          <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
            serverOnline ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'
          }`}>
            Triage Server: {serverOnline ? 'Online' : 'Offline'}
          </span>
          <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-semibold">
            Active Nodes: {nodeCount}
          </span>
          <span className="bg-red-100 text-red-800 px-3 py-1 rounded-full text-sm font-semibold">
            Active Incidents: {activeRequests.length}
          </span>
        </div>
      </div>

      <IncidentMap incidents={requests} />

      <div className="flex gap-2 mb-4">
        {[
          { id: 'active', label: `Active (${activeRequests.length})` },
          { id: 'resolved', label: `Resolved (${resolvedRequests.length})` }
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setView(tab.id)}
            aria-pressed={view === tab.id}
            className={`px-4 py-1.5 rounded-md text-sm font-semibold shadow-sm ${
              view === tab.id ? 'bg-gray-800 text-white' : 'bg-white text-gray-700 hover:bg-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {visibleRequests.length === 0 ? (
        <div className="text-center p-12 bg-white rounded-lg shadow text-gray-500">
          {view === 'active'
            ? 'No active emergency requests on the mesh network.'
            : 'No resolved incidents yet.'}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibleRequests.map((req) => (
            <div
              key={req.id}
              className={`p-4 rounded-lg shadow bg-white border-l-4 flex flex-col justify-between ${
                view === 'resolved'
                  ? 'border-gray-400'
                  : req.is_life_threatening ? 'border-red-600' : 'border-yellow-500'
              }`}
            >
              <div>
                <div className="flex justify-between font-bold text-gray-900">
                  <span>
                    {!isTriaged(req)
                      ? 'Awaiting triage'
                      : req.categories.length > 0 ? req.categories.join(' · ') : 'Uncategorized'}
                  </span>
                  <span className="text-sm text-gray-500">{req.phone_number}</span>
                </div>

                {/* Laya's assessment */}
                <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
                  {isTriaged(req) && (
                    <span className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded">
                      Urgency {req.urgency}/4 · {req.urgency_label}
                    </span>
                  )}
                  {req.is_life_threatening && (
                    <span className="bg-red-100 text-red-800 px-2 py-0.5 rounded">
                      Life threat{isTriaged(req) ? ` ${Math.round(req.threat_confidence * 100)}%` : ''}
                    </span>
                  )}
                </div>

                <p className="mt-2 text-gray-800">{req.message}</p>
                
                {/* Location details */}
                <div className="mt-3 p-2 bg-gray-50 rounded text-xs text-gray-600 space-y-1">
                  <p className="font-semibold text-gray-700">📍 {req.address || 'Address pending'}</p>
                  {req.latitude && req.longitude && (
                    <p className="font-mono text-gray-500">GPS: {req.latitude.toFixed(4)}, {req.longitude.toFixed(4)}</p>
                  )}
                </div>

                <div className="mt-2 text-xs text-gray-400">
                  {req.timestamp
                    ? view === 'resolved'
                      ? new Date(req.timestamp).toLocaleString()
                      : new Date(req.timestamp).toLocaleTimeString()
                    : ''}
                </div>
              </div>

              {view === 'resolved' ? (
                <div className="mt-4 w-full bg-gray-100 text-gray-600 py-1.5 px-3 rounded text-sm font-semibold text-center">
                  Resolved
                </div>
              ) : (
                <button
                  onClick={() => handleResolve(req.id)}
                  className="mt-4 w-full bg-green-600 text-white py-1.5 px-3 rounded text-sm font-semibold hover:bg-green-700 transition-colors shadow-sm"
                >
                  Mark as Resolved
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}