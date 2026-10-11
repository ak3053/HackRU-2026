import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isTriaged } from './api';

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// Fixed colour per category (never reassigned when a filter hides some). Six hues cannot all be
// told apart by every viewer, so the legend doubles as a filter and each dot opens its details.
const CATEGORY_COLORS = {
  'Medical': '#e87ba4',
  'Fire': '#eb6834',
  'Trapped/Structural': '#eda100',
  'Supply/Ration': '#1baf7a',
  'Flood': '#2a78d6',
  'Natural Disaster': '#008300'
};
const OTHER = 'Uncategorized / untriaged';
const OTHER_COLOR = '#898781';

// One hue, light to dark, for urgency 0-4
const SEVERITY_COLORS = ['#fcd9b6', '#f8a971', '#eb6834', '#b8401a', '#7a2408'];
const SEVERITY_LABELS = ['trivial', 'minor', 'moderate', 'serious', 'critical'];

// Density ramp, sparse to dense: one hue, rising opacity
const DENSITY_STOPS = [
  [0, 'rgba(185, 174, 240, 0)'],
  [0.25, 'rgba(185, 174, 240, 0.55)'],
  [0.6, 'rgba(98, 80, 214, 0.8)'],
  [1, 'rgba(44, 31, 122, 0.92)']
];

const MODES = [
  { id: 'type', label: 'Type' },
  { id: 'severity', label: 'Severity' },
  { id: 'density', label: 'Density' }
];

const BLOB_RADIUS = 38; // px; overlapping blobs build up, so clusters read as denser in every mode
const DOT_RADIUS = 5;
const CANVAS_MARGIN = 200; // px drawn beyond the viewport so short drags do not expose blank edges

const categoryOf = (incident) =>
  isTriaged(incident) && incident.categories.length > 0 && CATEGORY_COLORS[incident.category]
    ? incident.category
    : OTHER;

const hasLocation = (incident) =>
  typeof incident.latitude === 'number' && typeof incident.longitude === 'number';

function colorFor(incident, mode) {
  if (mode === 'severity') {
    return isTriaged(incident) ? SEVERITY_COLORS[incident.urgency] || OTHER_COLOR : OTHER_COLOR;
  }
  return CATEGORY_COLORS[categoryOf(incident)] || OTHER_COLOR;
}

const withAlpha = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

let mapsPromise = null;
function loadGoogleMaps(key) {
  if (!mapsPromise) {
    mapsPromise = new Promise((resolve, reject) => {
      window.__meshGuardianMapsReady = () => resolve(window.google.maps);
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__meshGuardianMapsReady`;
      script.async = true;
      script.onerror = () => {
        mapsPromise = null;
        reject(new Error('Could not load Google Maps. Check the internet connection.'));
      };
      document.head.appendChild(script);
    });
  }
  return mapsPromise;
}

// 256-entry RGBA lookup for the density ramp
function buildDensityPalette() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  DENSITY_STOPS.forEach(([stop, color]) => gradient.addColorStop(stop, color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1, 256);
  return ctx.getImageData(0, 0, 1, 256).data;
}

// Canvas layer drawn over the map. Google's own HeatmapLayer has been retired, and it could
// not colour by type or severity anyway.
function createHeatOverlay(maps, OverlayView) {
  return class HeatOverlay extends OverlayView {
    constructor() {
      super();
      this.canvas = document.createElement('canvas');
      this.canvas.style.position = 'absolute';
      this.canvas.style.pointerEvents = 'none';
      this.incidents = [];
      this.mode = 'type';
      this.palette = buildDensityPalette();
    }

    onAdd() {
      this.getPanes().overlayLayer.appendChild(this.canvas);
    }

    onRemove() {
      this.canvas.remove();
    }

    setData(incidents, mode) {
      this.incidents = incidents;
      this.mode = mode;
      this.draw();
    }

    // Pixel position of an incident relative to the map's top-left corner
    viewportPixel(incident) {
      const projection = this.getProjection();
      const map = this.getMap();
      if (!projection || !map || !map.getCenter()) return null;
      const div = map.getDiv();
      const center = projection.fromLatLngToDivPixel(map.getCenter());
      const point = projection.fromLatLngToDivPixel(new maps.LatLng(incident.latitude, incident.longitude));
      return { x: point.x - center.x + div.offsetWidth / 2, y: point.y - center.y + div.offsetHeight / 2 };
    }

    draw() {
      const projection = this.getProjection();
      const map = this.getMap();
      if (!projection || !map || !map.getCenter()) return;

      const div = map.getDiv();
      const width = div.offsetWidth + CANVAS_MARGIN * 2;
      const height = div.offsetHeight + CANVAS_MARGIN * 2;
      const ratio = window.devicePixelRatio || 1;
      const center = projection.fromLatLngToDivPixel(map.getCenter());

      const canvas = this.canvas;
      canvas.style.left = `${center.x - width / 2}px`;
      canvas.style.top = `${center.y - height / 2}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);

      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      const points = this.incidents
        .map((incident) => {
          const pixel = this.viewportPixel(incident);
          return pixel && { incident, x: pixel.x + CANVAS_MARGIN, y: pixel.y + CANVAS_MARGIN };
        })
        .filter((p) => p && p.x > -BLOB_RADIUS && p.y > -BLOB_RADIUS && p.x < width + BLOB_RADIUS && p.y < height + BLOB_RADIUS);

      const blob = (p, inner, outer) => {
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, BLOB_RADIUS);
        gradient.addColorStop(0, inner);
        gradient.addColorStop(1, outer);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, BLOB_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      };

      if (this.mode === 'density') {
        // Accumulate opacity where incidents overlap, then map opacity onto the ramp
        points.forEach((p) => blob(p, 'rgba(0, 0, 0, 0.35)', 'rgba(0, 0, 0, 0)'));
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = image.data;
        for (let i = 0; i < data.length; i += 4) {
          const level = data[i + 3] * 4;
          if (level) {
            data[i] = this.palette[level];
            data[i + 1] = this.palette[level + 1];
            data[i + 2] = this.palette[level + 2];
            data[i + 3] = this.palette[level + 3];
          }
        }
        ctx.putImageData(image, 0, 0);
      } else {
        points.forEach((p) => {
          const color = colorFor(p.incident, this.mode);
          blob(p, withAlpha(color, 0.5), withAlpha(color, 0));
        });
      }

      // One dot per incident, ringed so overlapping dots stay distinct
      points.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = this.mode === 'density' ? '#2c1f7a' : colorFor(p.incident, this.mode);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      });
    }

    // The incident drawn nearest to a clicked location, if any is within reach
    nearest(latLng, reach = 18) {
      const projection = this.getProjection();
      if (!projection) return null;
      const click = projection.fromLatLngToDivPixel(latLng);
      let best = null;
      let bestDistance = reach;
      for (const incident of this.incidents) {
        const point = projection.fromLatLngToDivPixel(new maps.LatLng(incident.latitude, incident.longitude));
        const distance = Math.hypot(point.x - click.x, point.y - click.y);
        if (distance <= bestDistance) {
          best = incident;
          bestDistance = distance;
        }
      }
      return best;
    }
  };
}

