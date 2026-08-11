const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = 'northeurope';
const PORT = process.env.PORT || 3000;
const COUNTER_FILE = path.join(__dirname, 'visits.json');
const INFO_FILE = path.join(__dirname, 'info-text.json');

// Voix Azure Neural par langue
const AZURE_VOICES = {
  'mk-MK': 'mk-MK-AleksandarNeural',
  'sq-AL': 'sq-AL-IlirNeural',
  'sr-RS': 'sr-RS-NicholasNeural',
  'bg-BG': 'bg-BG-BorislavNeural',
  'tr-TR': 'tr-TR-AhmetNeural',
  'el-GR': 'el-GR-AthinaNeural',
  'nl-NL': 'nl-NL-ColetteNeural',
  'fr-FR': 'fr-FR-DeniseNeural',
  'en-US': 'en-US-JennyNeural',
  'de-DE': 'de-DE-KatjaNeural',
  'es-ES': 'es-ES-ElviraNeural',
  'it-IT': 'it-IT-ElsaNeural',
  'ar-XA': 'ar-EG-SalmaNeural',
  'pt-PT': 'pt-PT-RaquelNeural',
  'ru-RU': 'ru-RU-SvetlanaNeural',
  'pl-PL': 'pl-PL-AgnieszkaNeural',
  'uk-UA': 'uk-UA-PolinaNeural',
  'ro-RO': 'ro-RO-AlinaNeural',
  'hu-HU': 'hu-HU-NoemiNeural',
  'cs-CZ': 'cs-CZ-VlastaNeural',
  'sk-SK': 'sk-SK-ViktoriaNeural',
  'sl-SI': 'sl-SI-PetraNeural',
  'hr-HR': 'hr-HR-GabrijelaNeural',
  'bs-BA': 'bs-BA-VesnaNeural',
  'sv-SE': 'sv-SE-SofieNeural',
  'da-DK': 'da-DK-ChristelNeural',
  'nb-NO': 'nb-NO-PernilleNeural',
  'fi-FI': 'fi-FI-SelmaNeural',
  'is-IS': 'is-IS-GudrunNeural',
  'et-EE': 'et-EE-AnuNeural',
  'lv-LV': 'lv-LV-EveritaNeural',
  'lt-LT': 'lt-LT-OnaNeural',
  'ka-GE': 'ka-GE-EkaNeural',
  'hy-AM': 'hy-AM-AnahitNeural',
  'ca-ES': 'ca-ES-JoanaNeural',
  'cy-GB': 'cy-GB-NiaNeural',
  'ga-IE': 'ga-IE-OrlaNeural',
  'mt-MT': 'mt-MT-GraceNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'ja-JP': 'ja-JP-NanamiNeural',
  'th-TH': 'th-TH-PremwadeeNeural',
  'km-KH': 'km-KH-SreymomNeural',
  'id-ID': 'id-ID-GadisNeural',
  'vi-VN': 'vi-VN-HoaiMyNeural',
  'lo-LA': 'lo-LA-KeomanyNeural',
};

// ── Santé ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'makedoo-api', version: '2.0.0', tts: 'azure+google' });
});

// ── Compteur de visites ──────────────────────────────────────────
function readVisits() {
  try { return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')); }
  catch (e) { return { count: 0 }; }
}
function writeVisits(data) {
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(data)); } catch (e) {}
}

app.get('/visit', (req, res) => {
  const data = readVisits();
  data.count = (data.count || 0) + 1;
  data.lastVisit = new Date().toISOString();
  writeVisits(data);
  res.json({ count: data.count });
});

app.get('/visit/count', (req, res) => {
  res.json(readVisits());
});

// ── Message d'info éditable (écran d'accueil) ──────────────────────
app.get('/info-text', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    res.json({ text1: '', text2: '', text3: '', text4: '', text5: '', byLang: {}, updated: null });
  }
});

