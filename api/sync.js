// Vercel Serverless Function — Web Push sync + debug endpoint

import { kv } from '@vercel/kv';

// VAPID keys
const VAPID_PUBLIC_KEY = 'BO8R1QOlLq7U_Ro6dnUm_2XnEESRSsQ84pff0HCkNEjvuEHAMR-6Hvm81NtPAjksRtfeHUaLLUGQsLSuNW5Fasg';
const VAPID_PRIVATE_B64 = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgO/W8wc/rpZhYbtjH90wwEVK8sbDs8CTvbz/52H9Ao3GhRANCAATvEdUDpS6u1P0aOnZ1Jv9l5xBEkUrEPOKX39BwpDRI77hBwDEfuh75vNTbTwI5LEbX3h1Giy1BkLC0rjVuRWrI';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// In-memory fallback when KV is not configured
let memoryStore = { devices: {} };

async function getData() {
  try {
    if (process.env.KV_REST_API_URL) {
      return await kv.get('data', { type: 'json' }) || { devices: {} };
    }
  } catch(e) { console.warn('KV read failed:', e.message); }
  return memoryStore;
}

async function setData(data) {
  try {
    if (process.env.KV_REST_API_URL) {
      await kv.set('data', JSON.stringify(data));
    }
  } catch(e) { console.warn('KV write failed:', e.message); }
  memoryStore = data;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/debug' && req.method === 'GET') {
    try {
      const data = await getData();
      for (const id of Object.keys(data.devices)) {
        if (data.devices[id].subscription) {
          data.devices[id].subscription = { endpoint: data.devices[id].subscription.endpoint, keys: '(masked)' };
        }
      }
      return res.json({ deviceCount: Object.keys(data.devices).length, devices: data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    try {
      const { deviceId, subscription, reminders } = req.body;
      if (!deviceId) return res.status(400).json({ error: 'missing deviceId' });

      const data = await getData();
      data.devices[deviceId] = {
        subscription: subscription || (data.devices[deviceId]?.subscription || null),
        reminders: reminders || [],
        updatedAt: Date.now(),
      };

      await setData(data);

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(200).send('ai-todo push worker ok');
}