// Built with textContent: the message is whatever a victim typed
function describeIncident(incident) {
  const box = document.createElement('div');
  box.style.maxWidth = '240px';
  const line = (text, bold) => {
    const p = document.createElement('p');
    p.textContent = text;
    p.style.margin = '0 0 4px';
    if (bold) p.style.fontWeight = '600';
    box.appendChild(p);
  };
  if (isTriaged(incident)) {
    line(incident.categories.length > 0 ? incident.categories.join(' · ') : 'Uncategorized', true);
    line(`Urgency ${incident.urgency}/4 · ${incident.urgency_label}${incident.is_life_threatening ? ' · life threat' : ''}`);
  } else {
    line('Awaiting triage', true);
  }
  line(incident.message);
  if (incident.address) line(incident.address);
  if (incident.status === 'In Progress') line('Response in progress');
  if (incident.status === 'Resolved') line('Resolved');
  return box;
}

export default function IncidentMap({ incidents }) {
  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const infoRef = useRef(null);
  const mapsRef = useRef(null);
  const fittedRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('type');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());

  const located = useMemo(
    () => incidents.filter((i) => hasLocation(i) && (includeResolved || i.status !== 'Resolved')),
    [incidents, includeResolved]
  );
  const unlocatedCount = incidents.filter(
    (i) => !hasLocation(i) && (includeResolved || i.status !== 'Resolved')
  ).length;

  // The category filter belongs to the Type view; the other views always show everything
  const shown = useMemo(
    () => (mode === 'type' ? located.filter((i) => !hidden.has(categoryOf(i))) : located),
    [located, mode, hidden]
  );

  const categoryCounts = useMemo(() => {
    const counts = {};
    located.forEach((i) => {
      const key = categoryOf(i);
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }, [located]);

  const fitToIncidents = () => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!maps || !map || shown.length === 0) return;
    const bounds = new maps.LatLngBounds();
    shown.forEach((i) => bounds.extend({ lat: i.latitude, lng: i.longitude }));
    map.fitBounds(bounds, 60);
    // A single incident (or several at one address) would otherwise zoom to street-lamp level
    maps.event.addListenerOnce(map, 'idle', () => {
      if (map.getZoom() > 15) map.setZoom(15);
    });
  };

  // Create the map once
  useEffect(() => {
    if (!API_KEY) return undefined;
    let cancelled = false;
    let idleListener = null;
    let clickListener = null;
    window.gm_authFailure = () => setError('Google Maps rejected the API key. Check the key and its allowed websites.');

    loadGoogleMaps(API_KEY)
      .then(async (maps) => {
        const { Map, InfoWindow, OverlayView } = await maps.importLibrary('maps');
        await maps.importLibrary('core');
        if (cancelled || !mapDiv.current) return;

        const map = new Map(mapDiv.current, {
          center: { lat: 20, lng: 0 },
          zoom: 2,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          clickableIcons: false
        });
        const HeatOverlay = createHeatOverlay(maps, OverlayView);
        const overlay = new HeatOverlay();
        overlay.setMap(map);
        const info = new InfoWindow();

        // Panning moves the canvas with the map; redraw once it settles to refill the edges
        idleListener = map.addListener('idle', () => overlay.draw());
        clickListener = map.addListener('click', (event) => {
          const incident = overlay.nearest(event.latLng);
          if (!incident) {
            info.close();
            return;
          }
          info.setContent(describeIncident(incident));
          info.setPosition({ lat: incident.latitude, lng: incident.longitude });
          info.open({ map });
        });

        mapsRef.current = maps;
        mapRef.current = map;
        overlayRef.current = overlay;
        infoRef.current = info;
        setReady(true);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });

    return () => {
      cancelled = true;
      if (idleListener) idleListener.remove();
      if (clickListener) clickListener.remove();
      if (overlayRef.current) overlayRef.current.setMap(null);
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Redraw whenever the incidents or the colouring change
  useEffect(() => {
    if (!ready || !overlayRef.current) return;
    overlayRef.current.setData(shown, mode);
    if (infoRef.current) infoRef.current.close();
    if (!fittedRef.current && shown.length > 0) {
      fittedRef.current = true;
      fitToIncidents();
    }
  }, [ready, shown, mode]);

  const toggleCategory = (name) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const legendEntries = [...Object.keys(CATEGORY_COLORS), OTHER];

  return (
    <div className="bg-white rounded-lg shadow mb-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Incident Map</h2>
          <p className="text-xs text-gray-500">
            {shown.length} shown{unlocatedCount > 0 ? ` · ${unlocatedCount} without a location` : ''}
            {' · '}click a dot for details
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-600">Colour by</span>
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
            {MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setMode(option.id)}
                aria-pressed={mode === option.id}
                className={`px-3 py-1 font-semibold ${
                  mode === option.id ? 'bg-gray-800 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-gray-700">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(e) => setIncludeResolved(e.target.checked)}
            />
            Include resolved
          </label>
          <button
            type="button"
            onClick={fitToIncidents}
            disabled={!ready || shown.length === 0}
            className="px-3 py-1 rounded-md border border-gray-300 font-semibold text-gray-700 hover:bg-gray-100 disabled:text-gray-400"
          >
            Fit to incidents
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-gray-700">
        {mode === 'type' && legendEntries.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => toggleCategory(name)}
            aria-pressed={!hidden.has(name)}
            title={hidden.has(name) ? 'Show on map' : 'Hide from map'}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border border-gray-200 hover:bg-gray-100 ${
              hidden.has(name) ? 'opacity-40 line-through' : ''
            }`}
          >
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ backgroundColor: CATEGORY_COLORS[name] || OTHER_COLOR }}
            />
            {name} ({categoryCounts[name] || 0})
          </button>
        ))}
        {mode === 'severity' && (
          <>
            {SEVERITY_COLORS.map((color, level) => (
              <span key={color} className="flex items-center gap-1.5 px-2 py-1">
                <span
                  className="inline-block w-3 h-3 rounded-full border border-gray-300"
                  style={{ backgroundColor: color }}
                />
                {level} {SEVERITY_LABELS[level]}
              </span>
            ))}
            <span className="flex items-center gap-1.5 px-2 py-1">
              <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: OTHER_COLOR }} />
              untriaged
            </span>
          </>
        )}
        {mode === 'density' && (
          <span className="flex items-center gap-2 px-2 py-1">
            Fewer incidents
            <span
              className="inline-block w-32 h-3 rounded border border-gray-200"
              style={{ background: `linear-gradient(to right, ${DENSITY_STOPS.map(([stop, color]) => `${color} ${stop * 100}%`).join(', ')})` }}
            />
            More incidents
          </span>
        )}
      </div>

      {!API_KEY ? (
        <div className="h-48 flex items-center justify-center text-center text-sm text-gray-600 bg-gray-50 rounded border border-dashed border-gray-300 p-4">
          <p>
            The map needs a Google Maps API key. Create a file named <code>.env.local</code> in the project
            folder containing <code>VITE_GOOGLE_MAPS_API_KEY=your-key</code>.
          </p>
        </div>
      ) : (
        <div className="relative">
          <div ref={mapDiv} className="h-96 w-full rounded" />
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-50 rounded text-sm text-red-700 p-4 text-center">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
