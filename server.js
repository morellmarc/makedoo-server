const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.GOOGLE_API_KEY;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('⚠️  GOOGLE_API_KEY manquante !');
}

// ── Santé du serveur ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'makedoo-api', version: '1.0.0' });
});

// ── Traduction ────────────────────────────────────────────────
app.post('/translate', async (req, res) => {
  try {
    const { text, source, target } = req.body;
    if (!text || !source || !target) return res.status(400).json({ error: 'Paramètres manquants' });

    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source, target, format: 'text' })
      }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ translated: data.data.translations[0].translatedText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Synthèse vocale (TTS) ─────────────────────────────────────
app.post('/tts', async (req, res) => {
  try {
    const { text, languageCode, speakingRate = 0.85 } = req.body;
    if (!text || !languageCode) return res.status(400).json({ error: 'Paramètres manquants' });

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, ssmlGender: 'FEMALE' },
          audioConfig: { audioEncoding: 'MP3', speakingRate }
        })
      }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ audioContent: data.audioContent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reconnaissance vocale (STT) ───────────────────────────────
app.post('/stt', async (req, res) => {
  try {
    const { audio, languageCode, encoding = 'WEBM_OPUS', sampleRateHertz = 48000 } = req.body;
    if (!audio || !languageCode) return res.status(400).json({ error: 'Paramètres manquants' });

    const response = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { encoding, sampleRateHertz, languageCode, enableAutomaticPunctuation: true, model: 'default' },
          audio: { content: audio }
        })
      }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const transcript = data.results?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Makedoo API démarrée sur le port ${PORT}`);
});
