const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
console.log('DEBUG DATABASE_URL présent ?', !!process.env.DATABASE_URL, 'longueur:', (process.env.DATABASE_URL || '').length);
const { Pool } = require('pg');
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-06-24.dahlia' }) : null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();
app.use(cors());

// ── Webhook Stripe : nécessite le corps brut (non parsé en JSON) pour vérifier la signature — doit être déclaré AVANT express.json() ──
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe non configuré');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Erreur de signature webhook : ${e.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      if (pool && userId) {
        await pool.query(
          'UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, subscription_status = $3 WHERE id = $4',
          [customerId, subscriptionId, 'active', userId]
        );
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const status = subscription.status === 'active' ? 'active' : (event.type === 'customer.subscription.deleted' ? 'cancelled' : subscription.status);
      const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
      if (pool) {
        await pool.query(
          'UPDATE users SET subscription_status = $1, subscription_current_period_end = $2 WHERE stripe_subscription_id = $3',
          [status, periodEnd, subscription.id]
        );
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Erreur traitement webhook Stripe:', e.message);
    res.status(500).send('Erreur serveur');
  }
});

app.use(express.json({ limit: '10mb' }));

const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = 'northeurope';
const PORT = process.env.PORT || 3000;

const DATA_DIR = '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const COUNTER_FILE = path.join(DATA_DIR, 'visits.json');
const INFO_FILE = path.join(DATA_DIR, 'info-text.json');

// ── Comptes utilisateurs : base de données, email, sessions ─────
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const JWT_SECRET = process.env.JWT_SECRET || 'makedoo-dev-secret-a-changer';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Makedoo <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://morellmarc.github.io/makedoo-v3';

