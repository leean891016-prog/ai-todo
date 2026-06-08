// GitHub Actions cron script — checks reminders and sends Web Push
const fs = require('fs');
const webpush = require('web-push');

const VAPID_PUBLIC = 'BO8R1QOlLq7U_Ro6dnUm_2XnEESRSsQ84pff0HCkNEjvuEHAMR-6Hvm81NtPAjksRtfeHUaLLUGQsLSuNW5Fasg';
const VAPID_PRIVATE = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgO/W8wc/rpZhYbtjH90wwEVK8sbDs8CTvbz/52H9Ao3GhRANCAATvEdUDpS6u1P0aOnZ1Jv9l5xBEkUrEPOKX39BwpDRI77hBwDEfuh75vNTbTwI5LEbX3h1Giy1BkLC0rjVuRWrI';

webpush.setVapidDetails('mailto:ai-todo@example.com', VAPID_PUBLIC, VAPID_PRIVATE);

let data = { devices: {} };
try {
  data = JSON.parse(fs.readFileSync('push-data.json', 'utf8'));
} catch (e) {
  console.log('[cron] No data file, exiting');
  process.exit(0);
}

if (!data.devices || Object.keys(data.devices).length === 0) {
  console.log('[cron] No devices');
  process.exit(0);
}

const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
const nowMinutes = now.getHours() * 60 + now.getMinutes();

console.log(`[cron] today=${today} time=${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} minutes=${nowMinutes}`);

let changed = false;
const pushes = [];

for (const [deviceId, device] of Object.entries(data.devices)) {
  if (!device.subscription || !device.reminders?.length) {
    console.log(`[cron] skip ${deviceId}: no sub or no reminders`);
    continue;
  }

  if (!device._fired) device._fired = {};
  if (!device._fired[today]) device._fired[today] = [];

  for (const r of device.reminders) {
    if (!r.reminderTime || !r.reminderDate || r.reminderDate !== today) continue;
    const [h, m] = r.reminderTime.split(':').map(Number);
    const rMinutes = h * 60 + m;

    // 5-minute window
    if (nowMinutes < rMinutes || nowMinutes >= rMinutes + 5) continue;

    const fid = r.id || r.text;
    if (device._fired[today].includes(fid)) {
      console.log(`[cron] ${deviceId}: already fired "${r.text}"`);
      continue;
    }

    device._fired[today].push(fid);
    changed = true;
    pushes.push({ deviceId, subscription: device.subscription, text: r.text, fid });
  }

  // Clean old fired data
  if (device._fired) {
    for (const key of Object.keys(device._fired)) {
      if (key !== today) { delete device._fired[key]; changed = true; }
    }
  }
}

// Send all pushes
for (const p of pushes) {
  try {
    await webpush.sendNotification(p.subscription, JSON.stringify({
      title: '⏰ 待办提醒',
      body: p.text,
      tag: 'ai-todo',
      requireInteraction: false,
    }));
    console.log(`[cron] PUSH SENT to ${p.deviceId}: "${p.text}"`);
  } catch (e) {
    console.warn(`[cron] PUSH FAILED for ${p.deviceId}: ${e.message} status=${e.statusCode}`);
    if (e.statusCode === 410 || e.statusCode === 404) {
      data.devices[p.deviceId].subscription = null;
      changed = true;
      console.log(`[cron] Removed expired subscription for ${p.deviceId}`);
    }
  }
}

if (changed) {
  fs.writeFileSync('push-data.json', JSON.stringify(data, null, 2));
  console.log('[cron] Data updated');
} else {
  console.log('[cron] No changes');
}
