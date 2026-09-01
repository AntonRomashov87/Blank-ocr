// netlify/functions/ocr.js  (Gemini, безкоштовний тір)
// Ключ — у змінній оточення GEMINI_API_KEY.
// GET /.netlify/functions/ocr?models=1  — показує доступні моделі.
// Щоб не витрачати час на пошук моделі, задай GEMINI_MODEL у Netlify.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const BAD = ['embedding', 'aqa', 'image', 'tts', 'audio', 'live', 'veo', 'imagen', 'gemma'];

let CACHE = null; // список моделей живе, поки контейнер теплий

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };

  const key = process.env.GEMINI_API_KEY;
  if (!key) return reply(500, { error: 'GEMINI_API_KEY не заданий у налаштуваннях Netlify' });

  // діагностика: подивитись, які моделі доступні саме твоєму ключу
  if (event.httpMethod === 'GET') {
    if ((event.queryStringParameters || {}).models === undefined) return reply(405, { error: 'Only POST' });
    try {
      return reply(200, { models: await pickModels(key), fixed: process.env.GEMINI_MODEL || null });
    } catch (e) {
      return reply(502, { error: e.message });
    }
  }
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Only POST' });

  let images = [], prompt = '';
  try {
    ({ images = [], prompt = '' } = JSON.parse(event.body || '{}'));
  } catch {
    return reply(400, { error: 'Тіло запиту не є коректним JSON' });
  }
  if (!images.length) return reply(400, { error: 'Немає жодного фото' });

  let models;
  try {
    models = await pickModels(key);
  } catch (e) {
    return reply(502, { error: 'Не вдалося отримати список моделей: ' + e.message });
  }
  if (!models.length) return reply(502, { error: 'Google не повернув жодної придатної моделі' });

  const parts = [
    ...images.map(i => ({ inline_data: { mime_type: i.media_type || 'image/jpeg', data: i.data } })),
    { text: prompt }
  ];

  const tried = [];
  const t0 = Date.now();

  // відмови типу "high demand" приходять миттєво, тому спроб більше,
  // але слідкуємо за часом: у Netlify всього 10 секунд
  for (const model of models.slice(0, 5)) {
    if (Date.now() - t0 > 7000) { tried.push('час вичерпано'); break; }
    // thinking вимкнено — для розпізнавання воно не потрібне, а часу їсть найбільше
    for (const cfg of [
      { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' }
    ]) {
      let r, j;
      try {
        r = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: cfg })
        });
        j = await r.json();
      } catch (e) {
        tried.push(`${model}: мережа ${e.message}`);
        break;
      }

      if (r.status === 429) {
        return reply(429, { error: 'Вичерпано безкоштовний ліміт Gemini. Зачекай хвилину або спробуй завтра.' });
      }

      if (r.ok) {
        const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (text.trim()) return reply(200, { text, model });
        tried.push(`${model}: порожня відповідь`);
        break;
      }

      tried.push(`${model}: ${j?.error?.message || r.status}`);
      if (r.status !== 400) break; // 400 може бути через thinkingConfig — повторюємо без нього
    }
  }

  return reply(502, { error: 'Жодна модель не відповіла. ' + tried.join(' | ') });
};

async function pickModels(key) {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (CACHE) return CACHE;

  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || String(r.status));

  CACHE = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name).replace(/^models\//, ''))
    .filter(n => n.startsWith('gemini-'))
    .filter(n => !BAD.some(b => n.includes(b)))
    .filter(n => n.includes('flash'))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => rank(b) - rank(a));
  return CACHE;
}

function rank(n) {
  const ver = parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  let s = ver * 100;
  if (n.includes('lite')) s += 12;                        // швидші, а часу мало
  if (n.includes('preview') || n.includes('exp')) s -= 30;
  if (n.includes('latest')) s += 5;
  if (/\d{2}-\d{4}$/.test(n)) s -= 20;                    // датовані знімки
  return s;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}
function reply(code, obj) {
  return { statusCode: code, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