// ── Essai gratuit paramétrable ────────────────────────────────
// Nombre de jours d'accès complet offerts à partir de la création du compte.
// Modifiable à tout moment via la variable Railway TRIAL_DAYS (ex: 14), sans toucher au code.
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);
function computeAccess(user) {
  const trialEnd = new Date(new Date(user.created_at).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const inTrial = new Date() < trialEnd;
  const subscribed = user.subscription_status === 'active';
  return {
    hasAccess: subscribed || inTrial,
    trialEndsAt: trialEnd.toISOString(),
    inTrial: inTrial && !subscribed
  };
}

async function initDb() {
  if (!pool) { console.log('⚠️ DATABASE_URL non configuré — comptes utilisateurs désactivés'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        subscription_status TEXT DEFAULT 'none',
        subscription_current_period_end TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS magic_tokens (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Base de données initialisée');
  } catch (e) {
    console.error('Erreur initialisation DB:', e.message);
  }
}
initDb();

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session invalide ou expirée' });
  }
}

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

// ── Info publique sur la durée d'essai gratuit (affichée avant connexion) ──
app.get('/trial-info', (req, res) => {
  res.json({ trialDays: TRIAL_DAYS });
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
    const { text = '', pin = '', sourceLang = 'fr' } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) {
      return res.status(403).json({ error: 'PIN incorrect' });
    }
    const UI_LANGS = ['fr','en','mk','es','de','it','tr','sq','sr','bg','el','pt','ro','hu','pl','nl','ru'];
    const lines = text.split('\n');
    const byLang = { [sourceLang]: { text } };

    // Traduction automatique vers toutes les langues d'interface, ligne par ligne (préserve les sauts de paragraphe)
    const targets = UI_LANGS.filter(l => l !== sourceLang);
    await Promise.all(targets.map(async (target) => {
      try {
        const nonEmpty = lines.map((l, i) => ({ i, l })).filter(x => x.l.trim());
        if (!nonEmpty.length) { byLang[target] = { text: '' }; return; }
        const response = await fetch(
          `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: nonEmpty.map(x => x.l), source: sourceLang, target, format: 'text' }) }
        );
        const data = await response.json();
        const translatedLines = [...lines];
        if (data.data?.translations) {
          nonEmpty.forEach((x, idx) => { translatedLines[x.i] = data.data.translations[idx].translatedText; });
        }
        byLang[target] = { text: translatedLines.join('\n') };
      } catch (e) {
        byLang[target] = { text: '' };
      }
    }));

    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8')); } catch (e) {}
    const data = { byLang, sourceLang, updated: new Date().toISOString(), youtubeLinks: existing.youtubeLinks || {} };
    fs.writeFileSync(INFO_FILE, JSON.stringify(data));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Erreur sauvegarde' });
  }
});

app.post('/info-youtube-link', (req, res) => {
  try {
    const { lang = '', url = '', pin = '' } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) {
      return res.status(403).json({ error: 'PIN incorrect' });
    }
    const UI_LANGS = ['fr','en','mk','es','de','it','tr','sq','sr','bg','el','pt','ro','hu','pl','nl','ru'];
    if (!UI_LANGS.includes(lang)) return res.status(400).json({ error: 'Langue invalide' });
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Le lien doit être une URL valide (http/https)' });
    let data = { byLang: {}, sourceLang: 'fr', updated: '' };
    try { data = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8')); } catch (e) {}
    if (!data.youtubeLinks) data.youtubeLinks = {};
    if (url.trim()) { data.youtubeLinks[lang] = url.trim(); } else { delete data.youtubeLinks[lang]; }
    fs.writeFileSync(INFO_FILE, JSON.stringify(data));
    res.json({ ok: true, youtubeLinks: data.youtubeLinks });
  } catch (e) {
    res.status(500).json({ error: 'Erreur sauvegarde' });
  }
});

// ── Authentification par lien magique ────────────────────────────
app.post('/auth/request-link', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Comptes utilisateurs non disponibles' });
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await pool.query(
      'INSERT INTO magic_tokens (token, email, expires_at) VALUES ($1, $2, $3)',
      [token, normalizedEmail, expiresAt]
    );
    const link = `${APP_URL}/?authtoken=${token}`;
    if (resend) {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: normalizedEmail,
        subject: 'Votre lien de connexion Makedoo',
        html: `<p>Bonjour,</p><p>Cliquez sur ce lien pour vous connecter à Makedoo (valable 15 minutes) :</p><p><a href="${link}">${link}</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`
      });
    } else {
      console.log('⚠️ RESEND_API_KEY non configuré — lien (dev only):', link);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/verify', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Comptes utilisateurs non disponibles' });
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Lien invalide' });
    const result = await pool.query('SELECT * FROM magic_tokens WHERE token = $1', [token]);
    const record = result.rows[0];
    if (!record) return res.status(400).json({ error: 'Lien invalide' });
    if (record.used) return res.status(400).json({ error: 'Ce lien a déjà été utilisé' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Ce lien a expiré' });
    await pool.query('UPDATE magic_tokens SET used = TRUE WHERE token = $1', [token]);

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [record.email]);
    let user = userResult.rows[0];
    if (!user) {
      const insertResult = await pool.query('INSERT INTO users (email) VALUES ($1) RETURNING *', [record.email]);
      user = insertResult.rows[0];
    }
    const jwtToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' });
    const access = computeAccess(user);
    res.json({
      ok: true,
      jwt: jwtToken,
      email: user.email,
      subscriptionStatus: user.subscription_status,
      ...access
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT email, created_at, subscription_status, subscription_current_period_end FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const access = computeAccess(user);
    res.json({
      email: user.email,
      subscriptionStatus: user.subscription_status,
      subscriptionEnd: user.subscription_current_period_end,
      ...access
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Paiement Stripe ────────────────────────────────────────────
app.post('/create-checkout-session', requireAuth, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) return res.status(503).json({ error: 'Paiement non configuré' });
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: String(user.id),
      success_url: `${APP_URL}/?subscription=success`,
      cancel_url: `${APP_URL}/?subscription=cancelled`,
    };
    if (user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
    } else {
      sessionParams.customer_email = user.email;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/create-portal-session', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Paiement non configuré' });
  try {
    const userResult = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user || !user.stripe_customer_id) return res.status(400).json({ error: 'Aucun abonnement associé' });
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${APP_URL}/`,
    });
    res.json({ url: portalSession.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  const url = `https://${AZURE_REGION}.stt.speech.microsoft.com/speech/recognition/interactive/cognitiveservices/v1?language=${languageCode}&format=detailed`;
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
    const azureSTTLangs = []; // Azure STT abandonné pour le MK (échecs répétés, incompatibilité confirmée) — Google seul

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

// ── Créer un pack vide (sans publier de session) ─────────────────
app.post('/library-create-pack', async (req, res) => {
  try {
    const { id, tier = 'gratuit', name, description = '', langPair = '', pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!id || !name) return res.status(400).json({ error: 'Identifiant et nom requis' });
    const safeId = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeId) return res.status(400).json({ error: 'Identifiant invalide' });
    const { manifestUrl, manifestContent, sha } = await getManifest();
    if (manifestContent.packs.some(p => p.id === safeId)) return res.status(400).json({ error: 'Ce pack existe déjà' });
    manifestContent.packs.push({ id: safeId, tier, name, description, langPair, path: `${tier}/${safeId}` });
    await putManifest(manifestUrl, manifestContent, sha, `Nouveau pack : ${safeId}`);
    res.json({ ok: true, id: safeId });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

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

// ── Audiothèque Makedoo (fichiers MP3 déjà existants) ────────────
app.get('/audio-manifest', async (req, res) => {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/audio-manifest.json?t=${Date.now()}`);
    if (!response.ok) return res.json({ version: '1.0', updated: null, tracks: [] });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.json({ version: '1.0', updated: null, tracks: [] });
  }
});

app.post('/publish-audio', async (req, res) => {
  try {
    const { title = '', lang = 'fr', type = 'livre', category = '', url = '', pin = '' } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré sur le serveur' });
    if (!title || !url || !category) return res.status(400).json({ error: 'Paramètres manquants (titre, catégorie, lien)' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Le lien doit être une URL valide (http/https)' });

    const safeCategory = category.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const safeTitleSlug = title.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const trackId = `${safeCategory}-${safeTitleSlug}-${lang}`;

    // Mise à jour du catalogue audio-manifest.json (le fichier lui-même reste hébergé sur pCloud)
    const manifestUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/audio-manifest.json`;
    let manifestContent = { version: '1.0', updated: '', categories: [], tracks: [] };
    let manifestSha;
    try {
      const manifestRes = await fetch(manifestUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
      if (manifestRes.ok) {
        const manifestFile = await manifestRes.json();
        manifestContent = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8'));
        manifestSha = manifestFile.sha;
      }
    } catch (e) {}
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    if (!manifestContent.categories.includes(safeCategory)) manifestContent.categories.push(safeCategory);
    manifestContent.tracks = manifestContent.tracks.filter(tr => tr.id !== trackId);
    manifestContent.tracks.push({ id: trackId, title, lang, type, category: safeCategory, url });
    manifestContent.updated = new Date().toISOString().split('T')[0];
    const newManifestB64 = Buffer.from(JSON.stringify(manifestContent, null, 2)).toString('base64');
    const manifestPutBody = { message: `Catalogue audio : ${title}`, content: newManifestB64 };
    if (manifestSha) manifestPutBody.sha = manifestSha;
    const manifestPutRes = await fetch(manifestUrl, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestPutBody)
    });
    if (!manifestPutRes.ok) {
      const err = await manifestPutRes.json().catch(() => ({}));
      return res.status(500).json({ error: err.message || 'Erreur mise à jour catalogue' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/audio-categories', async (req, res) => {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/audio-manifest.json?t=${Date.now()}`);
    if (!response.ok) return res.json({ categories: [] });
    const data = await response.json();
    let categories = Array.isArray(data.categories) ? data.categories.slice() : [];
    const fromTracks = (data.tracks || []).map(t => t.category);
    fromTracks.forEach(c => { if (c && !categories.includes(c)) categories.push(c); });
    categories.sort();
    res.json({ categories });
  } catch (e) {
    res.json({ categories: [] });
  }
});

app.post('/audio-category-create', async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom manquant' });
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
    const { manifestUrl, manifestContent, sha } = await getAudioManifest();
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    if (manifestContent.categories.includes(safeName)) return res.status(400).json({ error: 'Catégorie déjà existante' });
    manifestContent.categories.push(safeName);
    await putAudioManifest(manifestUrl, manifestContent, sha, `Nouvelle catégorie audio : ${safeName}`);
    res.json({ ok: true, category: safeName });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/audio-category-rename', async (req, res) => {
  try {
    const { oldName, newName, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!oldName || !newName || !newName.trim()) return res.status(400).json({ error: 'Paramètres manquants' });
    const safeNew = newName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeNew) return res.status(400).json({ error: 'Nom invalide' });
    const { manifestUrl, manifestContent, sha } = await getAudioManifest();
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    if (safeNew !== oldName && manifestContent.categories.includes(safeNew)) return res.status(400).json({ error: 'Catégorie déjà existante' });
    manifestContent.categories = manifestContent.categories.filter(c => c !== oldName);
    manifestContent.categories.push(safeNew);
    manifestContent.tracks.forEach(t => { if (t.category === oldName) t.category = safeNew; });
    await putAudioManifest(manifestUrl, manifestContent, sha, `Renommage catégorie audio : ${oldName} → ${safeNew}`);
    res.json({ ok: true, category: safeNew });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/audio-category-delete', async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!name) return res.status(400).json({ error: 'Nom manquant' });
    const { manifestUrl, manifestContent, sha } = await getAudioManifest();
    const inUse = manifestContent.tracks.some(t => t.category === name);
    if (inUse) return res.status(400).json({ error: 'Catégorie non vide — impossible à supprimer' });
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    manifestContent.categories = manifestContent.categories.filter(c => c !== name);
    await putAudioManifest(manifestUrl, manifestContent, sha, `Suppression catégorie audio : ${name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

async function getAudioManifest() {
  const manifestUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/audio-manifest.json`;
  const manifestRes = await fetch(manifestUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (!manifestRes.ok) throw new Error('Lecture audio-manifest.json échouée : ' + manifestRes.status);
  const manifestFile = await manifestRes.json();
  const manifestContent = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8'));
  return { manifestUrl, manifestContent, sha: manifestFile.sha };
}
async function putAudioManifest(manifestUrl, manifestContent, sha, message) {
  manifestContent.updated = new Date().toISOString().split('T')[0];
  const newContent = Buffer.from(JSON.stringify(manifestContent, null, 2)).toString('base64');
  const putRes = await fetch(manifestUrl, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: newContent, sha })
  });
  if (!putRes.ok) { const err = await putRes.json().catch(() => ({})); throw new Error('Écriture audio-manifest.json échouée : ' + (err.message || putRes.status)); }
}

app.post('/audio-delete', async (req, res) => {
  try {
    const { trackId, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!trackId) return res.status(400).json({ error: 'trackId manquant' });
    const { manifestUrl, manifestContent, sha } = await getAudioManifest();
    manifestContent.tracks = manifestContent.tracks.filter(t => t.id !== trackId);
    await putAudioManifest(manifestUrl, manifestContent, sha, `Suppression audio : ${trackId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/audio-rename', async (req, res) => {
  try {
    const { trackId, title, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!trackId || !title) return res.status(400).json({ error: 'Paramètres manquants' });
    const { manifestUrl, manifestContent, sha } = await getAudioManifest();
    const track = manifestContent.tracks.find(t => t.id === trackId);
    if (!track) return res.status(404).json({ error: 'Piste introuvable' });
    track.title = title;
    await putAudioManifest(manifestUrl, manifestContent, sha, `Renommage audio : ${trackId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/verify-admin-pin', (req, res) => {
  const { pin } = req.body;
  res.json({ ok: pin === (process.env.INFO_PIN || 'makohrid') });
});

// ── Bibliothèque de livres PDF (déjà hébergés sur pCloud) ────────
app.get('/pdf-manifest', async (req, res) => {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/pdf-manifest.json?t=${Date.now()}`);
    if (!response.ok) return res.json({ version: '1.0', updated: null, books: [] });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.json({ version: '1.0', updated: null, books: [] });
  }
});

app.post('/publish-pdf', async (req, res) => {
  try {
    const { title = '', lang = 'fr', type = 'livre', category = '', url = '', pin = '' } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré sur le serveur' });
    if (!title || !url || !category) return res.status(400).json({ error: 'Paramètres manquants (titre, catégorie, lien)' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Le lien doit être une URL valide (http/https)' });

    const safeCategory = category.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const safeTitleSlug = title.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const bookId = `${safeCategory}-${safeTitleSlug}-${lang}`;

    const manifestUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/pdf-manifest.json`;
    let manifestContent = { version: '1.0', updated: '', categories: [], books: [] };
    let manifestSha;
    try {
      const manifestRes = await fetch(manifestUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
      if (manifestRes.ok) {
        const manifestFile = await manifestRes.json();
        manifestContent = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8'));
        manifestSha = manifestFile.sha;
      }
    } catch (e) {}
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    if (!manifestContent.categories.includes(safeCategory)) manifestContent.categories.push(safeCategory);
    manifestContent.books = manifestContent.books.filter(b => b.id !== bookId);
    manifestContent.books.push({ id: bookId, title, lang, type, category: safeCategory, url });
    manifestContent.updated = new Date().toISOString().split('T')[0];
    const newManifestB64 = Buffer.from(JSON.stringify(manifestContent, null, 2)).toString('base64');
    const manifestPutBody = { message: `Catalogue PDF : ${title}`, content: newManifestB64 };
    if (manifestSha) manifestPutBody.sha = manifestSha;
    const manifestPutRes = await fetch(manifestUrl, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(manifestPutBody)
    });
    if (!manifestPutRes.ok) {
      const err = await manifestPutRes.json().catch(() => ({}));
      return res.status(500).json({ error: err.message || 'Erreur mise à jour catalogue' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getPdfManifest() {
  const manifestUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/pdf-manifest.json`;
  const manifestRes = await fetch(manifestUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } });
  if (!manifestRes.ok) throw new Error('Lecture pdf-manifest.json échouée : ' + manifestRes.status);
  const manifestFile = await manifestRes.json();
  const manifestContent = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8'));
  return { manifestUrl, manifestContent, sha: manifestFile.sha };
}
async function putPdfManifest(manifestUrl, manifestContent, sha, message) {
  manifestContent.updated = new Date().toISOString().split('T')[0];
  const newContent = Buffer.from(JSON.stringify(manifestContent, null, 2)).toString('base64');
  const putRes = await fetch(manifestUrl, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: newContent, sha })
  });
  if (!putRes.ok) { const err = await putRes.json().catch(() => ({})); throw new Error('Écriture pdf-manifest.json échouée : ' + (err.message || putRes.status)); }
}

app.get('/pdf-categories', async (req, res) => {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/pdf-manifest.json?t=${Date.now()}`);
    if (!response.ok) return res.json({ categories: [] });
    const data = await response.json();
    let categories = Array.isArray(data.categories) ? data.categories.slice() : [];
    const fromBooks = (data.books || []).map(b => b.category);
    fromBooks.forEach(c => { if (c && !categories.includes(c)) categories.push(c); });
    categories.sort();
    res.json({ categories });
  } catch (e) {
    res.json({ categories: [] });
  }
});

app.post('/pdf-category-create', async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom manquant' });
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeName) return res.status(400).json({ error: 'Nom invalide' });
    const { manifestUrl, manifestContent, sha } = await getPdfManifest();
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    if (manifestContent.categories.includes(safeName)) return res.status(400).json({ error: 'Catégorie déjà existante' });
    manifestContent.categories.push(safeName);
    await putPdfManifest(manifestUrl, manifestContent, sha, `Nouvelle catégorie PDF : ${safeName}`);
    res.json({ ok: true, category: safeName });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/pdf-category-rename', async (req, res) => {
  try {
    const { oldName, newName, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!oldName || !newName || !newName.trim()) return res.status(400).json({ error: 'Paramètres manquants' });
    const safeNew = newName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeNew) return res.status(400).json({ error: 'Nom invalide' });
    const { manifestUrl, manifestContent, sha } = await getPdfManifest();
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    if (safeNew !== oldName && manifestContent.categories.includes(safeNew)) return res.status(400).json({ error: 'Catégorie déjà existante' });
    manifestContent.categories = manifestContent.categories.filter(c => c !== oldName);
    manifestContent.categories.push(safeNew);
    manifestContent.books.forEach(b => { if (b.category === oldName) b.category = safeNew; });
    await putPdfManifest(manifestUrl, manifestContent, sha, `Renommage catégorie PDF : ${oldName} → ${safeNew}`);
    res.json({ ok: true, category: safeNew });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/pdf-category-delete', async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!name) return res.status(400).json({ error: 'Nom manquant' });
    const { manifestUrl, manifestContent, sha } = await getPdfManifest();
    const inUse = manifestContent.books.some(b => b.category === name);
    if (inUse) return res.status(400).json({ error: 'Catégorie non vide — impossible à supprimer' });
    if (!Array.isArray(manifestContent.categories)) manifestContent.categories = [];
    manifestContent.categories = manifestContent.categories.filter(c => c !== name);
    await putPdfManifest(manifestUrl, manifestContent, sha, `Suppression catégorie PDF : ${name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/pdf-delete', async (req, res) => {
  try {
    const { bookId, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!bookId) return res.status(400).json({ error: 'bookId manquant' });
    const { manifestUrl, manifestContent, sha } = await getPdfManifest();
    manifestContent.books = manifestContent.books.filter(b => b.id !== bookId);
    await putPdfManifest(manifestUrl, manifestContent, sha, `Suppression PDF : ${bookId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.post('/pdf-rename', async (req, res) => {
  try {
    const { bookId, title, pin } = req.body;
    if (pin !== (process.env.INFO_PIN || 'makohrid')) return res.status(403).json({ error: 'PIN incorrect' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN non configuré' });
    if (!bookId || !title) return res.status(400).json({ error: 'Paramètres manquants' });
    const { manifestUrl, manifestContent, sha } = await getPdfManifest();
    const book = manifestContent.books.find(b => b.id === bookId);
    if (!book) return res.status(404).json({ error: 'Livre introuvable' });
    book.title = title;
    await putPdfManifest(manifestUrl, manifestContent, sha, `Renommage PDF : ${bookId}`);
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
