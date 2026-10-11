import { joinRoom } from 'trystero';
import { db } from './db';
import { applyStatus, mergeRecord } from './api';

const config = { appId: 'disaster-mesh-app-v1' };
const room = joinRoom(config, 'emergency-mesh-room');

let sosAction = null;
let statusAction = null;

export function initMesh(onPeerUpdate) {
  sosAction = room.makeAction('sync_sos');
  statusAction = room.makeAction('update_status');

  // Handle incoming SOS records
  sosAction.onMessage = async (incomingRecords, peerId) => {
    if (Array.isArray(incomingRecords)) {
      for (const record of incomingRecords) {
        await mergeRecord(record);
      }
    }
  };

  // Handle incoming status updates (e.g. resolving an incident)
  statusAction.onMessage = async (statusUpdate, peerId) => {
    if (statusUpdate && statusUpdate.id) {
      await applyStatus(statusUpdate.id, statusUpdate.status, statusUpdate.status_updated_at);
    }
  };

  room.onPeerJoin = (peerId) => {
    if (onPeerUpdate) onPeerUpdate(Object.keys(room.getPeers()).length + 1);

    db.sosRequests.toArray().then((localRecords) => {
      if (sosAction && localRecords.length > 0) {
        sosAction.send(localRecords, peerId);
      }
    });
  };

  room.onPeerLeave = (peerId) => {
    if (onPeerUpdate) onPeerUpdate(Object.keys(room.getPeers()).length + 1);
  };
}

export function broadcastSos(record) {
  if (sosAction) {
    sosAction.send([record]);
  }
}

// Broadcast resolution / status change to all connected peers
export function broadcastStatusUpdate(id, status, status_updated_at) {
  if (statusAction) {
    statusAction.send({ id, status, status_updated_at });
  }
}