import React, { useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { db } from './db';
import { broadcastSos } from './mesh';
import { submitSos, transcribeAudio } from './api';

export default function VictimForm() {
  const [formData, setFormData] = useState({
    phone_number: '',
    message: ''
  });
  const [submitted, setSubmitted] = useState(false);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [voice, setVoice] = useState('idle'); // idle | recording | transcribing
  const [voiceError, setVoiceError] = useState(null);
  const recorderRef = useRef(null);

  // Record from the microphone; on stop, the server transcribes it and the text joins the message
  const startRecording = async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setVoice('transcribing');
        try {
          const text = await transcribeAudio(new Blob(chunks, { type: recorder.mimeType }));
          if (text) {
            setFormData((current) => ({
              ...current,
              message: current.message.trim() ? `${current.message.trimEnd()} ${text}` : text
            }));
          } else {
            setVoiceError('No speech was heard. Please try again.');
          }
        } catch (error) {
          setVoiceError(error.message || 'Could not turn the recording into text.');
        }
        setVoice('idle');
      };
      recorder.start();
      recorderRef.current = recorder;
      setVoice('recording');
    } catch (error) {
      console.warn('Microphone unavailable:', error);
      setVoiceError('Microphone unavailable. Allow microphone access in the browser and try again.');
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
  };

  // Fetch browser GPS coordinates
  const fetchCoordinates = () => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ latitude: null, longitude: null });
      } else {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude
            });
          },
          () => {
            resolve({ latitude: null, longitude: null });
          },
          { timeout: 8000 }
        );
      }
    });
  };

  // Reverse geocode lat/lon to human-readable address (works online)
  const getAddressFromCoords = async (latitude, longitude) => {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,
        { headers: { 'User-Agent': 'MeshGuardian-DisasterApp' } }
      );
      const data = await response.json();
      return data.display_name || 'Coordinates recorded (Offline)';
    } catch (error) {
      return 'Coordinates recorded (Offline)';
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoadingLocation(true);

    const coords = await fetchCoordinates();
    let resolvedAddress = 'Location unavailable';
    if (coords.latitude && coords.longitude) {
      resolvedAddress = await getAddressFromCoords(coords.latitude, coords.longitude);
    }

    const sosRecord = {
      id: 'sos_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      ...formData,
      latitude: coords.latitude,
      longitude: coords.longitude,
      address: resolvedAddress,
      status: 'Pending',
      timestamp: new Date().toISOString()
    };

    try {
      // 1. Save locally to IndexedDB via Dexie
      await db.sosRequests.put(sosRecord);

      // 2. Ask the server for Laya's triage; offline, the raw record still goes out
      let outgoing = sosRecord;
      try {
        outgoing = await submitSos(sosRecord);
        await db.sosRequests.put(outgoing);
      } catch (error) {
        console.warn('Triage server unreachable, broadcasting untriaged SOS:', error);
      }

      // 3. Broadcast over WebRTC mesh
      broadcastSos(outgoing);

      setLoadingLocation(false);
      setSubmitted(true);
    } catch (error) {
      console.error('Failed to save or broadcast SOS:', error);
      setLoadingLocation(false);
    }
  };

  return (
    <div className="max-w-md mx-auto my-10 p-6 bg-white rounded-xl shadow-lg border border-gray-200">
      <h2 className="text-2xl font-bold mb-2 text-red-600">Disaster SOS Submission</h2>
      <p className="text-sm text-gray-500 mb-6">
        Offline-first emergency broadcast. Your GPS location and address will be securely attached.
      </p>

      {submitted ? (
        <div className="p-6 bg-green-50 border border-green-200 text-green-700 rounded-lg text-center space-y-4">
          <h3 className="font-bold text-lg">SOS Broadcasted Successfully!</h3>
          <p className="text-sm text-green-600">Synced to local mesh network and responders.</p>
          <button 
            onClick={() => {
              setSubmitted(false);
              setFormData({
                phone_number: '',
                message: ''
              });
            }}
            className="w-full bg-green-600 text-white py-2 px-4 rounded-md font-bold hover:bg-green-700 transition-colors"
          >
            Submit Another Request
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Phone Number / Identifier</label>
            <input 
              type="text" 
              required
              placeholder="e.g. +1 (555) 019-2834"
              className="mt-1 block w-full p-2.5 border border-gray-300 rounded-md" 
              value={formData.phone_number} 
              onChange={e => setFormData({...formData, phone_number: e.target.value})} 
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Emergency Details</label>
            <textarea 
              required
              rows="3"
              placeholder="Describe your situation..."
              className="mt-1 block w-full p-2.5 border border-gray-300 rounded-md" 
              value={formData.message}
              onChange={e => setFormData({...formData, message: e.target.value})}
            />
            <button
              type="button"
              onClick={voice === 'recording' ? stopRecording : startRecording}
              disabled={voice === 'transcribing'}
              aria-pressed={voice === 'recording'}
              className={`mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-md border font-semibold text-sm transition-colors disabled:bg-gray-100 disabled:text-gray-400 ${
                voice === 'recording'
                  ? 'bg-red-600 border-red-600 text-white hover:bg-red-700'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
              }`}
            >
              {voice === 'recording' ? <Square size={16} /> : <Mic size={16} />}
              {voice === 'recording'
                ? 'Stop recording'
                : voice === 'transcribing' ? 'Turning speech into text...' : 'Speak instead of typing'}
            </button>
            {voiceError && <p className="mt-1 text-sm text-red-600">{voiceError}</p>}
          </div>

          <button 
            type="submit" 
            disabled={loadingLocation}
            className="w-full bg-red-600 text-white py-3 rounded-md font-bold hover:bg-red-700 shadow-md transition-colors disabled:bg-gray-400"
          >
            {loadingLocation ? 'ACQUIRING GPS & BROADCASTING...' : 'BROADCAST SOS OVER MESH'}
          </button>
        </form>
      )}
    </div>
  );
}