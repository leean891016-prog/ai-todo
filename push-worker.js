// Cloudflare Worker — Web Push backend for AI-Todo
// Stores device subscriptions + reminders in KV, sends push via cron

const VAPID_PUBLIC_KEY  = 'BO8R1QOlLq7U_Ro6dnUm_2XnEESRSsQ84pff0HCkNEjvuEHAMR-6Hvm81NtPAjksRtfeHUaLLUGQsLSuNW5Fasg';
const VAPID_PRIVATE_B64 = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgO/W8wc/rpZhYbtjH90wwEVK8sbDs8CTvbz/52H9Ao3GhRANCAATvEdUDpS6u1P0aOnZ1Jv9l5xBEkUrEPOKX39BwpDRI77hBwDEfuh75vNTbTwI5LEbX3h1Giy1BkLC0rjVuRWrI';

function b64ToBytes(s) {
  s = s.replace(/-/g, '+').replace(/\//g, '_');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function bytesToB64(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function getToday() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getTimeHM() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ============ Web Push Encryption ============

async function encryptPayload(authSecret, p256dhKey, salt, plaintext) {
  // Import user's public key
  const userPubKey = await crypto.subtle.importKey(
    'raw', p256dhKey,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // Import our private key from PKCS8
  const ourPrivKey = await crypto.subtle.importKey(
    'pkcs8', b64ToBytes(VAPID_PRIVATE_B64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
  );

  // ECDH
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userPubKey },
    ourPrivKey, 256
  );

  // HKDF for key derivation
  const ikm = new Uint8Array(sharedSecret);
  const ourPubRaw = b64ToBytes(VAPID_PUBLIC_KEY);
  const info = new Uint8Array('WebPush: info\0'.length + p256dhKey.length + ourPubRaw.length);
  const infoPrefix = new TextEncoder().encode('WebPush: info\0');
  info.set(infoPrefix, 0);
  info.set(p256dhKey, infoPrefix.length);
  info.set(ourPubRaw, infoPrefix.length + p256dhKey.length);

  // Import IKM for HKDF
  const hkdfKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);

  // PRK
  const prk = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: new Uint8Array(0) },
    hkdfKey, 256
  );

  const prkKey = await crypto.subtle.importKey('raw', new Uint8Array(prk), { name: 'HKDF' }, false, ['deriveBits']);

  // CEK (Content Encryption Key)
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const cek = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: cekInfo },
    prkKey, 128
  );

  // NONCE
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: nonceInfo },
    prkKey, 96
  );

  // Encrypt
  const aesKey = await crypto.subtle.importKey('raw', new Uint8Array(cek), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce) },
    aesKey, plaintext
  );

  // Build record: salt (16) + record_size (4 bytes big-endian, 4096) + ciphertext
  const record = new Uint8Array(21 + ciphertext.byteLength);
  record.set(salt, 0);
  // record size 4096 = 0x00001000, big endian
  record[16] = 0; record[17] = 0; record[18] = 0x10; record[19] = 0; record[20] = 0;
  record.set(new Uint8Array(ciphertext), 21);
  return record;
}

async function createVapidJWT(endpoint) {
  const ourPrivKey = await crypto.subtle.importKey(
    'pkcs8', b64ToBytes(VAPID_PRIVATE_B64),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 86400,
    sub: 'mailto:ai-todo@example.com'
  };

  const enc = new TextEncoder();
  const input = bytesToB64(enc.encode(JSON.stringify(header))) + '.' +
    bytesToB64(enc.encode(JSON.stringify(payload)));

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    ourPrivKey, enc.encode(input)
  );

  return input + '.' + bytesToB64(new Uint8Array(sig));
}

async function sendPush(subscription, title, body) {
  const endpoint = subscription.endpoint;
  const auth = b64ToBytes(subscription.keys.auth);
  const p256dh = b64ToBytes(subscription.keys.p256dh);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const payload = new TextEncoder().encode(JSON.stringify({ title, body }));
  const encrypted = await encryptPayload(auth, p256dh, salt, payload);
  const vapidJWT = await createVapidJWT(endpoint);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '60',
      'Authorization': 'vapid t=' + vapidJWT + ', k=' + VAPID_PUBLIC_KEY,
    },
    body: encrypted
  });

  if (!resp.ok && resp.status !== 201) {
    console.warn('Push failed:', resp.status, await resp.text());
    throw new Error('Push failed: ' + resp.status);
  }
}

// ============ Main Handler ============

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (url.pathname === '/api/sync' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { deviceId, subscription, reminders } = body;
        if (!deviceId) return new Response('missing deviceId', { status: 400 });

        const raw = await env.TODO_STORE.get('data');
        const data = raw ? JSON.parse(raw) : { devices: {} };

        data.devices[deviceId] = {
          subscription: subscription || (data.devices[deviceId]?.subscription || null),
          reminders: reminders || [],
          updatedAt: Date.now()
        };

        await env.TODO_STORE.put('data', JSON.stringify(data));

        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }
    }

    return new Response('ai-todo push worker ok', { status: 200 });
  },

  async scheduled(event, env) {
    const raw = await env.TODO_STORE.get('data');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.devices) return;

    const today = getToday();
    const now = getTimeHM();
    const [nowH, nowM] = now.split(':').map(Number);
    const nowMinutes = nowH * 60 + nowM;

    for (const [deviceId, device] of Object.entries(data.devices)) {
      if (!device.subscription || !device.reminders || device.reminders.length === 0) continue;

      // Fired tracking: per-device, per-day
      if (!device._fired) device._fired = {};
      if (!device._fired[today]) device._fired[today] = [];

      for (const r of device.reminders) {
        if (!r.reminderTime || !r.reminderDate) continue;
        if (r.reminderDate !== today) continue;
        const [h, m] = r.reminderTime.split(':').map(Number);
        const rMinutes = h * 60 + m;

        // Fire within a 1-minute window, once per day
        if (nowMinutes >= rMinutes && nowMinutes < rMinutes + 1) {
          const fid = r.id || r.text;
          if (!device._fired[today].includes(fid)) {
            device._fired[today].push(fid);
            try {
              await sendPush(device.subscription, '⏰ 待办提醒', r.text);
              console.log('Push sent to', deviceId, ':', r.text);
            } catch (e) {
              console.warn('Push failed for', deviceId, ':', e.message);
            }
          }
        }
      }
    }

    // Clean old fired data (keep only today + yesterday)
    const yesterday = getToday(); // Not exactly yesterday but good enough for cleanup
    for (const [id, dev] of Object.entries(data.devices)) {
      if (dev._fired) {
        for (const key of Object.keys(dev._fired)) {
          if (key !== today) delete dev._fired[key];
        }
      }
    }

    await env.TODO_STORE.put('data', JSON.stringify(data));
  }
};