app.post('/info-text', async (req, res) => {
  try {
    const { text1 = '', text2 = '', text3 = '', text4 = '', text5 = '', pin = '', sourceLang = 'fr' } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) {
      return res.status(403).json({ error: 'PIN incorrect' });
    }
    const UI_LANGS = ['fr','en','mk','es','de','it','tr','sq','sr','bg','el','pt','ro','hu','pl','nl','ru'];
    const texts = [text1, text2, text3, text4, text5];
    const byLang = { [sourceLang]: { text1, text2, text3, text4, text5 } };

    // Traduction automatique vers toutes les langues d'interface
    const targets = UI_LANGS.filter(l => l !== sourceLang);
    await Promise.all(targets.map(async (target) => {
      try {
        const nonEmpty = texts.map((t, i) => ({ i, t })).filter(x => x.t.trim());
        if (!nonEmpty.length) { byLang[target] = { text1: '', text2: '', text3: '', text4: '', text5: '' }; return; }
        const response = await fetch(
          `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: nonEmpty.map(x => x.t), source: sourceLang, target, format: 'text' }) }
        );
        const data = await response.json();
        const translated = ['', '', '', '', ''];
        if (data.data?.translations) {
          nonEmpty.forEach((x, idx) => { translated[x.i] = data.data.translations[idx].translatedText; });
        }
        byLang[target] = { text1: translated[0], text2: translated[1], text3: translated[2], text4: translated[3], text5: translated[4] };
      } catch (e) {
        byLang[target] = { text1: '', text2: '', text3: '', text4: '', text5: '' };
      }
    }));

    const data = { byLang, sourceLang, updated: new Date().toISOString() };
    fs.writeFileSync(INFO_FILE, JSON.stringify(data));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Erreur sauvegarde' });
  }
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
async function azureTTS(text, languageCode, speakingRate, voiceOverride) {
  const voice = voiceOverride || AZURE_VOICES[languageCode] || 'en-US-JennyNeural';
  const rate = speakingRate < 1 ? '-10%' : '+0%';
  const ssml = `<speak version='1.0' xml:lang='${languageCode}'>
    <voice name='${voice}'>
      <silence type='leading' value='0ms'/>
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
    const { text, languageCode, speakingRate = 0.85, voice } = req.body;
    if (!text || !languageCode) return res.status(400).json({ error: 'Paramètres manquants' });

    // Langues Azure : MK, SQ, SR, BG, TR, EL + toutes si clé Azure dispo
    const azureLangs = ['mk-MK','sq-AL','sr-RS','bg-BG','tr-TR','el-GR'];
    let audioContent;

    if (AZURE_KEY && (voice || azureLangs.includes(languageCode) || AZURE_VOICES[languageCode])) {
      try {
        audioContent = await azureTTS(text, languageCode, speakingRate, voice);
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

// ── STT Azure ─────────────────────────────────────────────────
async function azureSTT(audioBase64, languageCode, contentType) {
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const url = `https://${AZURE_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${languageCode}&format=detailed`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_KEY,
      'Content-Type': contentType || 'audio/webm;codecs=opus',
      'Accept': 'application/json'
    },
    body: audioBuffer
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Azure STT error: ${response.status} — ${errBody.slice(0, 200)}`);
  }
  const data = await response.json();
  if (data.RecognitionStatus !== 'Success') throw new Error('Azure STT: ' + data.RecognitionStatus);
  const transcript = data.DisplayText || data.NBest?.[0]?.Display || data.NBest?.[0]?.Lexical || '';
  if (!transcript) throw new Error('Azure STT: empty transcript — raw: ' + JSON.stringify(data).slice(0, 300));
  return transcript;
}

// ── STT (Azure prioritaire pour certaines langues, sinon Google) ─
app.post('/stt', async (req, res) => {
  try {
    const { audio, languageCode, mimeType, encoding, sampleRateHertz = 48000 } = req.body;
    if (!audio || !languageCode) return res.status(400).json({ error: 'Paramètres manquants' });

    // Le conteneur WebM des navigateurs est encodé en Opus, avec ou sans la mention explicite
    const googleEncoding = encoding || 'WEBM_OPUS';
    const rawContentType = mimeType || 'audio/webm;codecs=opus';
    const azureContentType = rawContentType.replace(/;\s*codecs=/i, '; codecs=');

    // Langues où Azure STT est prioritaire (meilleure précision que Google pour ces langues)
    const azureSTTLangs = []; // Azure STT désactivé (incompatible avec l'audio WebM/Opus des navigateurs) — repli permanent sur Google

    let azureError = null;
    if (AZURE_KEY && azureSTTLangs.includes(languageCode)) {
      try {
        const transcript = await azureSTT(audio, languageCode, azureContentType);
        return res.json({ transcript, engine: 'azure' });
      } catch (e) {
        azureError = e.message;
        console.log('Azure STT fallback to Google:', e.message);
      }
    }

    const response = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { encoding: googleEncoding, sampleRateHertz, languageCode, enableAutomaticPunctuation: true, model: 'default' },
          audio: { content: audio }
        }) }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const transcript = data.results?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript, engine: 'google', azureError });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── Publication vers makedoo-library (GitHub) ──────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'morellmarc/makedoo-library';

app.get('/library-manifest', async (req, res) => {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/manifest.json?t=${Date.now()}`);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/publish-library', async (req, res) => {
  try {
    const { tier = 'gratuit', folder = '', filename = '', session = null, pin = '', newPack = null } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) {
      return res.status(403).json({ error: 'PIN incorrect' });
    }
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'GITHUB_TOKEN non configuré sur le serveur' });
    }
    if (!session || !folder || !filename) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }
    const safeFolder = folder.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const safeFile = filename.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const path = `${tier}/${safeFolder}/${safeFile}.json`;
    const content = Buffer.from(JSON.stringify(session, null, 2)).toString('base64');

    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

    // Vérifier si le fichier existe déjà (pour récupérer son sha et le mettre à jour proprement)
    let sha;
    try {
      const existing = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
      if (existing.ok) { const data = await existing.json(); sha = data.sha; }
    } catch (e) {}

    const body = { message: `Ajout session Makedoo : ${safeFile}`, content };
    if (sha) body.sha = sha;

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.message || 'Erreur GitHub' });

    // Si c'est un nouveau pack, l'enregistrer dans manifest.json pour qu'il apparaisse dans la bibliothèque
    let manifestWarning = null;
    if (newPack) {
      try {
        const manifestUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/manifest.json`;
        const manifestRes = await fetch(manifestUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
        if (!manifestRes.ok) {
          manifestWarning = `Lecture manifest.json échouée : ${manifestRes.status}`;
        } else {
          const manifestFile = await manifestRes.json();
          const manifestContent = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8'));
          const alreadyExists = manifestContent.packs.some(p => p.id === safeFolder);
          if (!alreadyExists) {
            manifestContent.packs.push({
              id: safeFolder,
              tier,
              name: newPack.name || safeFolder,
              description: newPack.description || '',
              langPair: newPack.langPair || '',
              path: `${tier}/${safeFolder}`
            });
            manifestContent.updated = new Date().toISOString().split('T')[0];
            const newManifestContent = Buffer.from(JSON.stringify(manifestContent, null, 2)).toString('base64');
            const manifestPutRes = await fetch(manifestUrl, {
              method: 'PUT',
              headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: `Nouveau pack : ${safeFolder}`, content: newManifestContent, sha: manifestFile.sha })
            });
            if (!manifestPutRes.ok) {
              const putErr = await manifestPutRes.json().catch(() => ({}));
              manifestWarning = `Écriture manifest.json échouée : ${putErr.message || manifestPutRes.status}`;
            }
          }
        }
      } catch (e) {
        manifestWarning = 'Erreur manifest.json : ' + e.message;
      }
    }

    res.json({ ok: true, path, url: data.content?.html_url, manifestWarning });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEBUG TEMPORAIRE — à retirer une fois le problème résolu ────
// ── Gestion bibliothèque : lister fichiers d'un pack ────────────
app.get('/library-pack-files', async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'path manquant' });
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
    const response = await fetch(url, { headers: GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } : {} });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.message || 'Erreur GitHub' });
    const files = Array.isArray(data) ? data.filter(f => f.name.endsWith('.json')).map(f => ({ name: f.name, sha: f.sha })) : [];
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

async function getManifest() {
  const manifestUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/manifest.json`;
  const manifestRes = await fetch(manifestUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (!manifestRes.ok) throw new Error('Lecture manifest.json échouée : ' + manifestRes.status);
  const manifestFile = await manifestRes.json();
  const manifestContent = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8'));
  return { manifestUrl, manifestContent, sha: manifestFile.sha };
}
async function putManifest(manifestUrl, manifestContent, sha, message) {
  manifestContent.updated = new Date().toISOString().split('T')[0];
  const newManifestContent = Buffer.from(JSON.stringify(manifestContent, null, 2)).toString('base64');
  const putRes = await fetch(manifestUrl, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: newManifestContent, sha })
  });
  if (!putRes.ok) { const err = await putRes.json().catch(() => ({})); throw new Error('Écriture manifest.json échouée : ' + (err.message || putRes.status)); }
}
async function deleteGithubFile(path, message) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const getRes = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (!getRes.ok) throw new Error('Fichier introuvable : ' + path);
  const fileData = await getRes.json();
  const delRes = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha: fileData.sha })
  });
  if (!delRes.ok) { const err = await delRes.json().catch(() => ({})); throw new Error('Suppression échouée : ' + (err.message || delRes.status)); }
}

