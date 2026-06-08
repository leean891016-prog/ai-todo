// GitHub Actions sync script — merges device data from workflow_dispatch
const fs = require('fs');

const inputJson = process.argv[2] || '{}';
const inputs = JSON.parse(inputJson);

if (!inputs.deviceId) {
  console.log('[sync] No deviceId, skipping');
  process.exit(0);
}

let data = { devices: {} };
try {
  data = JSON.parse(fs.readFileSync('push-data.json', 'utf8'));
} catch (e) {
  console.log('[sync] No existing data file, creating new');
}

data.devices[inputs.deviceId] = {
  subscription: inputs.subscription ? JSON.parse(inputs.subscription) : (data.devices[inputs.deviceId]?.subscription || null),
  reminders: inputs.reminders ? JSON.parse(inputs.reminders) : [],
  updatedAt: Date.now(),
};

fs.writeFileSync('push-data.json', JSON.stringify(data, null, 2));
console.log('[sync] Saved device:', inputs.deviceId, 'total devices:', Object.keys(data.devices).length);
