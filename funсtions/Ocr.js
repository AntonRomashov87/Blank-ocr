// netlify/functions/ocr.js  (варіант для Gemini, безкоштовний тір)
// Ключ береться зі змінної оточення GEMINI_API_KEY і в браузер не потрапляє.
// За бажанням можна задати GEMINI_MODEL, інакше перебираються моделі зі списку.

const FALLBACK = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash'];

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

  const parts = [
    ...images.map(i => ({ inline_data: { mime_type: i.media_type || 'image/jpeg', data: i.data } })),
    { text: prompt }
  ];

  const models = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL, ...FALLBACK]
    : FALLBACK;

  let last = 'невідома помилка';

  for (const model of models) {
    // спершу з примусовим JSON, а якщо модель цього не вміє — без нього
    for (const strictJson of [true, false]) {
      const cfg = { temperature: 0, maxOutputTokens: 8192 };
      if (strictJson) cfg.responseMimeType = 'application/json';

      let r, j;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ parts }], generationConfig: cfg })
          }
        );
        j = await r.json();
      } catch (e) {
        last = 'мережа: ' + e.message;
        break;
      }

      if (r.status === 429) {
        return reply(429, { error: 'Вичерпано безкоштовний ліміт Gemini. Зачекай хвилину або спробуй завтра.' });
      }

      if (r.ok) {
        const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (text.trim()) return reply(200, { text, model });
        last = `модель ${model} повернула порожню відповідь`;
        continue;
      }

      last = `${model}: ${j?.error?.message || r.status}`;
      // 400 через responseMimeType — має сенс повторити без нього, решта помилок — наступна модель
      if (r.status !== 400) break;
    }
  }

  return reply(502, { error: last });
};

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