// ── Renommer un pack (nom/description affichés) ─────────────────
app.post('/library-rename-pack', async (req, res) => {
  try {
    const { packId, name, description, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!packId) return res.status(400).json({ error: 'packId manquant' });
    const { manifestUrl, manifestContent, sha } = await getManifest();
    const pack = manifestContent.packs.find(p => p.id === packId);
    if (!pack) return res.status(404).json({ error: 'Pack introuvable' });
    if (name) pack.name = name;
    if (description !== undefined) pack.description = description;
    await putManifest(manifestUrl, manifestContent, sha, `Renommage pack : ${packId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── Supprimer un pack (manifest + tous ses fichiers) ─────────────
app.post('/library-delete-pack', async (req, res) => {
  try {
    const { packId, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!packId) return res.status(400).json({ error: 'packId manquant' });
    const { manifestUrl, manifestContent, sha } = await getManifest();
    const pack = manifestContent.packs.find(p => p.id === packId);
    if (!pack) return res.status(404).json({ error: 'Pack introuvable' });
    // Supprimer tous les fichiers du dossier
    const listUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${pack.path}`;
    const listRes = await fetch(listUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
    if (listRes.ok) {
      const filesList = await listRes.json();
      if (Array.isArray(filesList)) {
        for (const f of filesList) {
          await deleteGithubFile(`${pack.path}/${f.name}`, `Suppression pack : ${packId}`);
        }
      }
    }
    manifestContent.packs = manifestContent.packs.filter(p => p.id !== packId);
    await putManifest(manifestUrl, manifestContent, sha, `Suppression pack : ${packId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── Renommer un fichier JSON dans un pack ────────────────────────
app.post('/library-rename-file', async (req, res) => {
  try {
    const { path, newFilename, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!path || !newFilename) return res.status(400).json({ error: 'Paramètres manquants' });
    const safeFile = newFilename.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const folder = path.substring(0, path.lastIndexOf('/'));
    const newPath = `${folder}/${safeFile}.json`;
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
    if (!getRes.ok) return res.status(404).json({ error: 'Fichier introuvable' });
    const fileData = await getRes.json();
    const newUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${newPath}`;
    const createRes = await fetch(newUrl, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Renommage : ${path} → ${newPath}`, content: fileData.content })
    });
    if (!createRes.ok) { const err = await createRes.json().catch(() => ({})); return res.status(500).json({ error: err.message || 'Erreur création' }); }
    await deleteGithubFile(path, `Renommage (ancien fichier) : ${path}`);
    res.json({ ok: true, newPath });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── Supprimer un fichier JSON dans un pack ───────────────────────
app.post('/library-delete-file', async (req, res) => {
  try {
    const { path, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!path) return res.status(400).json({ error: 'path manquant' });
    await deleteGithubFile(path, `Suppression fichier : ${path}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.get('/debug-github-token', (req, res) => {
  res.json({
    present: !!GITHUB_TOKEN,
    length: GITHUB_TOKEN ? GITHUB_TOKEN.length : 0,
    startsCorrectly: GITHUB_TOKEN ? GITHUB_TOKEN.startsWith('github_pat_') : false
  });
});

app.listen(PORT, () => console.log(`✅ Makedoo API v2 sur port ${PORT}`));
