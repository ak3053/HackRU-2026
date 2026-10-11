import Dexie from 'dexie';

export const db = new Dexie('MeshGuardianDB');

db.version(1).stores({
  sosRequests: 'id, phone_number, message, category, urgency, is_life_threatening, timestamp'
});