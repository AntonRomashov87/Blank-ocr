// netlify/functions/ocr.js  (Gemini, безкоштовний тір)
// Ключ — у змінній оточення GEMINI_API_KEY, у браузер не потрапляє.
// Назву моделі вгадувати не треба: функція питає в Google список доступних
// і сама обирає придатну. Можна зафіксувати вручну через GEMINI_MODEL.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const BAD = ['embedding', 'aqa', 'image', 'tts', 'audio', 'live', 'veo', 'imagen', 'gemma'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Only POST' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return reply(500, { error: 'GEMINI_API_KEY не заданий у налаштуваннях Netlify' });

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

  for (const model of models.slice(0, 4)) {
    for (const strictJson of [true, false]) {
      const cfg = { temperature: 0, maxOutputTokens: 8192 };
      if (strictJson) cfg.responseMimeType = 'application/json';

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
        continue;
      }

      tried.push(`${model}: ${j?.error?.message || r.status}`);
      if (r.status !== 400) break;
    }
  }

  return reply(502, { error: 'Жодна модель не відповіла. ' + tried.join(' | ') });
};

// список моделей від Google, відсортований: новіші Flash першими
async function pickModels(key) {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];

  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || String(r.status));

  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name).replace(/^models\//, ''))
    .filter(n => !BAD.some(b => n.includes(b)))
    .filter(n => n.includes('flash') || n.includes('pro'))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => rank(b) - rank(a));
}

function rank(n) {
  const ver = parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [])[1] || '0');
  let s = ver * 100;
  if (n.includes('flash')) s += 40;      // на безкоштовному тірі доступні саме Flash
  if (n.includes('lite')) s -= 15;       // трохи слабші на рукописі
  if (n.includes('preview') || n.includes('exp')) s -= 25;
  if (n.includes('latest')) s += 5;
  if (n.includes('pro')) s -= 30;        // на free tier зазвичай недоступні
  return s;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
function reply(code, obj) {
  return { statusCode: code, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
