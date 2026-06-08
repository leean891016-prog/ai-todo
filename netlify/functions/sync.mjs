// Netlify Function — Web Push sync + debug endpoint for AI-Todo
// Stores device subscriptions + reminders via Netlify Blobs

import { getStore } from '@netlify/blobs';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const store = getStore('todo-data');

  if (url.pathname === '/api/debug' && req.method === 'GET') {
    try {
      const data = await store.get('data', { type: 'json' }) || { devices: {} };
      for (const id of Object.keys(data.devices)) {
        if (data.devices[id].subscription) {
          data.devices[id].subscription = {
            endpoint: data.devices[id].subscription.endpoint,
            keys: '(masked)',
          };
        }
      }
      return new Response(JSON.stringify({
        deviceCount: Object.keys(data.devices).length,
        devices: data,
      }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  }

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { deviceId, subscription, reminders } = body;
      if (!deviceId) {
        return new Response(JSON.stringify({ error: 'missing deviceId' }), {
          status: 400,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        });
      }

      const data = await store.get('data', { type: 'json' }) || { devices: {} };
      data.devices[deviceId] = {
        subscription: subscription || (data.devices[deviceId]?.subscription || null),
        reminders: reminders || [],
        updatedAt: Date.now(),
      };

      await store.setJSON('data', data);

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('ai-todo push worker ok', {
    headers: corsHeaders(),
  });
};
