import React, { useEffect, useState } from 'react';
import VictimForm from './VictimForm';
import DispatchDashboard from './DispatchDashboard';
import { initMesh } from './mesh';

export default function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  useEffect(() => {
    // Initialize the WebRTC mesh network globally on app load
    initMesh((peerCount) => {
      console.log("Mesh peer count updated:", peerCount);
    });

    // Simple path listener for router tabs
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return (
    <div>
      <nav className="bg-gray-800 text-white p-4 flex justify-between items-center shadow-md">
        <h1 className="font-bold text-lg">MeshGuardian P2P</h1>
        <div className="space-x-4">
          <a href="/" className="hover:underline">Victim Portal</a>
          <a href="/dispatch" className="hover:underline">Dispatch Dashboard</a>
        </div>
      </nav>

      {currentPath === '/dispatch' ? <DispatchDashboard /> : <VictimForm />}
    </div>
  );
}