const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = 'northeurope';
const PORT = process.env.PORT || 3000;

// Voix Azure Neural par langue
const AZURE_VOICES = {
  'mk-MK': 'mk-MK-AleksandarNeural',
  'sq-AL': 'sq-AL-IlirNeural',
  'sr-RS': 'sr-RS-NicholasNeural',
  'bg-BG': 'bg-BG-BorislavNeural',
  'tr-TR': 'tr-TR-AhmetNeural',
  'el-GR': 'el-GR-AthinaNeural',
  'fr-FR': 'fr-FR-DeniseNeural',
  'en-US': 'en-US-JennyNeural',
  'de-DE': 'de-DE-KatjaNeural',
  'es-ES': 'es-ES-ElviraNeural',
  'it-IT': 'it-IT-ElsaNeural',
  'ar-XA': 'ar-EG-SalmaNeural',
};

// ── Santé ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'makedoo-api', version: '2.0.0', tts: 'azure+google' });
});

// ── Traduction (Google) ────────────────────────────────────────
app.post('/translate', async (req, res) => {
  try {
    const { text, source, target } = req.body;
    if (!text || !source || !target) return res.status(400).json({ error: 'Paramètres manquants' });
    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source, target, format: 'text' }) }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ translated: data.data.translations[0].translatedText });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── TTS Azure ─────────────────────────────────────────────────
async function azureTTS(text, languageCode, speakingRate) {
  const voice = AZURE_VOICES[languageCode] || 'en-US-JennyNeural';
  const rate = speakingRate < 1 ? '-10%' : '+0%';
  const ssml = `<speak version='1.0' xml:lang='${languageCode}'>
    <voice name='${voice}'>
      <prosody rate='${rate}'>${text}</prosody>
    </voice>
  </speak>`;
  const response = await fetch(
    `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    { method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      },
      body: ssml }
  );
  if (!response.ok) throw new Error(`Azure TTS error: ${response.status}`);
  const buffer = await response.buffer();
  return buffer.toString('base64');
}

// ── TTS Google (fallback) ──────────────────────────────────────
async function googleTTS(text, languageCode, speakingRate) {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, ssmlGender: 'FEMALE' },
        audioConfig: { audioEncoding: 'MP3', speakingRate }
      }) }
  );
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.audioContent;
}

// ── TTS endpoint ───────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  try {
    const { text, languageCode, speakingRate = 0.85 } = req.body;
    if (!text || !languageCode) return res.status(400).json({ error: 'Paramètres manquants' });

    // Langues Azure : MK, SQ, SR, BG, TR, EL + toutes si clé Azure dispo
    const azureLangs = ['mk-MK','sq-AL','sr-RS','bg-BG','tr-TR','el-GR'];
    let audioContent;

    if (AZURE_KEY && (azureLangs.includes(languageCode) || AZURE_VOICES[languageCode])) {
      try {
        audioContent = await azureTTS(text, languageCode, speakingRate);
      } catch (e) {
        console.log('Azure fallback to Google:', e.message);
        audioContent = await googleTTS(text, languageCode, speakingRate);
      }
    } else {
      audioContent = await googleTTS(text, languageCode, speakingRate);
    }
    res.json({ audioContent });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── STT (Google) ───────────────────────────────────────────────
app.post('/stt', async (req, res) => {
  try {
    const { audio, languageCode, encoding = 'WEBM_OPUS', sampleRateHertz = 48000 } = req.body;
    if (!audio || !languageCode) return res.status(400).json({ error: 'Paramètres manquants' });
    const response = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { encoding, sampleRateHertz, languageCode, enableAutomaticPunctuation: true, model: 'default' },
          audio: { content: audio }
        }) }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const transcript = data.results?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.listen(PORT, () => console.log(`✅ Makedoo API v2 sur port ${PORT}`));
