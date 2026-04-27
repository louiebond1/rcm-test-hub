require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const path = require('path');
const twilio = require('twilio');
const fs = require('fs');
const https = require('https');
const os = require('os');

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
const LOG_FILE = path.join(LOGS_DIR, 'whatsapp.jsonl');
const WEB_LOG_FILE = path.join(LOGS_DIR, 'web.jsonl');
const THREADS_FILE = path.join(LOGS_DIR, 'threads.json');
const FEEDBACK_FILE = path.join(LOGS_DIR, 'feedback.jsonl');

// Upstash Redis persistence — falls back to local files if not configured
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/${args.map(a => encodeURIComponent(a)).join('/')}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    return await res.json();
  } catch { return null; }
}

async function persistLog(key, entry) {
  await redisCmd('rpush', key, JSON.stringify(entry));
}

async function readPersistedLogs(key) {
  const res = await redisCmd('lrange', key, '0', '-1');
  if (!res || !Array.isArray(res.result)) return null;
  return res.result.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const redisEnabled = () => !!(UPSTASH_URL && UPSTASH_TOKEN);

function getUserData(phone) {
  if (!fs.existsSync(THREADS_FILE)) return null;
  const threads = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
  return threads[phone] || null;
}

function getUserThread(phone) {
  const d = getUserData(phone);
  if (!d) return null;
  return typeof d === 'string' ? d : d.threadId;
}

function saveUserThread(phone, threadId, system) {
  const threads = fs.existsSync(THREADS_FILE)
    ? JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'))
    : {};
  const prev = threads[phone] || {};
  threads[phone] = {
    threadId,
    system: system || (typeof prev === 'object' ? prev.system : null),
  };
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

async function downloadAudio(url, destPath) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Failed to download audio: ${res.status}`);
  const buffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

async function transcribeAudio(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1',
  });
  return transcription.text;
}
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function logMessage(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  persistLog('logs:whatsapp', entry).catch(() => {});
}

function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function logWebMessage(entry) {
  fs.appendFileSync(WEB_LOG_FILE, JSON.stringify(entry) + '\n');
  persistLog('logs:web', entry).catch(() => {});
}

function readWebLogs() {
  if (!fs.existsSync(WEB_LOG_FILE)) return [];
  return fs.readFileSync(WEB_LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const app = express();
const PORT = process.env.PORT || 3001;
const ANALYTICS_PASSWORD = process.env.ANALYTICS_PASSWORD || '4416';

function requirePassword(req, res, next) {
  const token = req.cookies?.analytics_auth;
  if (token === ANALYTICS_PASSWORD) return next();

  if (req.method === 'POST' && req.body?.password === ANALYTICS_PASSWORD) {
    res.setHeader('Set-Cookie', `analytics_auth=${ANALYTICS_PASSWORD}; Path=/; HttpOnly`);
    return res.redirect(req.path);
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Analytics &mdash; Login</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9f9f9; }
    .box { background: white; padding: 2rem 2.5rem; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.1); text-align: center; }
    h2 { margin-top: 0; color: #333; }
    input { padding: .6rem 1rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; width: 180px; margin-bottom: 1rem; text-align: center; letter-spacing: .2rem; }
    button { display: block; width: 100%; padding: .6rem; background: #4a90e2; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    .error { color: red; font-size: .85rem; margin-bottom: .5rem; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Analytics</h2>
    ${req.method === 'POST' ? '<p class="error">Incorrect password</p>' : ''}
    <form method="post">
      <input type="password" name="password" placeholder="Password" autofocus />
      <button type="submit">Enter</button>
    </form>
  </div>
</body>
</html>`);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CONSULTANT_PIN = '1703';
function requireConsultantPin(req, res, next) {
  if (req.cookies?.consultant_auth === CONSULTANT_PIN) return next();
  if (req.method === 'POST' && req.body?.pin === CONSULTANT_PIN) {
    res.setHeader('Set-Cookie', `consultant_auth=${CONSULTANT_PIN}; Path=/; HttpOnly`);
    return res.redirect(req.path);
  }
  res.send(`<!DOCTYPE html><html><head><title>Consultant Access</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .box{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px;text-align:center;width:320px}
    .logo{font-size:13px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#6366f1;margin-bottom:24px}
    h2{color:#f1f5f9;font-size:18px;font-weight:600;margin-bottom:8px}
    p{color:#64748b;font-size:13px;margin-bottom:28px}
    .keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    .key{background:#0f172a;border:1px solid #334155;border-radius:10px;color:#e2e8f0;font-size:18px;font-weight:500;padding:16px;cursor:pointer;transition:all .15s}
    .key:hover{background:#334155;border-color:#6366f1}
    .key:active{transform:scale(.95)}
    .display{background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px;margin-bottom:20px;letter-spacing:.5em;font-size:22px;color:#f1f5f9;min-height:52px}
    .btn-enter{width:100%;background:#6366f1;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;padding:14px;cursor:pointer;transition:background .15s}
    .btn-enter:hover{background:#4f46e5}
    .error{color:#f87171;font-size:12px;margin-top:12px}
  </style>
</head><body>
  <div class="box">
    <div class="logo">EX3 Consultant</div>
    <h2>Secure Access</h2>
    <p>Enter your consultant PIN to continue</p>
    <div class="display" id="disp">&#8203;</div>
    <div class="keypad">
      ${[1,2,3,4,5,6,7,8,9,'⌫',0,'✓'].map(k=>`<button class="key" onclick="press('${k}')">${k}</button>`).join('')}
    </div>
    ${req.method==='POST'?'<div class="error">Incorrect PIN — try again</div>':''}
    <form method="post" id="f"><input type="hidden" name="pin" id="pin-inp"></form>
  </div>
  <script>
    let v='';
    function press(k){
      if(k==='⌫'){v=v.slice(0,-1);}
      else if(k==='✓'){if(v.length===4){document.getElementById('pin-inp').value=v;document.getElementById('f').submit();}}
      else if(v.length<4){v+=k;}
      document.getElementById('disp').textContent=v?'● '.repeat(v.length).trim():'';
    }
    document.addEventListener('keydown',e=>{
      if(e.key>='0'&&e.key<='9')press(e.key);
      else if(e.key==='Backspace')press('⌫');
      else if(e.key==='Enter')press('✓');
    });
  </script>
</body></html>`);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const cookie = req.headers.cookie || '';
  req.cookies = Object.fromEntries(cookie.split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(([k]) => k));
  next();
});
app.use((req, res, next) => { res.setHeader('ngrok-skip-browser-warning', '1'); next(); });
app.use(express.static(path.join(__dirname)));

const ttsCache = {};
app.get('/api/tts', async (req, res) => {
  const text = (req.query.text || '').trim();
  const stressed = req.query.stressed === '1';
  if (!text) return res.status(400).end();
  const cacheKey = (stressed ? 'stressed:' : '') + text;
  try {
    if (!ttsCache[cacheKey]) {
      if (process.env.ELEVENLABS_API_KEY) {
        const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const voiceSettings = stressed
          ? { stability: 0.22, similarity_boost: 0.78, style: 0.65, use_speaker_boost: true }
          : { stability: 0.42, similarity_boost: 0.82, style: 0.18, use_speaker_boost: true };
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: voiceSettings })
        });
        if (!elRes.ok) {
          const errBody = await elRes.text().catch(()=>'');
          console.error('ElevenLabs ' + elRes.status + ':', errBody.slice(0,200), '&mdash; falling back to OpenAI');
          const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice: stressed ? 'echo' : 'nova', input: text, speed: stressed ? 1.05 : 0.92 });
          ttsCache[cacheKey] = Buffer.from(await mp3.arrayBuffer());
        } else {
          ttsCache[cacheKey] = Buffer.from(await elRes.arrayBuffer());
        }
      } else {
        const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice: stressed ? 'echo' : 'nova', input: text, speed: stressed ? 1.05 : 0.92 });
        ttsCache[cacheKey] = Buffer.from(await mp3.arrayBuffer());
      }
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(ttsCache[cacheKey]);
  } catch(e) {
    console.error('TTS error:', e.message);
    res.status(500).end();
  }
});

app.post('/api/ask', async (req, res) => {
  const { question, threadId } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  if (!process.env.ASSISTANT_ID) {
    return res.status(500).json({ error: 'Assistant not configured. Run: node setup.js' });
  }

  const start = Date.now();
  try {
    // Reuse existing thread for conversation memory, or create a new one
    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
    }

    // Add the user's question, appending a follow-up request
    const messageContent = `${question.trim()}

(After your answer, on a new line write exactly: FOLLOWUPS: [question 1] | [question 2] | [question 3] &mdash; 3 short follow-up questions the user might ask next.)`;

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: messageContent,
    });

    // Run the assistant
    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // Poll until complete (with 30s timeout)
    while (run.status === 'in_progress' || run.status === 'queued') {
      if (Date.now() - start > 30000) throw new Error('Request timed out.');
      await new Promise(r => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (run.status !== 'completed') {
      console.error('Run failed details:', JSON.stringify(run.last_error));
      throw new Error(`Unexpected run status: ${run.status}${run.last_error ? ' &mdash; ' + run.last_error.message : ''}`);
    }

    // Get the assistant's reply
    const messages = await openai.beta.threads.messages.list(thread.id);
    const raw = messages.data[0]?.content[0]?.text?.value || '';

    // Strip citation markers like [4:1u{2020}source]
    const cleaned = raw.replace(/\u3010[^\u3011]*\u3011/g, '').trim();

    if (!cleaned) throw new Error('No answer returned.');

    // Parse follow-up questions out of the response
    const followupMatch = cleaned.match(/FOLLOWUPS:\s*(.+)$/m);
    let followUps = [];
    let answer = cleaned;
    if (followupMatch) {
      followUps = followupMatch[1]
        .split('|')
        .map(q => q.trim().replace(/^\[|\]$/g, '').trim())
        .filter(Boolean)
        .slice(0, 3);
      answer = cleaned.replace(/FOLLOWUPS:.*$/m, '').trim();
    }

    logWebMessage({
      ts: new Date().toISOString(),
      threadId: thread.id,
      question: question.trim(),
      answer,
      ms: Date.now() - start,
      success: true,
      uncertain: isUncertain(answer),
    });

    res.json({ answer, threadId: thread.id, followUps });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    logWebMessage({
      ts: new Date().toISOString(),
      threadId: threadId || null,
      question: question.trim(),
      answer: '',
      ms: 0,
      success: false,
      uncertain: false,
    });
    res.status(500).json({ error: 'AI service error.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Feedback endpoint
app.post('/api/feedback', express.json(), (req, res) => {
  const { question, answer, rating, threadId } = req.body;
  if (!rating || !question) return res.status(400).json({ error: 'Missing fields' });
  const entry = { ts: new Date().toISOString(), threadId: threadId || null, question, answer, rating };
  fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
  persistLog('logs:feedback', entry).catch(() => {});
  res.json({ ok: true });
});

// Feedback review page
app.all('/analytics/feedback', requirePassword);
app.get('/analytics/feedback', (req, res) => {
  const lines = fs.existsSync(FEEDBACK_FILE) ? fs.readFileSync(FEEDBACK_FILE, 'utf8').trim().split('\n').filter(Boolean) : [];
  const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const showAll = req.query.filter === 'all';
  const entries = showAll ? all : all.filter(e => e.rating === 'down');
  const downCount = all.filter(e => e.rating === 'down').length;
  const upCount = all.filter(e => e.rating === 'up').length;
  const rows = entries.slice().reverse().map(e => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:10px 8px;font-size:12px;color:#888;white-space:nowrap">${e.ts.replace('T',' ').slice(0,19)}</td>
      <td style="padding:10px 8px;font-size:13px">${escHtml(e.question)}</td>
      <td style="padding:10px 8px;font-size:13px;color:#444">${escHtml(e.answer || '').slice(0,300)}${(e.answer||'').length>300?'…':''}</td>
      <td style="padding:10px 8px;text-align:center;font-size:18px">${e.rating==='up'?'👍':'👎'}</td>
    </tr>`).join('');
  res.send(`<!DOCTYPE html><html><head><title>AI Feedback</title>
  <style>body{font-family:system-ui,sans-serif;margin:0;background:#f8f9fa}
  .header{background:#1e293b;color:#fff;padding:16px 24px;display:flex;align-items:center;gap:24px}
  .header a{color:#94a3b8;text-decoration:none;font-size:14px}
  .header a:hover{color:#fff}
  .stats{display:flex;gap:16px;padding:20px 24px}
  .stat{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 24px;text-align:center}
  .stat-num{font-size:28px;font-weight:700}
  .stat-lbl{font-size:12px;color:#64748b;margin-top:4px}
  .up .stat-num{color:#16a34a} .down .stat-num{color:#dc2626}
  .filter{padding:0 24px 12px;display:flex;gap:8px}
  .filter a{padding:6px 14px;border-radius:6px;font-size:13px;text-decoration:none;border:1px solid #e2e8f0;color:#334155}
  .filter a.active{background:#1e293b;color:#fff;border-color:#1e293b}
  table{width:calc(100% - 48px);margin:0 24px 40px;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th{background:#f1f5f9;padding:10px 8px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  tr:hover{background:#f8fafc}</style></head><body>
  <div class="header">
    <span style="font-weight:700;font-size:16px">AI Feedback</span>
    <a href="/analytics">WhatsApp Analytics</a>
    <a href="/analytics/web">Web Chat</a>
    <a href="/analytics/feedback" style="color:#fff;border-bottom:2px solid #6366f1">Feedback</a>
  </div>
  <div class="stats">
    <div class="stat up"><div class="stat-num">${upCount}</div><div class="stat-lbl">👍 Helpful</div></div>
    <div class="stat down"><div class="stat-num">${downCount}</div><div class="stat-lbl">👎 Needs Review</div></div>
    <div class="stat"><div class="stat-num">${all.length}</div><div class="stat-lbl">Total Ratings</div></div>
  </div>
  <div class="filter">
    <a href="/analytics/feedback" class="${!showAll?'active':''}">👎 Needs Review (${downCount})</a>
    <a href="/analytics/feedback?filter=all" class="${showAll?'active':''}">All Ratings (${all.length})</a>
  </div>
  ${entries.length===0?`<p style="padding:24px;color:#64748b">No ${showAll?'':'flagged '}responses yet.</p>`:`
  <table><thead><tr><th>Time</th><th>Question</th><th>Answer</th><th>Rating</th></tr></thead><tbody>${rows}</tbody></table>`}
  </body></html>`);
});

// WhatsApp webhook &mdash; Twilio sends POST with body.Body = user message
app.post('/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const userMsg = (req.body.Body || '').trim();
  const from = req.body.From || '';
  const twiml = new twilio.twiml.MessagingResponse();

  // Handle voice messages
  const numMedia = parseInt(req.body.NumMedia || '0');
  const mediaType = req.body.MediaContentType0 || '';
  let isVoice = false;

  if (numMedia > 0 && mediaType.startsWith('audio/')) {
    isVoice = true;
    const mediaUrl = req.body.MediaUrl0;
    twiml.message('Got your voice note! Transcribing and looking that up...');
    res.type('text/xml').send(twiml.toString());

    const ext = mediaType.includes('ogg') ? 'ogg' : mediaType.includes('mp4') ? 'mp4' : mediaType.includes('mpeg') ? 'mp3' : 'ogg';
    const tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.${ext}`);
    try {
      await downloadAudio(mediaUrl, tmpFile);
      const transcribed = await transcribeAudio(tmpFile);
      fs.unlink(tmpFile, () => {});

      if (!transcribed) {
        await twilioClient.messages.create({
          from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
          to: from,
          body: 'Sorry, I couldn\'t make out that voice note. Could you try typing your question?',
        });
        return;
      }

      // Log and answer the transcribed message
      const start = Date.now();
      const existingThreadId = getUserThread(from);
      const thread = existingThreadId ? { id: existingThreadId } : await openai.beta.threads.create();
      saveUserThread(from, thread.id);

      await openai.beta.threads.messages.create(thread.id, { role: 'user', content: transcribed });
      let run = await openai.beta.threads.runs.create(thread.id, { assistant_id: process.env.ASSISTANT_ID });

      while (run.status === 'in_progress' || run.status === 'queued') {
        if (Date.now() - start > 55000) throw new Error('Timed out.');
        await new Promise(r => setTimeout(r, 1000));
        run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      }

      if (run.status !== 'completed') throw new Error(`Run status: ${run.status}`);

      const messages = await openai.beta.threads.messages.list(thread.id);
      let answer = messages.data[0]?.content[0]?.text?.value || '';
      answer = answer.replace(/\u3010[^\u3011]*\u3011/g, '').replace(/FOLLOWUPS:.*$/ms, '').trim();
      if (answer.length > 1580) answer = answer.slice(0, 1577) + '&hellip;';

      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: `ðŸŽ¤ _"${transcribed}"_\n\n${answer}`,
      });

      logMessage({
        ts: new Date().toISOString(),
        from,
        question: `[Voice] ${transcribed}`,
        answer,
        ms: Date.now() - start,
        success: true,
        uncertain: isUncertain(answer),
      });
    } catch (err) {
      console.error('Voice transcription error:', err.message);
      fs.unlink(tmpFile, () => {});
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Sorry, something went wrong with your voice note. Please try typing your question.',
      });
    }
    return;
  }

  const MENU = 'Hi! Which system do you need help with?\n\n1 - SmartRecruiters\n2 - SAP SuccessFactors RCM\n\nJust reply with 1 or 2.';
  const ASSISTANT_RCM = process.env.ASSISTANT_ID;
  const ASSISTANT_SR  = process.env.ASSISTANT_ID_SR;

  const userData = getUserData(from);
  const existingSystem = (userData && typeof userData === 'object') ? userData.system : null;

  // Reset/menu command
  if (/^(reset|menu|change|switch|back)$/i.test(userMsg)) {
    const allThreads = fs.existsSync(THREADS_FILE) ? JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8')) : {};
    delete allThreads[from];
    fs.writeFileSync(THREADS_FILE, JSON.stringify(allThreads, null, 2));
    twiml.message(MENU);
    return res.type('text/xml').send(twiml.toString());
  }

  // User picking from menu
  if (userMsg === '1' || userMsg === '2') {
    const chosen = userMsg === '1' ? 'sr' : 'rcm';
    const label = chosen === 'sr' ? 'SmartRecruiters' : 'SAP SuccessFactors RCM';
    const newThread = await openai.beta.threads.create();
    saveUserThread(from, newThread.id, chosen);
    twiml.message('Got it - switching to ' + label + '. Go ahead and ask your question.');
    return res.type('text/xml').send(twiml.toString());
  }

  const isGreeting = /^(hi|hey|hello|hiya|howdy|good (morning|afternoon|evening)|sup|yo|helo|hii+)[\s!?.]*$/i.test(userMsg);

  // No system selected yet - show menu
  if (!existingSystem || isGreeting || !userMsg) {
    twiml.message(MENU);
    return res.type('text/xml').send(twiml.toString());
  }

  const assistantId = existingSystem === 'sr' ? ASSISTANT_SR : ASSISTANT_RCM;
  if (!assistantId) {
    twiml.message('Assistant not configured for that system. Please contact support.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Acknowledge immediately so Twilio doesn't time out
  twiml.message('Got it! Looking that up for you...');
  res.type('text/xml').send(twiml.toString());

  // Process in background and send the real answer as an outbound message
  const start = Date.now();
  let answer = '';
  let success = false;

  try {
    const existingThreadId = getUserThread(from);
    const thread = existingThreadId
      ? { id: existingThreadId }
      : await openai.beta.threads.create();
    saveUserThread(from, thread.id, existingSystem);

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMsg,
    });

    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    while (run.status === 'in_progress' || run.status === 'queued') {
      if (Date.now() - start > 55000) throw new Error('Timed out.');
      await new Promise(r => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (run.status !== 'completed') throw new Error(`Run status: ${run.status}`);

    const messages = await openai.beta.threads.messages.list(thread.id);
    answer = messages.data[0]?.content[0]?.text?.value || '';
    answer = answer.replace(/\u3010[^\u3011]*\u3011/g, '').replace(/FOLLOWUPS:.*$/ms, '').trim();

    if (answer.length > 1580) answer = answer.slice(0, 1577) + '&hellip;';

    success = true;
    const uncertain = isUncertain(answer);

    await twilioClient.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: answer || 'Sorry, I could not find an answer.',
    });

    logMessage({
      ts: new Date().toISOString(),
      from,
      question: userMsg,
      answer,
      ms: Date.now() - start,
      success,
      uncertain,
    });
    return;
  } catch (err) {
    console.error('WhatsApp AI error:', err.message);
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Sorry, something went wrong. Please try again.',
      });
    } catch (e) {
      console.error('Failed to send error message:', e.message);
    }
    logMessage({
      ts: new Date().toISOString(),
      from,
      question: userMsg,
      answer,
      ms: Date.now() - start,
      success: false,
      uncertain: false,
    });
  }
});

// Analytics dashboard
app.all('/analytics', requirePassword);
app.get('/analytics', (req, res) => {
  const allLogs = readLogs();
  const search = (req.query.q || '').trim().replace(/\D/g, ''); // digits only
  const logs = search ? allLogs.filter(l => l.from.replace(/\D/g, '').includes(search)) : allLogs;

  const total = logs.length;
  const errors = logs.filter(l => !l.success).length;
  const uncertain = logs.filter(l => l.uncertain).length;
  const avgMs = total ? Math.round(logs.reduce((s, l) => s + l.ms, 0) / total) : 0;

  // Questions per day
  const byDay = {};
  for (const l of logs) {
    const day = l.ts.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  // Unique users (phone numbers)
  const uniqueNumbers = [...new Set(allLogs.map(l => l.from.replace('whatsapp:', '')))];
  const uniqueUsers = new Set(allLogs.map(l => l.from)).size;

  const rows = logs.slice().reverse().map(l => {
    const status = !l.success ? 'âŒ Error' : l.uncertain ? 'âš ï¸ Uncertain' : 'âœ…';
    const num = l.from.replace('whatsapp:', '');
    return `
    <tr>
      <td>${l.ts.replace('T', ' ').slice(0, 19)}</td>
      <td><a href="/analytics?q=${encodeURIComponent(num)}" style="color:#4a90e2;text-decoration:none">${num}</a></td>
      <td>${escHtml(l.question)}</td>
      <td class="preview" onclick="showAnswer(this)" data-full="${escHtml(l.answer || '&mdash;')}">${escHtml(l.answer || '&mdash;').slice(0, 120)}${(l.answer || '').length > 120 ? '&hellip; <span style="color:#4a90e2;font-size:.8rem">(click to expand)</span>' : ''}</td>
      <td>${status}</td>
      <td>${(l.ms / 1000).toFixed(1)}s</td>
    </tr>`;
  }).join('');

  const dayRows = Object.entries(byDay).sort().reverse().map(([d, c]) =>
    `<tr><td>${d}</td><td>${c}</td></tr>`).join('');

  const numberOptions = uniqueNumbers.map(n =>
    `<option value="${escHtml(n)}" ${search && n.includes(search) ? 'selected' : ''}>${escHtml(n)}</option>`
  ).join('');

  const searchLabel = search ? `&mdash; filtered to <strong>${logs[0]?.from.replace('whatsapp:','') || search}</strong> <a href="/analytics" style="font-size:.85rem;color:#4a90e2">clear</a>` : '';

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Analytics</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; background: #f9f9f9; }
    h1 { color: #333; }
    .cards { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .card { background: white; border-radius: 8px; padding: 1rem 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.1); min-width: 140px; }
    .card .num { font-size: 2rem; font-weight: bold; color: #4a90e2; }
    .card .label { color: #888; font-size: .85rem; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
    th { background: #4a90e2; color: white; padding: .6rem 1rem; text-align: left; }
    td { padding: .55rem 1rem; border-bottom: 1px solid #eee; font-size: .9rem; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    h2 { margin-top: 2rem; color: #555; }
    .search-bar { display: flex; gap: .5rem; align-items: center; margin-bottom: 1.5rem; }
    .search-bar select, .search-bar input { padding: .5rem .75rem; border: 1px solid #ddd; border-radius: 6px; font-size: .95rem; }
    .search-bar button { padding: .5rem 1rem; background: #4a90e2; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: .95rem; }
    .preview { cursor: pointer; color: #555; }
    .preview:hover { color: #4a90e2; }
    .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:100; align-items:center; justify-content:center; }
    .modal-bg.open { display:flex; }
    .modal { background:white; border-radius:10px; padding:1.5rem 2rem; max-width:560px; width:90%; max-height:80vh; overflow-y:auto; box-shadow:0 4px 24px rgba(0,0,0,.2); }
    .modal h3 { margin-top:0; color:#333; }
    .modal p { white-space:pre-wrap; color:#444; line-height:1.6; }
    .modal button { margin-top:1rem; padding:.4rem 1rem; background:#4a90e2; color:white; border:none; border-radius:6px; cursor:pointer; }
  </style>
</head>
<body>
  <nav style="margin-bottom:1.5rem">
    <a href="/analytics" style="margin-right:1rem;color:#4a90e2;text-decoration:none;font-weight:bold;border-bottom:2px solid #4a90e2">WhatsApp</a>
    <a href="/analytics/web" style="color:#4a90e2;text-decoration:none;font-weight:bold">Web Chat</a>
  </nav>
  <h1>WhatsApp Analytics ${searchLabel}</h1>

  <form class="search-bar" method="get" action="/analytics">
    <input name="q" placeholder="Search by phone number..." value="${escHtml(req.query.q || '')}" style="width:240px" />
    <select onchange="this.form.q.value=this.value;this.form.submit()">
      <option value="">&mdash; or pick a number &mdash;</option>
      ${numberOptions}
    </select>
    <button type="submit">Search</button>
  </form>

  <div class="cards">
    <div class="card"><div class="num">${total}</div><div class="label">${search ? 'Filtered' : 'Total'} messages</div></div>
    <div class="card"><div class="num">${uniqueUsers}</div><div class="label">Unique users</div></div>
    <div class="card"><div class="num">${errors}</div><div class="label">Errors</div></div>
    <div class="card"><div class="num">${uncertain}</div><div class="label">Uncertain answers</div></div>
    <div class="card"><div class="num">${(avgMs/1000).toFixed(1)}s</div><div class="label">Avg response time</div></div>
  </div>

  <h2>Messages per day</h2>
  <table>
    <tr><th>Date</th><th>Messages</th></tr>
    ${dayRows || '<tr><td colspan="2">No data yet</td></tr>'}
  </table>

  <h2>Recent messages</h2>
  <table>
    <tr><th>Time</th><th>From</th><th>Question</th><th>Answer</th><th>OK</th><th>Time</th></tr>
    ${rows || '<tr><td colspan="6">No messages yet</td></tr>'}
  </table>
  <div class="modal-bg" id="modal" onclick="closeModal(event)">
    <div class="modal">
      <h3 id="modal-q"></h3>
      <p id="modal-a"></p>
      <button onclick="document.getElementById('modal').classList.remove('open')">Close</button>
    </div>
  </div>
  <script>
    function showAnswer(td) {
      const row = td.closest('tr');
      const question = row.cells[2].textContent;
      document.getElementById('modal-q').textContent = question;
      document.getElementById('modal-a').textContent = td.dataset.full;
      document.getElementById('modal').classList.add('open');
    }
    function closeModal(e) {
      if (e.target.id === 'modal') document.getElementById('modal').classList.remove('open');
    }
  </script>
</body>
</html>`);
});

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function isUncertain(text) {
  const patterns = [
    /i (don'?t|do not) (have|know|find|see)/i,
    /not (covered|found|available|mentioned|included) in/i,
    /no (information|details?|data|content) (available|found|provided)/i,
    /unable to (find|locate|answer|provide)/i,
    /can'?t (find|answer|help with)/i,
    /outside (the scope|my knowledge)/i,
    /not (in|part of) (the|my|this) (document|guide|knowledge)/i,
    /i can only (assist|help|answer) with/i,
    /only (assist|help|answer) questions (related|about)/i,
    /not (able|here) to (help|assist) with that/i,
    /that('s| is) (outside|beyond|not within)/i,
    /not (relevant|related) to/i,
  ];
  return patterns.some(p => p.test(text));
}

// Insights data API
app.get('/api/insights', requireConsultantPin, async (req, res) => {
  const readLocal = (file) => { try { return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)); } catch { return []; } };
  let web, wa, fb;
  if (redisEnabled()) {
    const [rWeb, rWa, rFb] = await Promise.all([
      readPersistedLogs('logs:web'),
      readPersistedLogs('logs:whatsapp'),
      readPersistedLogs('logs:feedback')
    ]);
    web = rWeb || readLocal(WEB_LOG_FILE);
    wa = rWa || readLocal(LOG_FILE);
    fb = rFb || readLocal(FEEDBACK_FILE);
  } else {
    web = readLocal(WEB_LOG_FILE);
    wa = readLocal(LOG_FILE);
    fb = readLocal(FEEDBACK_FILE);
  }

  const byDay = {};
  [...web,...wa].forEach(l => {
    const d = l.ts.slice(0,10);
    if (!byDay[d]) byDay[d] = { web:0, wa:0 };
    if (l.threadId !== undefined) byDay[d].web++; else byDay[d].wa++;
  });

  const rtWeb = web.filter(l=>l.ms>0).map(l=>l.ms);
  const rtWa = wa.filter(l=>l.ms>0).map(l=>l.ms);
  const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : 0;

  const topQ = [...web,...wa].map(l=>l.question).filter(Boolean);
  const qFreq = {};
  topQ.forEach(q => {
    const key = q.slice(0,60);
    qFreq[key] = (qFreq[key]||0)+1;
  });
  const topQuestions = Object.entries(qFreq).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([q,c])=>({q,c}));

  const recent = [...web.map(l=>({...l,src:'web'})),...wa.map(l=>({...l,src:'whatsapp'}))]
    .sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,20);

  res.json({
    web: { total: web.length, success: web.filter(l=>l.success).length, uncertain: web.filter(l=>l.uncertain).length, avgMs: avg(rtWeb) },
    wa: { total: wa.length, success: wa.filter(l=>l.success).length, uncertain: wa.filter(l=>l.uncertain).length, avgMs: avg(rtWa) },
    feedback: { up: fb.filter(f=>f.rating==='up').length, down: fb.filter(f=>f.rating==='down').length },
    byDay, topQuestions, recent,
    sysInfo: { assistantId: process.env.ASSISTANT_ID||'—', vectorStoreId: process.env.VECTOR_STORE_ID||'—', nodeVersion: process.version, uptime: Math.round(process.uptime()) }
  });
});

// AI summary for insights
app.post('/api/insights-summary', requireConsultantPin, async (req, res) => {
  const web = (() => { try { return fs.readFileSync(WEB_LOG_FILE,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).slice(-50); } catch { return []; } })();
  const wa = (() => { try { return fs.readFileSync(LOG_FILE,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).slice(-50); } catch { return []; } })();
  const combined = [...web,...wa].sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,60);
  if (!combined.length) return res.json({ summary: 'No conversation data available yet.' });
  const sample = combined.map(l=>`Q: ${l.question}\nA: ${(l.answer||'').slice(0,200)}`).join('\n\n');
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an AI analytics assistant. Analyse these recent AI conversations from a SAP SuccessFactors RCM test platform and provide a concise consultant-facing summary. Cover: top topics asked, quality of AI responses, any patterns of confusion or uncertainty, and 2-3 recommendations to improve the knowledge base. Be specific and actionable. Max 250 words.' },
        { role: 'user', content: sample }
      ],
      max_tokens: 400
    });
    res.json({ summary: completion.choices[0].message.content });
  } catch(e) { res.status(500).json({ summary: 'Could not generate summary: ' + e.message }); }
});

// Insights page
app.all('/insights', requireConsultantPin);
app.get('/insights', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 Insights</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.topbar{background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.tb-left{display:flex;align-items:center;gap:16px}
.tb-logo{font-size:12px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#6366f1}
.tb-title{font-size:15px;font-weight:600;color:#f1f5f9}
.tb-nav{display:flex;gap:4px}
.tb-nav a{color:#94a3b8;text-decoration:none;font-size:13px;padding:6px 12px;border-radius:6px;transition:all .15s}
.tb-nav a:hover{color:#f1f5f9;background:#334155}
.tb-nav a.active{color:#6366f1;background:#1e1b4b}
.content{max-width:1400px;margin:0 auto;padding:28px 24px}
.page-title{font-size:22px;font-weight:700;color:#f1f5f9;margin-bottom:4px}
.page-sub{font-size:13px;color:#64748b;margin-bottom:28px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px}
.stat-card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
.stat-card.blue::before{background:linear-gradient(90deg,#6366f1,#8b5cf6)}
.stat-card.green::before{background:linear-gradient(90deg,#10b981,#059669)}
.stat-card.amber::before{background:linear-gradient(90deg,#f59e0b,#d97706)}
.stat-card.red::before{background:linear-gradient(90deg,#ef4444,#dc2626)}
.stat-card.purple::before{background:linear-gradient(90deg,#8b5cf6,#7c3aed)}
.stat-card.teal::before{background:linear-gradient(90deg,#14b8a6,#0d9488)}
.stat-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:8px}
.stat-value{font-size:30px;font-weight:700;color:#f1f5f9;line-height:1}
.stat-sub{font-size:12px;color:#64748b;margin-top:6px}
.stat-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:20px;margin-top:8px}
.badge-green{background:#052e16;color:#4ade80}
.badge-red{background:#450a0a;color:#f87171}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
.grid-3{display:grid;grid-template-columns:2fr 1fr;gap:20px;margin-bottom:28px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px}
.card-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:20px;display:flex;align-items:center;gap:8px}
.card-title span{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot-blue{background:#6366f1} .dot-green{background:#10b981} .dot-amber{background:#f59e0b} .dot-purple{background:#8b5cf6}
.chart-wrap{position:relative;height:220px}
.summary-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;font-size:13px;line-height:1.7;color:#cbd5e1;min-height:80px}
.btn-summary{background:#6366f1;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;padding:10px 20px;cursor:pointer;transition:background .15s;margin-bottom:16px}
.btn-summary:hover{background:#4f46e5}
.btn-summary:disabled{opacity:.5;cursor:not-allowed}
.top-q-list{display:flex;flex-direction:column;gap:8px}
.top-q-item{display:flex;align-items:center;gap:12px;padding:10px 12px;background:#0f172a;border-radius:8px;border:1px solid #1e293b}
.top-q-bar-wrap{flex:1;background:#1e293b;border-radius:4px;height:4px;overflow:hidden}
.top-q-bar{height:4px;background:#6366f1;border-radius:4px;transition:width .5s}
.top-q-text{font-size:12px;color:#cbd5e1;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top-q-count{font-size:12px;font-weight:700;color:#6366f1;flex-shrink:0}
.feed{display:flex;flex-direction:column;gap:10px}
.feed-item{background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;cursor:pointer;transition:border-color .15s}
.feed-item:hover{border-color:#334155}
.feed-meta{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.src-badge{font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 8px;border-radius:20px}
.src-web{background:#1e1b4b;color:#818cf8}
.src-wa{background:#052e16;color:#4ade80}
.src-flagged{background:#450a0a;color:#f87171}
.feed-time{font-size:11px;color:#475569}
.feed-q{font-size:13px;color:#e2e8f0;font-weight:500;margin-bottom:4px}
.feed-a{font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sys-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sys-row{background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px 14px}
.sys-label{font-size:11px;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
.sys-val{font-size:12px;color:#94a3b8;font-family:monospace;word-break:break-all}
.loading{display:flex;align-items:center;gap:8px;color:#64748b;font-size:13px}
.spin{width:16px;height:16px;border:2px solid #334155;border-top-color:#6366f1;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.section-divider{border:none;border-top:1px solid #1e293b;margin:8px 0 20px}
.fb-row-ins{display:flex;align-items:center;gap:12px;padding:10px 12px;background:#0f172a;border-radius:8px;margin-bottom:8px}
.fb-ins-q{font-size:12px;color:#e2e8f0;flex:1}
.fb-ins-r{font-size:16px;flex-shrink:0}
.empty-state{color:#475569;font-size:13px;padding:20px 0;text-align:center}
@media(max-width:900px){.grid-2,.grid-3{grid-template-columns:1fr}}
</style></head><body>
<div class="topbar">
  <div class="tb-left">
    <div class="tb-logo">EX3</div>
    <div class="tb-title">Insights</div>
  </div>
  <nav class="tb-nav">
    <a href="/insights" class="active">📊 Analytics</a>
    <a href="/consultant">🛠 Consultant</a>
    <a href="/">← Site</a>
  </nav>
</div>
<div class="content">
  <div class="page-title">Platform Insights</div>
  <div class="page-sub" id="last-updated">Loading data…</div>

  <div class="stats-grid" id="stats-grid">
    <div class="stat-card blue"><div class="stat-label">Total Conversations</div><div class="stat-value" id="s-total">—</div><div class="stat-sub">Web + WhatsApp</div></div>
    <div class="stat-card green"><div class="stat-label">Web Chat</div><div class="stat-value" id="s-web">—</div><div class="stat-sub" id="s-web-sub">questions</div></div>
    <div class="stat-card teal"><div class="stat-label">WhatsApp</div><div class="stat-value" id="s-wa">—</div><div class="stat-sub" id="s-wa-sub">messages</div></div>
    <div class="stat-card amber"><div class="stat-label">Avg Response</div><div class="stat-value" id="s-rt">—</div><div class="stat-sub">milliseconds</div></div>
    <div class="stat-card purple"><div class="stat-label">Feedback Score</div><div class="stat-value" id="s-fb">—</div><div class="stat-sub" id="s-fb-sub">ratings</div></div>
    <div class="stat-card red"><div class="stat-label">Flagged</div><div class="stat-value" id="s-flag">—</div><div class="stat-sub">needs review</div></div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-title"><span class="dot-blue"></span>Questions Per Day</div>
      <div class="chart-wrap"><canvas id="chart-daily"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="dot-purple"></span>Source Breakdown</div>
      <div class="chart-wrap"><canvas id="chart-source"></canvas></div>
    </div>
  </div>

  <div class="grid-3">
    <div class="card">
      <div class="card-title"><span class="dot-amber"></span>Top Questions</div>
      <div class="top-q-list" id="top-q-list"><div class="loading"><div class="spin"></div>Loading…</div></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="dot-green"></span>System Info</div>
      <div class="sys-grid" id="sys-grid"><div class="loading"><div class="spin"></div></div></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div class="card-title"><span class="dot-purple"></span>AI Conversation Summary</div>
    <button class="btn-summary" id="btn-summary" onclick="loadSummary()">✨ Generate AI Summary</button>
    <div class="summary-box" id="summary-box">Click the button above to generate an AI-powered analysis of recent conversations, patterns, and recommendations.</div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-title"><span class="dot-blue"></span>Recent Conversations</div>
      <div class="feed" id="feed-recent"><div class="loading"><div class="spin"></div>Loading…</div></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="dot-amber"></span>👎 Flagged Responses</div>
      <div id="feed-flagged"><div class="loading"><div class="spin"></div>Loading…</div></div>
    </div>
  </div>
</div>

<script>
let chartDaily, chartSource;

async function loadData() {
  const r = await fetch('/api/insights');
  const d = await r.json();

  const total = d.web.total + d.wa.total;
  document.getElementById('last-updated').textContent = 'Last updated ' + new Date().toLocaleTimeString() + ' · ' + total + ' total interactions';
  document.getElementById('s-total').textContent = total.toLocaleString();
  document.getElementById('s-web').textContent = d.web.total.toLocaleString();
  document.getElementById('s-web-sub').textContent = d.web.success + ' successful';
  document.getElementById('s-wa').textContent = d.wa.total.toLocaleString();
  document.getElementById('s-wa-sub').textContent = d.wa.success + ' successful';
  const avgRt = Math.round((d.web.avgMs * d.web.total + d.wa.avgMs * d.wa.total) / Math.max(total,1));
  document.getElementById('s-rt').textContent = avgRt || '—';
  const fbTotal = d.feedback.up + d.feedback.down;
  const fbPct = fbTotal ? Math.round(d.feedback.up / fbTotal * 100) : null;
  document.getElementById('s-fb').textContent = fbPct !== null ? fbPct + '%' : '—';
  document.getElementById('s-fb-sub').textContent = fbTotal + ' ratings · ' + d.feedback.up + ' 👍 ' + d.feedback.down + ' 👎';
  document.getElementById('s-flag').textContent = d.feedback.down;

  // Daily chart
  const days = Object.keys(d.byDay).sort().slice(-14);
  const webData = days.map(k => d.byDay[k]?.web || 0);
  const waData = days.map(k => d.byDay[k]?.wa || 0);
  const labels = days.map(k => { const dt = new Date(k); return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); });
  if (chartDaily) chartDaily.destroy();
  chartDaily = new Chart(document.getElementById('chart-daily'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Web', data: webData, backgroundColor: '#6366f1', borderRadius: 4 },
        { label: 'WhatsApp', data: waData, backgroundColor: '#10b981', borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } }, scales: { x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' }, beginAtZero: true } } }
  });

  // Source donut
  if (chartSource) chartSource.destroy();
  chartSource = new Chart(document.getElementById('chart-source'), {
    type: 'doughnut',
    data: {
      labels: ['Web Chat', 'WhatsApp'],
      datasets: [{ data: [d.web.total, d.wa.total], backgroundColor: ['#6366f1','#10b981'], borderWidth: 0, hoverOffset: 6 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 }, padding: 16 } } } }
  });

  // Top questions
  const maxC = d.topQuestions[0]?.c || 1;
  document.getElementById('top-q-list').innerHTML = d.topQuestions.length
    ? d.topQuestions.map(({q,c}) => \`<div class="top-q-item">
        <span class="top-q-count">\${c}x</span>
        <div style="flex:1;min-width:0">
          <div class="top-q-text">\${q}</div>
          <div class="top-q-bar-wrap"><div class="top-q-bar" style="width:\${Math.round(c/maxC*100)}%"></div></div>
        </div>
      </div>\`).join('')
    : '<div class="empty-state">No questions yet</div>';

  // System info
  const si = d.sysInfo;
  document.getElementById('sys-grid').innerHTML = [
    ['Assistant ID', si.assistantId],
    ['Vector Store', si.vectorStoreId],
    ['Node Version', si.nodeVersion],
    ['Uptime', Math.floor(si.uptime/3600) + 'h ' + Math.floor((si.uptime%3600)/60) + 'm'],
    ['Web Success Rate', d.web.total ? Math.round(d.web.success/d.web.total*100)+'%' : '—'],
    ['WA Success Rate', d.wa.total ? Math.round(d.wa.success/d.wa.total*100)+'%' : '—'],
  ].map(([l,v]) => \`<div class="sys-row"><div class="sys-label">\${l}</div><div class="sys-val">\${v}</div></div>\`).join('');

  // Recent feed
  document.getElementById('feed-recent').innerHTML = d.recent.length
    ? d.recent.slice(0,10).map(l => \`<div class="feed-item">
        <div class="feed-meta">
          <span class="src-badge \${l.src==='web'?'src-web':'src-wa'}">\${l.src==='web'?'WEB':'WHATSAPP'}</span>
          <span class="feed-time">\${l.ts.replace('T',' ').slice(0,16)}</span>
          \${l.uncertain?'<span class="src-badge src-flagged">UNCERTAIN</span>':''}
        </div>
        <div class="feed-q">\${l.question||'—'}</div>
        <div class="feed-a">\${(l.answer||'').slice(0,120)}\${(l.answer||'').length>120?'…':''}</div>
      </div>\`).join('')
    : '<div class="empty-state">No conversations yet</div>';

  // Flagged
  fetch('/analytics/feedback?json=1').catch(()=>{});
  const fbLines = await fetch('/api/insights').then(r=>r.json()).then(d=>d).catch(()=>({feedback:{}}));
  // Load flagged from feedback file via insights
  loadFlagged();
}

async function loadFlagged() {
  const r = await fetch('/api/insights');
  // We already have the data — just re-read feedback from server
  const resp = await fetch('/api/feedback-list');
  if (!resp.ok) { document.getElementById('feed-flagged').innerHTML = '<div class="empty-state">No flagged responses yet</div>'; return; }
  const flagged = await resp.json();
  document.getElementById('feed-flagged').innerHTML = flagged.length
    ? flagged.slice(0,8).map(f => \`<div class="fb-row-ins">
        <div class="fb-ins-q">
          <div style="font-size:11px;color:#475569;margin-bottom:3px">\${f.ts.replace('T',' ').slice(0,16)}</div>
          \${f.question}
        </div>
        <div class="fb-ins-r">👎</div>
      </div>\`).join('')
    : '<div class="empty-state">No flagged responses yet — great sign!</div>';
}

async function loadSummary() {
  const btn = document.getElementById('btn-summary');
  const box = document.getElementById('summary-box');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  box.innerHTML = '<div class="loading"><div class="spin"></div>Analysing recent conversations…</div>';
  try {
    const r = await fetch('/api/insights-summary', { method: 'POST' });
    const d = await r.json();
    box.textContent = d.summary;
  } catch(e) {
    box.textContent = 'Could not generate summary. Please try again.';
  }
  btn.disabled = false;
  btn.textContent = '✨ Regenerate';
}

loadData();
setInterval(loadData, 60000);
</script>
</body></html>`);
});

// Feedback list API for insights page
app.get('/api/feedback-list', requireConsultantPin, async (req, res) => {
  let all;
  if (redisEnabled()) {
    const rFb = await readPersistedLogs('logs:feedback');
    if (rFb) all = rFb;
  }
  if (!all) {
    const lines = fs.existsSync(FEEDBACK_FILE) ? fs.readFileSync(FEEDBACK_FILE,'utf8').trim().split('\n').filter(Boolean) : [];
    all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  res.json(all.filter(f => f.rating === 'down').reverse().slice(0, 20));
});

// Consultant Portal
app.all('/consultant', requireConsultantPin);
app.get('/consultant', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EX3 Consultant Portal</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Sora',sans-serif;background:#f8f7f4;color:#0f0f0e;line-height:1.65;font-size:14px}
    a{color:inherit;text-decoration:none}
    .layout{display:flex;min-height:100vh}
    /* Sidebar */
    .sidebar{width:260px;flex-shrink:0;background:#0f0f0f;color:#fff;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;display:flex;flex-direction:column}
    .sb-brand{padding:24px 20px;border-bottom:1px solid #2a2a2a}
    .sb-brand .logo{font-size:36px;font-weight:900;letter-spacing:-.12em;line-height:1}
    .sb-brand .tag{font-size:11px;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-top:4px}
    .sb-back{display:flex;align-items:center;gap:6px;padding:12px 20px;font-size:12px;color:#888;border-bottom:1px solid #2a2a2a;cursor:pointer;transition:color .15s}
    .sb-back:hover{color:#fff}
    .sb-section{padding:16px 20px 4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#555;font-weight:600}
    .sb-item{display:block;padding:9px 20px;font-size:13px;color:#aaa;cursor:pointer;transition:all .15s;border-left:2px solid transparent}
    .sb-item:hover{color:#fff;background:#1a1a1a}
    .sb-item.active{color:#fff;border-left-color:#fff;background:#1a1a1a}
    /* Main */
    .main{margin-left:260px;flex:1;padding:40px 48px;max-width:900px}
    .page{display:none}.page.active{display:block}
    /* Hero */
    .hero{margin-bottom:40px}
    .hero h1{font-size:32px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
    .hero p{font-size:15px;color:#555;max-width:580px}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:16px}
    .badge-blue{background:#eff4ff;color:#1a56db}
    .badge-green{background:#f0fdf6;color:#0d7c4c}
    .badge-amber{background:#fffbeb;color:#b45309}
    .badge-purple{background:#faf5ff;color:#6b21a8}
    .badge-gray{background:#f3f4f6;color:#374151}
    /* Cards */
    .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-bottom:32px}
    .card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;transition:box-shadow .15s}
    .card:hover{box-shadow:0 4px 16px rgba(0,0,0,.08)}
    .card h3{font-size:14px;font-weight:600;margin-bottom:6px}
    .card p{font-size:13px;color:#555}
    .card .num{font-size:28px;font-weight:700;color:#0f0f0f;margin-bottom:4px}
    /* Phases */
    .phase{background:#fff;border:1px solid #e4e2dc;border-radius:10px;margin-bottom:16px;overflow:hidden}
    .phase-header{padding:16px 20px;display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
    .phase-header:hover{background:#fafaf9}
    .phase-num{width:28px;height:28px;border-radius:50%;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
    .phase-title{font-weight:600;font-size:15px;flex:1}
    .phase-weeks{font-size:12px;color:#888}
    .phase-chevron{transition:transform .2s;color:#888}
    .phase-body{display:none;padding:0 20px 20px;border-top:1px solid #f0eeea}
    .phase-body.open{display:block}
    /* Checklist */
    .checklist{list-style:none;margin-top:12px}
    .checklist li{display:flex;align-items:flex-start;gap:10px;padding:6px 0;font-size:13px;border-bottom:1px solid #f5f4f1}
    .checklist li:last-child{border-bottom:none}
    .checklist li::before{content:'â˜';font-size:15px;flex-shrink:0;margin-top:1px;color:#888}
    /* SOW */
    .sow-box{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:28px;margin-bottom:24px}
    .sow-box h2{font-size:18px;font-weight:700;margin-bottom:4px}
    .sow-box .sub{font-size:13px;color:#888;margin-bottom:20px}
    .sow-section{margin-bottom:20px}
    .sow-section h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #f0eeea}
    .sow-section p,.sow-section li{font-size:13px;color:#333;line-height:1.7}
    .sow-section ul{padding-left:18px;margin-top:6px}
    .sow-section li{margin-bottom:4px}
    .copy-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#0f0f0f;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;font-family:inherit}
    .copy-btn:hover{background:#333}
    /* Roles */
    .role-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px}
    .role-card{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:16px;cursor:pointer;transition:all .15s}
    .role-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .role-card.sel{border-color:#0f0f0f;box-shadow:0 0 0 2px #0f0f0f}
    .role-card h3{font-size:13px;font-weight:600;margin-bottom:4px}
    .role-card p{font-size:12px;color:#888}
    .role-content{display:none}.role-content.active{display:block}
    /* Table */
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4e2dc;border-radius:10px;overflow:hidden;margin-bottom:24px}
    th{background:#0f0f0f;color:#fff;padding:10px 14px;text-align:left;font-size:12px;font-weight:600;letter-spacing:.04em}
    td{padding:10px 14px;border-bottom:1px solid #f0eeea;font-size:13px}
    tr:last-child td{border-bottom:none}
    h2.section-title{font-size:22px;font-weight:700;margin-bottom:6px;letter-spacing:-.01em}
    p.section-sub{font-size:14px;color:#555;margin-bottom:24px}
    .tip{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:13px;color:#78350f;margin-bottom:16px}
    .tip strong{font-weight:600}
  </style>
</head>
<body>
<div class="layout">

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sb-brand">
      <div class="logo">ex3</div>
      <div class="tag">Consultant Portal</div>
    </div>
    <a href="/" class="sb-back">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      Back to main guide
    </a>
    <div class="sb-section">Implementation</div>
    <div class="sb-item active" onclick="showPage('overview')">Overview & Timeline</div>
    <div class="sb-item" onclick="showPage('phases')">Phase Guide</div>
    <div class="sb-item" onclick="showPage('sow')">SOW Template</div>
    <div class="sb-section">Stakeholders</div>
    <div class="sb-item" onclick="showPage('roles')">Roles & Responsibilities</div>
    <div class="sb-section">Resources</div>
    <div class="sb-item" onclick="showPage('checklists')">Checklists</div>
    <div class="sb-item" onclick="showPage('faq')">FAQ & Troubleshooting</div>
    <div class="sb-section">Tools</div>
    <a href="/consultant/sow-builder" style="display:block;padding:9px 20px;font-size:13px;color:#aaa;transition:all .15s;border-left:2px solid transparent;background:#1a3a1a;border-left-color:#4ade80;color:#4ade80;font-weight:600">âœ¨ SOW Builder</a>
  </nav>

  <!-- Main -->
  <main class="main">

    <!-- OVERVIEW -->
    <div class="page active" id="page-overview">
      <div class="hero">
        <span class="badge badge-gray">Consultant Portal</span>
        <h1>SAP SuccessFactors Recruiting Implementation Guide</h1>
        <p>Everything you need to deliver a successful SAP SuccessFactors Recruiting implementation &mdash; from kickoff to go-live.</p>
      </div>
      <div class="cards">
        <div class="card"><div class="num">8&ndash;12</div><h3>Typical Weeks</h3><p>For a standard mid-size organisation</p></div>
        <div class="card"><div class="num">6</div><h3>Phases</h3><p>Discovery, Config, Build, UAT, Training, Go-Live</p></div>
        <div class="card"><div class="num">4</div><h3>Key Stakeholders</h3><p>HR, IT, Recruiters, Hiring Managers</p></div>
        <div class="card"><div class="num">3</div><h3>Training Sessions</h3><p>Admin, Recruiter, Hiring Manager</p></div>
      </div>
      <div class="tip"><strong>First time?</strong> Start with the Phase Guide &mdash; it walks you through exactly what to do and when. The SOW Template has pre-written scope wording you can use directly with clients.</div>
      <h2 class="section-title">Typical Implementation Timeline</h2>
      <p class="section-sub">Use this as a guide &mdash; timelines vary based on client complexity, integrations, and decision speed.</p>
      <table>
        <tr><th>Phase</th><th>Weeks</th><th>Key Output</th></tr>
        <tr><td>1. Discovery & Kickoff</td><td>1&ndash;2</td><td>Project plan, stakeholder map, requirements doc</td></tr>
        <tr><td>2. System Configuration</td><td>2&ndash;4</td><td>Platform configured, users set up, hiring processes built</td></tr>
        <tr><td>3. Build & Integrate</td><td>3&ndash;5</td><td>Integrations live, job boards connected, career page branded</td></tr>
        <tr><td>4. UAT (Testing)</td><td>5&ndash;7</td><td>Client signed off, bugs resolved</td></tr>
        <tr><td>5. Training</td><td>6&ndash;8</td><td>All users trained, materials delivered</td></tr>
        <tr><td>6. Go-Live & Hypercare</td><td>8&ndash;12</td><td>Live in production, 2&ndash;4 week support window</td></tr>
      </table>
    </div>

    <!-- PHASES -->
    <div class="page" id="page-phases">
      <div class="hero">
        <span class="badge badge-blue">Phase Guide</span>
        <h1>Implementation Phases</h1>
        <p>A detailed breakdown of every phase &mdash; what to do, who's involved, and what to deliver.</p>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">1</div>
          <div class="phase-title">Discovery & Kickoff</div>
          <div class="phase-weeks">Weeks 1&ndash;2</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">The goal of discovery is to understand the client's current recruitment process, pain points, and what they need SAP SuccessFactors Recruiting to do. Never skip this &mdash; it prevents costly rework later.</p>
          <ul class="checklist">
            <li>Host kickoff call with all key stakeholders (HR Director, IT, Lead Recruiter)</li>
            <li>Map the client's current hiring process end-to-end</li>
            <li>Identify number of hiring managers and recruiters who need access</li>
            <li>Confirm which integrations are needed (HRIS, job boards, background check)</li>
            <li>Agree on job templates required (how many, what fields)</li>
            <li>Confirm company branding requirements (logo, colours, career page)</li>
            <li>Clarify data migration needs (historical jobs/candidates?)</li>
            <li>Agree project timeline and sign off project plan</li>
            <li>Confirm who the internal champion/project owner is on the client side</li>
            <li>Send Discovery Questionnaire to client and collect responses</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">2</div>
          <div class="phase-title">System Configuration</div>
          <div class="phase-weeks">Weeks 2&ndash;4</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">This is where you build the platform. Work from the inside out &mdash; company settings first, then users, then hiring processes, then templates.</p>
          <ul class="checklist">
            <li>Configure company settings (name, logo, timezone, language)</li>
            <li>Set up user roles (Admin, Recruiter, Hiring Manager, Limited)</li>
            <li>Create user accounts and assign roles</li>
            <li>Build hiring process workflows for each job type</li>
            <li>Configure offer approval chains</li>
            <li>Create job templates and custom fields</li>
            <li>Set up email templates (application received, interview invite, rejection, offer)</li>
            <li>Configure interview scheduling settings</li>
            <li>Set up offer letter templates</li>
            <li>Configure compliance and data retention settings</li>
            <li>Set up department and location structure</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">3</div>
          <div class="phase-title">Build & Integrate</div>
          <div class="phase-weeks">Weeks 3&ndash;5</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Connect SAP SuccessFactors Recruiting to the client's existing systems. Involve the client's IT team here &mdash; you'll need their credentials and access.</p>
          <ul class="checklist">
            <li>Brand and configure the careers page</li>
            <li>Connect job boards (Indeed, LinkedIn, Glassdoor, etc.)</li>
            <li>Set up HRIS integration if required (Workday, SAP, BambooHR)</li>
            <li>Configure background screening integration if required</li>
            <li>Set up SSO (Single Sign-On) if required &mdash; needs IT</li>
            <li>Test all integrations end-to-end</li>
            <li>Configure job posting approval workflows</li>
            <li>Set up Winston AI features if in scope</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">4</div>
          <div class="phase-title">UAT &mdash; User Acceptance Testing</div>
          <div class="phase-weeks">Weeks 5&ndash;7</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">The client tests everything in a staging environment. Your job is to facilitate, log issues, and fix them quickly. Get written sign-off before proceeding to go-live.</p>
          <ul class="checklist">
            <li>Prepare UAT test scripts (one per user role)</li>
            <li>Walk client through the UAT process and what's expected</li>
            <li>Create a test job and run through full hiring process</li>
            <li>Test candidate application journey end-to-end</li>
            <li>Test hiring manager review and feedback flow</li>
            <li>Test offer creation and approval chain</li>
            <li>Test all email templates trigger correctly</li>
            <li>Test integrations with real test data</li>
            <li>Log all issues in a shared tracker</li>
            <li>Resolve all critical issues before proceeding</li>
            <li>Obtain written UAT sign-off from client</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">5</div>
          <div class="phase-title">Training</div>
          <div class="phase-weeks">Weeks 6&ndash;8</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Run separate training sessions per role &mdash; don't mix admins and hiring managers in the same session. Keep it practical, hands-on, and recorded where possible.</p>
          <ul class="checklist">
            <li>Schedule Admin training session (90 mins recommended)</li>
            <li>Schedule Recruiter training session (60 mins recommended)</li>
            <li>Schedule Hiring Manager training session (45 mins recommended)</li>
            <li>Prepare training materials and share in advance</li>
            <li>Record sessions for users who couldn't attend</li>
            <li>Create quick reference guides per role</li>
            <li>Share access to this EX3 guide with all users</li>
            <li>Confirm who the internal super-users are (people who help colleagues)</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">6</div>
          <div class="phase-title">Go-Live & Hypercare</div>
          <div class="phase-weeks">Weeks 8&ndash;12</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Go-live day is just the beginning. The hypercare period (2&ndash;4 weeks of close support) is where most issues surface. Be proactive &mdash; check in daily in the first week.</p>
          <ul class="checklist">
            <li>Confirm go-live date with client at least 2 weeks in advance</li>
            <li>Complete final production environment check</li>
            <li>Migrate any agreed historical data</li>
            <li>Send go-live communication to all users</li>
            <li>Be on standby on go-live day</li>
            <li>Daily check-in calls for first week post go-live</li>
            <li>Weekly check-ins for weeks 2&ndash;4</li>
            <li>Log and resolve all post go-live issues</li>
            <li>Handover to support team with full documentation</li>
            <li>Conduct project retrospective with client</li>
            <li>Obtain client satisfaction sign-off</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- SOW -->
    <div class="page" id="page-sow">
      <div class="hero">
        <span class="badge badge-green">SOW Template</span>
        <h1>Statement of Work Template</h1>
        <p>Pre-written scope wording for a standard SAP SuccessFactors Recruiting implementation. Edit the highlighted fields for each client.</p>
      </div>
      <div class="tip"><strong>How to use:</strong> Copy the relevant sections below into your SOW document. Replace anything in [brackets] with client-specific details. Always get this reviewed before sending.</div>

      <div class="sow-box">
        <h2>1. Project Overview</h2>
        <div class="sub">Introductory paragraph for the SOW</div>
        <div class="sow-section">
          <p>This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SAP SuccessFactors Recruiting for [Client Name]. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SAP SuccessFactors Recruiting platform in accordance with [Client Name]'s requirements as agreed during the discovery phase.</p>
        </div>
        <button class="copy-btn" onclick="copyText(this, 'This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SAP SuccessFactors Recruiting for [Client Name]. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SAP SuccessFactors Recruiting platform in accordance with [Client Name]\\'s requirements as agreed during the discovery phase.')">Copy</button>
      </div>

      <div class="sow-box">
        <h2>2. In Scope</h2>
        <div class="sub">What EX3 will deliver &mdash; use this as your standard scope</div>
        <div class="sow-section">
          <h3>Platform Configuration</h3>
          <ul>
            <li>Configuration of company settings, branding, and system preferences</li>
            <li>Creation and configuration of user roles and permissions</li>
            <li>Setup of up to [X] hiring process workflows</li>
            <li>Configuration of up to [X] job templates with custom fields</li>
            <li>Setup of email notification templates (application, interview, rejection, offer)</li>
            <li>Configuration of offer letter templates (up to [X] templates)</li>
            <li>Setup of interview scheduling configuration</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Career Page & Advertising</h3>
          <ul>
            <li>Configuration and branding of the SAP SuccessFactors Recruiting careers page</li>
            <li>Connection of up to [X] job board accounts (e.g. Indeed, LinkedIn)</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>User Setup</h3>
          <ul>
            <li>Creation of up to [X] user accounts</li>
            <li>Assignment of roles and access permissions</li>
            <li>Bulk user import (if applicable)</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Testing</h3>
          <ul>
            <li>Facilitation of User Acceptance Testing (UAT) with agreed test scripts</li>
            <li>Resolution of issues identified during UAT</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Training</h3>
          <ul>
            <li>One Administrator training session (up to 90 minutes)</li>
            <li>One Recruiter training session (up to 60 minutes)</li>
            <li>One Hiring Manager training session (up to 45 minutes)</li>
            <li>Access to the EX3 SAP SF Recruiting Enablement Guide for all users</li>
          </ul>
        </div>
        <div class="sow-section">
          <h3>Go-Live Support</h3>
          <ul>
            <li>Go-live readiness review and final checks</li>
            <li>Hypercare support for [2/4] weeks post go-live</li>
            <li>Post-implementation documentation and handover</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>3. Out of Scope</h2>
        <div class="sub">Be explicit about what's NOT included to avoid scope creep</div>
        <div class="sow-section">
          <ul>
            <li>Migration of historical candidate or job data (unless separately agreed)</li>
            <li>Custom development, API builds, or bespoke integrations not listed above</li>
            <li>SAP SuccessFactors Recruiting platform licensing costs (to be contracted directly)</li>
            <li>Ongoing managed services or system administration after the hypercare period</li>
            <li>Training beyond the sessions defined above</li>
            <li>Changes to scope agreed after project kick-off (subject to change request process)</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>4. Client Responsibilities</h2>
        <div class="sub">What the client must provide &mdash; critical to include</div>
        <div class="sow-section">
          <ul>
            <li>Appoint an internal project owner with authority to make decisions</li>
            <li>Complete the Discovery Questionnaire within [X] days of kickoff</li>
            <li>Provide timely feedback and approvals at each phase gate</li>
            <li>Ensure key stakeholders are available for scheduled sessions</li>
            <li>Provide IT access and credentials required for integrations</li>
            <li>Provide brand assets (logo, colour palette, imagery) for career page setup</li>
            <li>Complete UAT and provide written sign-off within [X] days</li>
            <li>Ensure all users attend or watch their relevant training session</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>5. Assumptions</h2>
        <div class="sub">Protect yourself &mdash; state what you're assuming to be true</div>
        <div class="sow-section">
          <ul>
            <li>The client holds a valid SAP SuccessFactors Recruiting licence for the duration of the project</li>
            <li>A named internal project owner will be available throughout the engagement</li>
            <li>Client feedback and approvals will be provided within 3 business days of request</li>
            <li>All integrations use standard SAP SuccessFactors Recruiting connectors &mdash; no custom development required</li>
            <li>The number of users, templates, and workflows does not exceed the quantities stated above</li>
            <li>Go-live will occur within [X] weeks of project start &mdash; delays caused by the client may impact timelines and costs</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- ROLES -->
    <div class="page" id="page-roles">
      <div class="hero">
        <span class="badge badge-purple">Stakeholders</span>
        <h1>Roles & Responsibilities</h1>
        <p>Who needs to be involved, what they're responsible for, and when you need them.</p>
      </div>
      <div class="role-grid">
        <div class="role-card sel" onclick="selectRole(this,'role-consultant')"><h3>EX3 Consultant</h3><p>That's you</p></div>
        <div class="role-card" onclick="selectRole(this,'role-hr')"><h3>HR Director / Owner</h3><p>Client side</p></div>
        <div class="role-card" onclick="selectRole(this,'role-it')"><h3>IT / System Admin</h3><p>Client side</p></div>
        <div class="role-card" onclick="selectRole(this,'role-recruiter')"><h3>Lead Recruiter</h3><p>Client side</p></div>
        <div class="role-card" onclick="selectRole(this,'role-hm')"><h3>Hiring Manager</h3><p>Client side</p></div>
      </div>

      <div class="role-content active" id="role-consultant">
        <h2 class="section-title">EX3 Consultant</h2>
        <p class="section-sub">Your responsibilities across the implementation.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Lead discovery sessions and gather requirements</td><td>Week 1&ndash;2</td></tr>
          <tr><td>Own and maintain the project plan</td><td>Throughout</td></tr>
          <tr><td>Configure the SAP SuccessFactors Recruiting platform</td><td>Week 2&ndash;4</td></tr>
          <tr><td>Set up and test all integrations</td><td>Week 3&ndash;5</td></tr>
          <tr><td>Facilitate UAT and manage issue log</td><td>Week 5&ndash;7</td></tr>
          <tr><td>Deliver training sessions</td><td>Week 6&ndash;8</td></tr>
          <tr><td>Support go-live and hypercare period</td><td>Week 8&ndash;12</td></tr>
          <tr><td>Produce handover documentation</td><td>End of project</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-hr">
        <h2 class="section-title">HR Director / Project Owner</h2>
        <p class="section-sub">The most important person on the client side. They make decisions and unblock things.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Sign off project scope and SOW</td><td>Before kickoff</td></tr>
          <tr><td>Attend kickoff and key milestone sessions</td><td>Week 1, 7, go-live</td></tr>
          <tr><td>Make decisions on hiring process design</td><td>Week 1&ndash;3</td></tr>
          <tr><td>Approve offer templates and approval chains</td><td>Week 3&ndash;4</td></tr>
          <tr><td>Provide UAT sign-off</td><td>Week 5&ndash;7</td></tr>
          <tr><td>Champion the system internally</td><td>Throughout</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-it">
        <h2 class="section-title">IT / System Administrator</h2>
        <p class="section-sub">Needed mainly for integrations and SSO. Engage them early &mdash; they're often the bottleneck.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Provide HRIS credentials and integration access</td><td>Week 3</td></tr>
          <tr><td>Configure SSO (if required)</td><td>Week 3&ndash;4</td></tr>
          <tr><td>Whitelist SAP SuccessFactors Recruiting domains on firewall</td><td>Week 2</td></tr>
          <tr><td>Support data migration (if applicable)</td><td>Week 7&ndash;8</td></tr>
          <tr><td>Attend integration testing sessions</td><td>Week 4&ndash;5</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-recruiter">
        <h2 class="section-title">Lead Recruiter</h2>
        <p class="section-sub">Your day-to-day contact. They know the current process better than anyone.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Map current recruitment process during discovery</td><td>Week 1&ndash;2</td></tr>
          <tr><td>Review and approve hiring process configuration</td><td>Week 3&ndash;4</td></tr>
          <tr><td>Lead UAT testing for recruiter workflows</td><td>Week 5&ndash;6</td></tr>
          <tr><td>Attend recruiter training session</td><td>Week 6&ndash;8</td></tr>
          <tr><td>Become internal super-user post go-live</td><td>Week 8+</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-hm">
        <h2 class="section-title">Hiring Manager</h2>
        <p class="section-sub">Often the hardest to engage. Keep their involvement minimal and targeted.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Attend hiring manager training session</td><td>Week 6&ndash;8</td></tr>
          <tr><td>Complete UAT for hiring manager workflows</td><td>Week 5&ndash;7</td></tr>
          <tr><td>Provide feedback on job approval workflow</td><td>Week 3</td></tr>
        </table>
      </div>
    </div>

    <!-- CHECKLISTS -->
    <div class="page" id="page-checklists">
      <div class="hero">
        <span class="badge badge-amber">Checklists</span>
        <h1>Implementation Checklists</h1>
        <p>Use these before each phase gate to make sure nothing is missed.</p>
      </div>
      <h2 class="section-title" style="margin-bottom:16px">Pre Go-Live Checklist</h2>
      <div style="background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:24px">
        <ul class="checklist" id="pre-golive-list">
          <li onclick="toggleCheck(this)">All hiring processes configured and tested</li>
          <li onclick="toggleCheck(this)">All user accounts created and roles assigned</li>
          <li onclick="toggleCheck(this)">Email templates reviewed and approved by client</li>
          <li onclick="toggleCheck(this)">Offer templates reviewed and approved by client</li>
          <li onclick="toggleCheck(this)">Career page live and branded correctly</li>
          <li onclick="toggleCheck(this)">All integrations tested with real data</li>
          <li onclick="toggleCheck(this)">UAT completed and written sign-off received</li>
          <li onclick="toggleCheck(this)">All training sessions completed</li>
          <li onclick="toggleCheck(this)">Go-live communication sent to all users</li>
          <li onclick="toggleCheck(this)">Hypercare plan agreed with client</li>
          <li onclick="toggleCheck(this)">Support contact and escalation path documented</li>
        </ul>
      </div>

      <h2 class="section-title" style="margin-bottom:16px">Discovery Questionnaire</h2>
      <div style="background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:24px">
        <p style="font-size:13px;color:#555;margin-bottom:12px">Send this to the client before or at kickoff. Their answers drive your configuration decisions.</p>
        <ul class="checklist">
          <li>How many open roles do you typically have at any one time?</li>
          <li>How many recruiters will use the system?</li>
          <li>How many hiring managers will need access?</li>
          <li>What does your current hiring process look like? (stages)</li>
          <li>Do different job types have different hiring processes?</li>
          <li>Who approves job postings before they go live?</li>
          <li>Who is involved in approving offers?</li>
          <li>Which job boards do you currently advertise on?</li>
          <li>Do you have an existing HRIS system? (Workday, SAP, BambooHR etc.)</li>
          <li>Do you require Single Sign-On (SSO)?</li>
          <li>Do you use a background screening provider?</li>
          <li>Do you have historical candidate data to migrate?</li>
          <li>What does your employer brand look like? (logo, colours)</li>
          <li>Are there compliance or data retention requirements we need to know about?</li>
        </ul>
      </div>
    </div>

    <!-- FAQ -->
    <div class="page" id="page-faq">
      <div class="hero">
        <span class="badge badge-gray">FAQ</span>
        <h1>FAQ & Troubleshooting</h1>
        <p>Common questions and problems you'll encounter on implementations.</p>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">How long should a SAP SuccessFactors Recruiting implementation take?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">For a standard mid-size company (50&ndash;500 employees, no complex integrations), expect 8&ndash;10 weeks. Larger organisations or those requiring HRIS integrations, SSO, or data migration should plan for 10&ndash;16 weeks. The biggest variable is client responsiveness &mdash; decisions that take a week instead of a day add up fast.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What's the most common cause of implementations going over time?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">Slow client decision-making. When no one has authority to approve the hiring process design or sign off UAT, the project stalls. Always confirm who the decision-maker is at kickoff and get it in writing in the SOW under Client Responsibilities.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What should go in the SOW scope?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">The scope should cover: platform configuration, user setup, integrations (list each one explicitly), career page setup, UAT facilitation, training sessions (specify how many and which roles), go-live support, and hypercare duration. Always include an Out of Scope section &mdash; data migration, custom development, and additional training are common areas where clients assume it's included when it isn't.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What integrations does SAP SuccessFactors Recruiting support out of the box?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">SAP SuccessFactors Recruiting has a large marketplace of native integrations including: Indeed, LinkedIn, Glassdoor (job boards), Workday, SAP SuccessFactors, BambooHR (HRIS), Sterling, Checkr (background screening), Okta, Azure AD (SSO), DocuSign, and many more. Always check the SAP SuccessFactors Recruiting Marketplace for the latest list. Custom integrations via API are out of scope for a standard implementation.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">Client wants to change scope mid-project &mdash; what do I do?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">Raise a Change Request. Never agree to scope changes verbally. Document what's being added, the impact on timeline and cost, and get it signed off before doing the work. If the change is minor (e.g. one extra email template), use your judgement &mdash; but anything that adds meaningful effort should go through a formal change request.</p></div>
      </div>
    </div>

  </main>
</div>

<script>
  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
    document.getElementById('page-' + id).classList.add('active');
    event.target.classList.add('active');
  }
  function togglePhase(header) {
    const body = header.nextElementSibling;
    const chevron = header.querySelector('.phase-chevron');
    body.classList.toggle('open');
    chevron.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : '';
  }
  function selectRole(card, contentId) {
    document.querySelectorAll('.role-card').forEach(c => c.classList.remove('sel'));
    document.querySelectorAll('.role-content').forEach(c => c.classList.remove('active'));
    card.classList.add('sel');
    document.getElementById(contentId).classList.add('active');
  }
  function toggleCheck(li) {
    if (li.style.textDecoration === 'line-through') {
      li.style.textDecoration = '';
      li.style.color = '';
      li.style.opacity = '';
      li.querySelector ? null : null;
      li.childNodes[0] && (li.childNodes[0].textContent = 'â˜');
    } else {
      li.style.textDecoration = 'line-through';
      li.style.color = '#aaa';
    }
  }
  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  }
</script>

<!-- Demo Panel -->
<style>
  .demo-fab { position:fixed; bottom:28px; right:28px; z-index:9000; background:#22c55e; color:#000; border:none; border-radius:50px; padding:12px 22px; font-family:'Sora',sans-serif; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 4px 20px rgba(34,197,94,.35); transition:all .2s; }
  .demo-fab:hover { transform:translateY(-2px); box-shadow:0 6px 24px rgba(34,197,94,.45); }
  .demo-fab.open { background:#1a1a1a; color:#fff; box-shadow:none; }
  .demo-panel { position:fixed; top:0; right:0; width:340px; height:100vh; background:#0f0f0f; color:#fff; z-index:8999; display:flex; flex-direction:column; transform:translateX(100%); transition:transform .3s cubic-bezier(.4,0,.2,1); box-shadow:-8px 0 40px rgba(0,0,0,.3); font-family:'Sora',sans-serif; }
  .demo-panel.open { transform:translateX(0); }
  .dp-header { padding:18px 20px 14px; border-bottom:1px solid #1e1e1e; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
  .dp-logo { font-size:13px; font-weight:700; color:#22c55e; }
  .dp-timer { font-size:18px; font-weight:800; color:#22c55e; font-variant-numeric:tabular-nums; }
  .dp-progress { height:2px; background:#1a1a1a; flex-shrink:0; }
  .dp-progress-fill { height:100%; background:#22c55e; transition:width .4s; }
  .dp-body { flex:1; overflow-y:auto; padding:20px; }
  .dp-tag { font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#22c55e; margin-bottom:10px; }
  .dp-title { font-size:20px; font-weight:800; line-height:1.2; margin-bottom:8px; letter-spacing:-.5px; }
  .dp-sub { font-size:12.5px; color:#666; margin-bottom:18px; line-height:1.6; }
  .dp-points { list-style:none; display:flex; flex-direction:column; gap:11px; margin-bottom:20px; }
  .dp-points li { display:flex; gap:10px; font-size:12.5px; color:#bbb; line-height:1.6; }
  .dp-dot { width:6px; height:6px; background:#22c55e; border-radius:50%; flex-shrink:0; margin-top:7px; }
  .dp-note { background:#141414; border:1px solid #1e1e1e; border-radius:10px; padding:14px; font-size:11.5px; color:#555; line-height:1.65; font-style:italic; }
  .dp-nav { padding:14px 20px; border-top:1px solid #1a1a1a; display:flex; gap:10px; flex-shrink:0; }
  .dp-btn { flex:1; padding:10px; border-radius:8px; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; border:1px solid #2a2a2a; background:#1a1a1a; color:#fff; transition:background .15s; }
  .dp-btn:hover:not(:disabled) { background:#222; }
  .dp-btn.primary { background:#22c55e; color:#000; border-color:#22c55e; }
  .dp-btn.primary:hover { opacity:.9; }
  .dp-btn:disabled { opacity:.25; cursor:not-allowed; }
  .dp-step-count { text-align:center; font-size:11px; color:#444; padding:8px 0 0; flex-shrink:0; }
</style>

<button class="demo-fab" id="demoFab" onclick="toggleDemoPanel()">&#9654; Start Demo</button>

<div class="demo-panel" id="demoPanel">
  <div class="dp-header">
    <div class="dp-logo">EX3 Demo Mode</div>
    <div class="dp-timer" id="dp-timer">00:00</div>
  </div>
  <div class="dp-progress"><div class="dp-progress-fill" id="dp-prog"></div></div>
  <div class="dp-body" id="dp-body"></div>
  <div class="dp-step-count" id="dp-count"></div>
  <div class="dp-nav">
    <button class="dp-btn" id="dp-prev" onclick="dpGo(-1)">&#8592; Prev</button>
    <button class="dp-btn primary" id="dp-next" onclick="dpGo(1)">Next &#8594;</button>
  </div>
</div>

<script>
const dpSteps = [
  {
    tag: 'Consultant Portal',
    title: 'The Implementation Command Centre',
    subtitle: 'Everything an EX3 consultant needs to run a flawless implementation &mdash; in one place.',
    points: [
      'Covers every phase of a SAP SuccessFactors Recruiting implementation end to end',
      'Built from real EX3 project experience &mdash; not generic advice',
      'Role matrix, UAT checklist, and FAQ all in one place',
      'Accessible anywhere &mdash; consultants use this live on client calls',
    ],
    note: 'Open with the overview visible. Let them read the phase list before you start clicking.',
  },
  {
    tag: 'Discovery Phase',
    title: 'Phase 1: Discovery',
    subtitle: 'Before any configuration starts, we need to understand the client inside out.',
    points: [
      'Map the client hiring process end-to-end before touching the platform',
      'Run a structured discovery session using the EX3 questionnaire',
      'Identify integrations, job boards, and data migration requirements upfront',
      'Agreeing scope here prevents scope creep later &mdash; this phase is critical',
    ],
    note: 'Click into the Discovery phase card. Walk through the key activities listed.',
  },
  {
    tag: 'Configuration Phase',
    title: 'Phase 2: Configuration',
    subtitle: 'This is where SAP SuccessFactors Recruiting is built out to match what was agreed in discovery.',
    points: [
      'Users, roles, and permissions set up first &mdash; everything else depends on this',
      'Hiring workflows built to match each job type the client uses',
      'Email templates, offer letters, and job templates configured to their brand',
      'Every config decision is documented for the handover pack',
    ],
    note: 'Show the configuration checklist. Each item maps to a deliverable in the SOW.',
  },
  {
    tag: 'Integrations Phase',
    title: 'Phase 3: Integrations',
    subtitle: 'Connecting SAP SuccessFactors Recruiting to the rest of the client tech stack.',
    points: [
      'HRIS, SSO, background screening, DocuSign &mdash; all require IT involvement from the client',
      'Engage the client IT team at kickoff &mdash; do not wait until integration phase starts',
      'Each integration is tested end-to-end before UAT begins',
      'Standard marketplace connectors only &mdash; custom dev is out of scope unless agreed',
    ],
    note: 'Show the integrations section. Highlight the note about engaging IT early.',
  },
  {
    tag: 'UAT Phase',
    title: 'Phase 4: User Acceptance Testing',
    subtitle: 'The client signs off before we go anywhere near go-live.',
    points: [
      'UAT is run by the client, supported by EX3 &mdash; not the other way around',
      'Test scripts provided covering every hiring workflow and user role',
      'Critical issues must be resolved before go-live &mdash; no exceptions',
      'Written sign-off obtained from the project owner before the go-live date is confirmed',
    ],
    note: 'Click on the UAT checklist. Show how each item is tracked.',
  },
  {
    tag: 'Training Phase',
    title: 'Phase 5: Training',
    subtitle: 'Separate sessions per role &mdash; never mix admins and hiring managers in the same room.',
    points: [
      'Admin training: 90 mins covering configuration, user management, and reporting',
      'Recruiter training: 60 mins covering end-to-end hiring and candidate management',
      'Hiring Manager training: 45 mins covering review, approval, and interview scheduling',
      'Sessions recorded and uploaded so new starters can watch them later',
    ],
    note: 'Show the training section. Emphasise the role-specific approach.',
  },
  {
    tag: 'Go-Live & Hypercare',
    title: 'Phase 6: Go-Live',
    subtitle: "The moment the client goes live &mdash; and when the real work begins.",
    points: [
      'Go-live readiness review with the client project owner the day before',
      'EX3 consultant on call on go-live day &mdash; available for any critical issues',
      'Hypercare period: daily check-ins week one, weekly thereafter',
      'Formal handover pack and close-out documentation delivered at end of hypercare',
    ],
    note: 'End on this slide. The hypercare point is a differentiator &mdash; competitors often disappear post go-live.',
  },
];

let dpCur = 0;
let dpOpen = false;
let dpStart = null;
let dpTimer = null;

function toggleDemoPanel() {
  dpOpen = !dpOpen;
  document.getElementById('demoPanel').classList.toggle('open', dpOpen);
  document.getElementById('demoFab').classList.toggle('open', dpOpen);
  document.getElementById('demoFab').textContent = dpOpen ? 'âœ• Exit Demo' : 'â–¶ Start Demo';
  if (dpOpen && !dpStart) {
    dpStart = Date.now();
    dpTimer = setInterval(() => {
      const s = Math.floor((Date.now() - dpStart) / 1000);
      document.getElementById('dp-timer').textContent =
        String(Math.floor(s / 60)).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
    }, 1000);
    dpRender();
  }
  if (!dpOpen && dpTimer) { clearInterval(dpTimer); dpTimer = null; dpStart = null; }
}

function dpRender() {
  const s = dpSteps[dpCur];
  const pct = Math.round(((dpCur + 1) / dpSteps.length) * 100);
  document.getElementById('dp-prog').style.width = pct + '%';
  document.getElementById('dp-count').textContent = 'Step ' + (dpCur + 1) + ' of ' + dpSteps.length;
  document.getElementById('dp-prev').disabled = dpCur === 0;
  document.getElementById('dp-next').textContent = dpCur === dpSteps.length - 1 ? 'Finish âœ“' : 'Next â†’';
  document.getElementById('dp-body').innerHTML =
    '<div class="dp-tag">' + String(dpCur+1).padStart(2,'0') + ' / ' + String(dpSteps.length).padStart(2,'0') + ' &mdash; ' + s.tag + '</div>' +
    '<div class="dp-title">' + s.title + '</div>' +
    '<div class="dp-sub">' + s.subtitle + '</div>' +
    '<ul class="dp-points">' + s.points.map(p => '<li><span class="dp-dot"></span><span>' + p + '</span></li>').join('') + '</ul>' +
    '<div class="dp-note">' + s.note + '</div>';
}

function dpGo(dir) {
  dpCur = Math.max(0, Math.min(dpSteps.length - 1, dpCur + dir));
  dpRender();
  if (dir === 1 && dpCur === dpSteps.length - 1) {
    setTimeout(() => { if (confirm('Demo complete! Exit demo mode?')) toggleDemoPanel(); }, 300);
  }
}

document.addEventListener('keydown', e => {
  if (!dpOpen) return;
  if (e.key === 'ArrowRight') dpGo(1);
  if (e.key === 'ArrowLeft') dpGo(-1);
  if (e.key === 'Escape') toggleDemoPanel();
});

  window.addEventListener('message', function(e){
    if(!e.data || e.data.type !== 'EX3_DEMO') return;
    var d = e.data;
    if(d.action === 'showPhases') showPage('phases');
    if(d.action === 'openPhase'){
      showPage('phases');
      setTimeout(function(){
        var headers = document.querySelectorAll('.phase-header');
        if(headers[d.index]) headers[d.index].click();
      }, 300);
    }
  });
</script>
</body>
</html>`);
});

// SOW AI Generation
app.post('/consultant/sow-ai', async (req, res) => {
  const { answers } = req.body;
  if (!answers) return res.status(400).json({ error: 'No answers provided' });

  const integrations = Array.isArray(answers.integrations) ? answers.integrations.join(', ') : answers.integrations || 'none';
  const jobBoards = Array.isArray(answers.jobBoards) ? answers.jobBoards.join(', ') : answers.jobBoards || 'none';
  const training = Array.isArray(answers.training) ? answers.training.join('; ') : answers.training || 'none';

  const prompt = `You are a senior implementation consultant writing a formal Statement of Work for a SAP SuccessFactors Recruiting ATS implementation. Write a complete, professional SOW based on these project details:

Client: ${answers.clientName}
Organisation size: ${answers.orgSize}
Number of users: ${answers.numUsers}
Hiring process workflows: ${answers.numProcesses}
Job templates: ${answers.numTemplates}
Integrations: ${integrations}
Job boards: ${jobBoards}
Career page: ${answers.careerPage}
Data migration: ${answers.dataMigration}
Training: ${training}
Hypercare period: ${answers.hypercare}
Project timeline: ${answers.timeline}

Write a complete SOW with these sections: 1. Project Overview, 2. In Scope (with subsections), 3. Out of Scope, 4. Client Responsibilities, 5. Assumptions, 6. Change Request Process.

Use formal, specific, commercial language. Be concrete &mdash; include the exact numbers, integrations, and timelines provided. Make it ready to send directly to the client. Do not use placeholder text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of completion) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) res.write(text);
    }
    res.end();
  } catch (err) {
    console.error('SOW AI error:', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// SOW Word Export
app.post('/consultant/sow-export', async (req, res) => {
  const { answers: a, clientName: rawClient } = req.body;
  if (!a) return res.status(400).json({ error: 'No answers' });

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle, VerticalAlign
  } = require('docx');

  const clientName = rawClient || a.clientName || 'To be confirmed';

  // â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 120 } });
  const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 80 } });
  const h3 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 60 } });
  const body = (text) => new Paragraph({ children: [new TextRun({ text, size: 22 })], spacing: { after: 120 } });
  const bullet = (text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 80 } });
  const spacer = () => new Paragraph({ text: '' });

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const headerBorder = { style: BorderStyle.SINGLE, size: 8, color: '0F0F0F' };

  function twoColTable(rows, shade1 = 'F5F5F5') {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map((r, idx) => new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: noBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : {},
            verticalAlign: VerticalAlign.TOP,
            children: [new Paragraph({ children: [new TextRun({ text: r[0], size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : '000000' })], spacing: { before: 80, after: 80 } })],
          }),
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: noBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : {},
            verticalAlign: VerticalAlign.TOP,
            children: [new Paragraph({ children: [new TextRun({ text: r[1], size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : '000000' })], spacing: { before: 80, after: 80 } })],
          }),
        ],
      })),
    });
  }

  function raciTable(rows) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map((r, idx) => new TableRow({
        children: [
          new TableCell({
            width: { size: 70, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: noBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : (idx % 2 === 0 ? { fill: 'FAFAFA' } : {}),
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: r[0], size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : '000000' })], spacing: { before: 60, after: 60 } })],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: thinBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : (r[1] ? { fill: 'E8F5E9' } : {}),
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: r[1] || '', size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : r[1] ? '1B5E20' : '000000' })], alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } })],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            borders: { top: idx === 0 ? headerBorder : thinBorder, bottom: thinBorder, left: thinBorder, right: noBorder },
            shading: idx === 0 ? { fill: '0F0F0F' } : (r[2] ? { fill: 'E8F5E9' } : {}),
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: r[2] || '', size: 20, bold: idx === 0, color: idx === 0 ? 'FFFFFF' : r[2] ? '1B5E20' : '000000' })], alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } })],
          }),
        ],
      })),
    });
  }

  // â”€â”€ derived flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const integrationsList = Array.isArray(a.integrations) ? a.integrations : [];
  const jobBoardsList = Array.isArray(a.jobBoards) ? a.jobBoards : [];
  const trainingList = Array.isArray(a.training) ? a.training : [];
  const complianceList = Array.isArray(a.compliance) ? a.compliance : [];
  const isMiddleEast = !!(a.geoScope && a.geoScope.indexOf('Middle East') >= 0);
  const hasCareerPage = !!(a.careerPage && a.careerPage.indexOf('not in scope') < 0 && a.careerPage.indexOf('not required') < 0);
  const hasOfferMgmt = !!(a.offerMgmt && a.offerMgmt.indexOf('Not in scope') < 0 && a.offerMgmt.indexOf('not in scope') < 0);
  const hasAgency = !!(a.agencyPortal && a.agencyPortal.indexOf('No external') < 0);
  const hasDocuSign = integrationsList.some(i => i.indexOf('DocuSign') >= 0 || i.indexOf('e-signature') >= 0);
  const hasSFEC = integrationsList.some(i => i.indexOf('Employee Central') >= 0 || i.indexOf('SAP SuccessFactors') >= 0);
  const hasMigration = !!(a.dataMigration && a.dataMigration.toLowerCase().indexOf('not in scope') < 0 && a.dataMigration.toLowerCase().indexOf('no migration') < 0 && a.dataMigration.toLowerCase().indexOf('no data') < 0);

  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dateStr = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();

  const children = [];

  // â”€â”€ TITLE PAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(new Paragraph({
    children: [new TextRun({ text: 'SAP SuccessFactors Recruiting Recruiting Implementation', bold: true, size: 52, color: '0F0F0F' })],
    alignment: AlignmentType.CENTER, spacing: { before: 720, after: 160 }
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'via EXcelerate', size: 36, italics: true, color: '444444' })],
    alignment: AlignmentType.CENTER, spacing: { after: 480 }
  }));
  children.push(spacer());
  children.push(twoColTable([
    ['Client', clientName],
    ['Prepared by', 'EX3'],
    ['Date', dateStr],
    ['Version', '1.0 (Draft)'],
  ]));
  children.push(spacer());

  // â”€â”€ OVERVIEW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Overview'));
  children.push(body('EX3 has been asked to provide a Statement of Work for the SAP SuccessFactors Recruiting implementation for ' + clientName + '. This section outlines the scope, methodology, responsibilities, and deliverables for the SAP SuccessFactors Recruiting deployment.'));
  children.push(spacer());
  children.push(body('The modules in scope for this workstream are:'));
  children.push(bullet('SAP SuccessFactors Recruiting Recruiting Management (SMRC)'));
  if (hasCareerPage) children.push(bullet('Career Site / Recruiting Marketing configuration'));
  if (integrationsList.length > 0) children.push(bullet('Integration to ' + (hasSFEC ? 'Employee Central (EC), Position Management, and Onboarding' : integrationsList.join('; '))));
  children.push(spacer());
  if (isMiddleEast) {
    children.push(body('The countries in scope are:'));
    children.push(bullet('United Arab Emirates'));
    children.push(bullet('Saudi Arabia'));
    children.push(bullet('Oman'));
    children.push(bullet('Jordan'));
    children.push(bullet('Lebanon'));
    children.push(bullet('Iraq'));
    children.push(spacer());
  }
  children.push(body('EX3 will apply the EXcelerate methodology, which is optimised for rapid deployment using model company content. EXcelerate is designed to deliver a high-quality SAP SuccessFactors Recruiting implementation efficiently, leveraging EX3\'s pre-built assets as a baseline while allowing for configuration aligned to ' + clientName + '\'s hiring processes.'));

  // â”€â”€ PERIOD OF PERFORMANCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Period of Performance'));
  children.push(body('The Services for the SAP SuccessFactors Recruiting workstream shall take place within ' + (a.timeline || 'a timeline to be agreed') + ' of SOW execution and will run in parallel with the broader implementation.'));
  children.push(spacer());
  children.push(body('Organisation profile:'));
  children.push(bullet('Organisation size: ' + (a.orgSize || 'To be confirmed')));
  children.push(bullet('Geography: ' + (a.geoScope ? a.geoScope.split('.')[0] : 'To be confirmed')));
  children.push(bullet('Platform language: English only'));
  children.push(bullet('Users in scope: ' + (a.numUsers || 'To be confirmed')));

  // â”€â”€ ENGAGEMENT RESOURCES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Engagement Resources'));
  children.push(body('As part of this engagement, EX3 will assign the required resources. Resources will have experience of the SAP SuccessFactors Recruiting platform and enterprise talent acquisition implementations.'));
  children.push(spacer());
  children.push(body('Key information on our resources:'));
  children.push(bullet('All resources have worked effectively as remote resources on projects scaling from small to very large global implementations'));
  children.push(bullet('Resources will have experience of the SAP SuccessFactors Recruiting platform and relevant TA processes'));
  children.push(bullet('Resources have global and Middle East regional experience'));
  children.push(bullet('Resources and responsibilities are subject to change throughout the project'));
  children.push(spacer());
  children.push(body('The EX3 implementation team shall engage with the Customer no later than four (4) weeks from SOW execution. Delivery dates for tasks included in this SOW shall be based upon mutual agreement as documented within an approved project schedule.'));

  // â”€â”€ METHODOLOGY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Implementation Methodology, Services & Responsibilities'));
  children.push(body('EX3 has created its own implementation methodology, EXcelerate, which incorporates both industry best practices and lessons learned from our years of experience doing high quality SAP SuccessFactors Recruiting implementations.'));
  children.push(spacer());
  children.push(body('EXcelerate is structured across the following phases:'));
  children.push(spacer());
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: ['Examine','Adopt','Validate','Launch'].map((ph, i) => new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        borders: { top: headerBorder, bottom: headerBorder, left: i === 0 ? noBorder : thinBorder, right: noBorder },
        shading: { fill: '0F0F0F' },
        children: [new Paragraph({ children: [new TextRun({ text: ph, bold: true, size: 22, color: 'FFFFFF' })], alignment: AlignmentType.CENTER, spacing: { before: 80, after: 80 } })],
      })) }),
      new TableRow({ children: [
        ['Kick-off, requirements, process mapping, design sign-off, integration scoping'],
        ['Platform config: route maps, job templates, user roles, offer mgmt, career site, integrations, data migration'],
        ['UAT test scripts, facilitation, defect resolution, written sign-off prior to go-live'],
        ['Go-live readiness review, production cutover, training, Hypercare support'],
      ].map((t, i) => new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        borders: { top: thinBorder, bottom: thinBorder, left: i === 0 ? noBorder : thinBorder, right: noBorder },
        verticalAlign: VerticalAlign.TOP,
        children: [new Paragraph({ children: [new TextRun({ text: t[0], size: 18 })], spacing: { before: 80, after: 80 } })],
      })) }),
    ],
  }));
  children.push(spacer());

  // Phase detail helper
  function phaseSection(phaseName, desc, taskRows, delivRows) {
    children.push(h2(phaseName));
    children.push(body(desc));
    children.push(spacer());
    children.push(h3('Key Tasks'));
    children.push(twoColTable([['Client and EX3', 'EX3'], ...taskRows]));
    children.push(spacer());
    children.push(h3('Deliverables'));
    children.push(twoColTable([['Client', 'EX3'], ...delivRows]));
    children.push(spacer());
  }

  phaseSection(
    'Examine Phase',
    'The purpose of the Examine Phase is to establish the framework for a successful project, confirm platform design, map hiring processes, and sign off the configuration blueprint before Adopt commences.',
    [
      ['Review Examine findings and agree configuration blueprint', 'Lead kick-off workshop and process mapping sessions'],
      ['Confirm route map stages and approval chain definitions', 'Produce platform design document for sign-off'],
      ['Sign off RBP access matrix and job template structure', 'Begin integration scoping and data migration assessment'],
    ],
    [
      ['Signed-off configuration blueprint', 'Kick-off and workshop presentations'],
      ['Completed RBP access matrix', 'Platform design sign-off document'],
      ['Approval chain definitions confirmed', 'Data migration assessment report'],
    ]
  );

  phaseSection(
    'Adopt Phase',
    'The purpose of the Adopt Phase is to configure the SAP SuccessFactors Recruiting platform per the agreed design, leveraging EX3 model company content as a baseline. Iterative unit testing occurs throughout this phase.',
    [
      ['Review configuration playbacks and provide timely feedback', 'Configure route maps, job templates, offer management, screening'],
      ['Confirm email copy and brand assets for career site build', 'Configure user accounts, RBP roles, and approval chains'],
      ['Sign off configuration before Validate commences', 'Conduct unit testing and playback sessions'],
    ],
    [
      ['Approved email copy, branding assets, offer letter content', 'Configured SAP SuccessFactors Recruiting sandbox environment'],
      ['Build sign-off', 'Updated configuration workbooks'],
      ['', 'Unit test results and playback docs'],
    ]
  );

  phaseSection(
    'Validate Phase',
    'The purpose of the Validate Phase is to confirm all configured functionality through client-led UAT. Written sign-off is required before go-live proceeds.',
    [
      ['Execute UAT test scripts and log all findings', 'Deliver UAT test scripts and facilitate sessions'],
      ['Coordinate feedback, triage calls, and final UAT sign-off', 'Resolve all Critical and High priority defects within SLA'],
      ['Creation of test users', 'Update configuration workbooks post-UAT'],
    ],
    [
      ['Signed UAT sign-off document', 'UAT test scripts'],
      ['', 'Defect log and resolution summary'],
      ['', 'Updated instance configuration'],
    ]
  );

  phaseSection(
    'Launch Phase',
    'The purpose of the Launch Phase is to move configuration to the production environment, support the go-live, deliver training, and provide post-go-live Hypercare for a smooth transition to BAU.',
    [
      ['PROD smoke test', 'Execute cutover checklist and move configuration to PROD'],
      ['Attend training sessions and complete pre-reading', 'Deliver recruiter, admin and hiring manager training'],
      ['Participate in go-live readiness review', 'Administer Hypercare and project closure'],
    ],
    [
      ['PROD smoke test sign-off', 'Final PROD configuration'],
      ['Project closeout complete', 'Post-implementation handover pack'],
      ['', 'HelpMyCloud Hypercare'],
      ['', 'Completed configuration workbooks'],
    ]
  );

  // â”€â”€ SCOPE OF WORK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Scope of Work'));
  children.push(h2('SAP SuccessFactors Recruiting Recruiting Management Scope &mdash; EXcelerate Deployment'));

  children.push(h3('Route Maps (Hiring Workflows)'));
  children.push(bullet('Configuration of ' + (a.numProcesses || '6&ndash;8') + ' route maps aligned to ' + clientName + ' hiring workflows'));
  children.push(bullet('Stage and status configuration per agreed route map design'));
  children.push(bullet('Rejection reason configuration'));
  children.push(bullet('Route map design to be confirmed and signed off during the Examine Phase'));

  children.push(h3('Job Templates'));
  children.push(bullet('Configuration of ' + (a.numTemplates || '5&ndash;8') + ' job templates with custom fields'));
  children.push(bullet('Department and location hierarchy setup'));
  children.push(bullet('Template structure and field requirements to be confirmed during Examine Phase'));

  children.push(h3('Application Template'));
  children.push(bullet('1 Application Template [Single Stage only &mdash; up to 3 fields additional or amended]'));
  if (a.screening && a.screening.indexOf('not required') < 0) {
    children.push(bullet('Knockout / screening questions: ' + a.screening));
  } else {
    children.push(bullet('Knockout / screening questions: up to 5 standard screening questions per workflow (e.g. right to work, minimum qualifications)'));
  }
  children.push(bullet('Screening question content to be provided by Client prior to configuration'));

  children.push(h3('Offer Management'));
  if (hasOfferMgmt) {
    children.push(bullet('1 Offer Detail Template'));
    children.push(bullet('1 Offer Letter Template'));
    children.push(bullet('Offer approval workflow configuration &mdash; approval chain to be confirmed during Examine Phase'));
    if (hasDocuSign) children.push(bullet('E-signature integration (DocuSign) &mdash; subject to integration scope below'));
  } else {
    children.push(bullet('Offer management is not in scope for this engagement'));
  }

  children.push(h3('Approval Workflows'));
  children.push(bullet('Requisition approval: ' + (a.reqApproval || 'multi-level approval chain (e.g. Line Manager â†’ HR â†’ Finance)')));
  children.push(bullet('Exact approval chain structure to be confirmed and signed off during Examine Phase before Adopt commences'));
  children.push(bullet('Up to ' + (a.numProcesses || '6&ndash;8') + ' approval workflow configurations'));

  children.push(h3('Candidate Profile & Status Pipeline'));
  children.push(bullet('1 Candidate Profile'));
  children.push(bullet('1 Applicant Status Pipeline'));
  children.push(bullet('Candidate profile fields and data capture configuration'));
  children.push(bullet('Status pipeline aligned to agreed route map stages'));
  children.push(bullet('Rejection reason configuration'));

  children.push(h3('Email Templates'));
  children.push(bullet('Up to 20 recruiting email templates (e.g. application received, interview invite, rejection, offer)'));
  children.push(bullet('1 custom declined email template linked to status'));
  children.push(bullet('Client to provide email copy and branding prior to configuration'));

  if (hasAgency) {
    children.push(h3('Agency / Vendor Portal'));
    children.push(bullet('Basic vendor portal configuration including agency account setup and job sharing'));
    children.push(bullet('Agency account setup for up to 5 agreed vendors (client to provide agency list) or training provided on how to set up additional agencies independently'));
    children.push(bullet('Agency submission workflow and visibility controls'));
  }

  children.push(h3('Interview Scheduling'));
  children.push(bullet('Interview scheduling configuration aligned to agreed route map stages'));
  children.push(bullet('Central interview scheduling setup (no Outlook / Google Calendar integration unless separately scoped)'));

  children.push(h3('Referral Management'));
  children.push(bullet('Enablement of SAP SuccessFactors Recruiting standard employee referral portal'));
  children.push(bullet('Employees can view open roles, submit referrals, and track referral status natively within the platform'));
  children.push(bullet('Advanced referral programme features (bonus tracking, leaderboards, automated payments) require a third-party Marketplace integration and are out of scope'));

  children.push(h3('Mobile Enablement'));
  children.push(bullet('Mobile enablement for recruiters and hiring managers via SAP SuccessFactors Recruiting native mobile application (iOS and Android)'));
  children.push(bullet('Mobile-responsive career site configuration included within career site scope'));

  children.push(h3('Recruiting Posting'));
  children.push(bullet('1 Posting Profile'));
  if (jobBoardsList.length > 0) {
    children.push(bullet('Up to ' + Math.min(jobBoardsList.length, 5) + ' job boards: ' + jobBoardsList.slice(0, 5).join(', ')));
  } else {
    children.push(bullet('Up to 5 job boards (to be confirmed during Examine Phase &mdash; e.g. LinkedIn, Indeed, Bayt)'));
  }
  children.push(bullet('Basic field mapping &mdash; 5 key fields'));
  children.push(bullet('Internal posting configuration'));
  children.push(bullet('Standard Internal Careers options'));

  children.push(h3('User Accounts & Role-Based Permissions (RBP)'));
  children.push(bullet('Creation of ' + (a.numUsers || 'agreed number of') + ' user accounts'));
  children.push(bullet('1 Recruiter RBP role (minimal admin permissions)'));
  children.push(bullet('RBP configuration per agreed access matrix'));
  children.push(bullet('EX3 to provide RBP design template; Client to complete and sign off before Adopt commences'));

  children.push(h3('Reporting & Analytics'));
  children.push(bullet('Standard SAP SuccessFactors Recruiting dashboards and out-of-the-box reports'));
  children.push(bullet('Configuration of agreed saved reports and scheduled report distribution'));
  if (a.reporting && a.reporting.indexOf('Standard') < 0 && a.reporting.indexOf('standard') < 0) {
    children.push(bullet(a.reporting));
  } else {
    children.push(bullet('No custom report development is included'));
  }

  if (hasCareerPage) {
    children.push(h2('Recruiting Marketing / Career Site Scope &mdash; EXcelerate Deployment'));
    children.push(bullet('Integration of Recruiting Management and Career Site'));
    children.push(bullet('Field mapping between Recruiting Management and Career Site'));
    children.push(bullet('1 Brand'));
    children.push(bullet('1 Locale (English only)'));
    children.push(bullet('1 Career Site Homepage'));
    children.push(bullet('Up to 8 Category Pages'));
    children.push(bullet('Up to 3 Content Pages'));
    children.push(bullet('Standard career site builder components only &mdash; bespoke front-end development is out of scope'));
    children.push(bullet('Standard job search and apply flow'));
    children.push(bullet('Mobile-responsive career site validation'));
    children.push(bullet('Brand application (logo, colours, imagery) &mdash; Client to provide all assets prior to configuration'));
  }

  children.push(h2('Integrations Scope &mdash; EXcelerate Deployment'));
  children.push(body('The following standard integrations are in scope:'));
  if (integrationsList.length > 0) {
    integrationsList.forEach(i => children.push(bullet(i)));
  } else if (hasSFEC || isMiddleEast) {
    children.push(bullet('Recruitment to Onboarding to Employee Central'));
    children.push(bullet('Integration to Position Management (EC) &mdash; requisition creation from approved positions'));
    children.push(bullet('E-signature / DocuSign &mdash; to be confirmed during Examine Phase'));
  } else {
    children.push(bullet('No third-party integrations in scope for this engagement'));
  }
  children.push(spacer());
  children.push(body('All integrations use standard SAP SuccessFactors Recruiting Marketplace connectors. Custom API builds or non-standard connectors are out of scope and would require a Change Order.'));

  children.push(h2('Data Privacy & Compliance'));
  children.push(bullet('Candidate consent and privacy notice configuration'));
  children.push(bullet('Data retention policy configuration (automated deletion schedules for candidate records)'));
  if (isMiddleEast || complianceList.some(c => c.indexOf('PDPL') >= 0 || c.indexOf('PDPPL') >= 0)) {
    children.push(bullet('Compliance configuration aligned to applicable regional requirements including UAE Personal Data Protection Law (PDPL), Saudi Arabia Personal Data Protection Law (PDPPL), and GDPR where relevant'));
  } else if (complianceList.length > 0) {
    complianceList.forEach(c => children.push(bullet(c)));
  } else {
    children.push(bullet('Standard data privacy defaults will be applied'));
  }
  children.push(bullet('Specific regional compliance requirements to be confirmed during Examine Phase'));

  children.push(h2('Data Migration Scope'));
  if (hasMigration) {
    children.push(bullet(a.dataMigration));
  } else {
    children.push(bullet('Migration of active job requisitions into SAP SuccessFactors Recruiting is included in scope'));
  }
  children.push(bullet('Data mapping document to be agreed during Examine Phase'));
  children.push(bullet('Client responsible for data extraction in the EX3-specified format'));
  children.push(bullet('Migration performed in sandbox environment first for validation before cutover'));
  children.push(bullet('Maximum of 1 test cycle and 1 production migration cycle'));

  children.push(h2('Training Scope'));
  if (trainingList.length > 0) {
    trainingList.forEach(t => children.push(bullet(t)));
  } else {
    children.push(bullet('1 Recruiter training session (up to 60 minutes &mdash; end-to-end hiring workflow, candidate management, communication tools)'));
    children.push(bullet('1 Administrator training session (up to 90 minutes &mdash; system configuration, user management, reporting)'));
    children.push(bullet('1 Hiring Manager training session (up to 45 minutes &mdash; job approval, candidate review, interview scheduling)'));
  }
  children.push(bullet('All users receive access to the EX3 SAP SF Recruiting Enablement Guide'));
  children.push(bullet('Sessions recorded and shared with Client for future reference'));
  children.push(bullet('Training materials provided in advance for pre-reading'));

  children.push(h2('General Scope'));
  children.push(body('Hypercare: ' + (a.hypercare ? a.hypercare + ' of Hypercare Support' : '10 hours or 20 days of Hypercare Support, whichever comes first')));
  children.push(spacer());
  children.push(body('General Assumptions:'));
  children.push(bullet('A 3-tier landscape will be used for the project: DEV, STAGE (Test), and PROD'));
  children.push(bullet(clientName + ' holds a valid SAP SuccessFactors Recruiting licence for the project duration including sandbox/test environments required'));
  children.push(bullet('Testing time will be allocated for both EX3 and the Client in each iteration'));
  children.push(spacer());
  children.push(body('Module Assumptions:'));
  children.push(bullet('We assume all requirements can be met by standard SAP SuccessFactors Recruiting platform functionality. Use of third-party applications not listed in scope would require a Change Order and may impact timelines and cost'));
  children.push(bullet('New requirements arising during the project will be considered additional scope and will require a Change Request (CR)'));
  children.push(bullet('EX3 is not responsible for managing any 3rd party vendors or issues that can only be resolved by a 3rd party'));
  children.push(bullet('The project will be executed using EX3\'s EXcelerate Methodology, document templates, and delivery project tools (Smartsheet)'));

  // â”€â”€ OUT OF SCOPE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Out of Scope'));
  children.push(body('Any item, deliverable or activity not explicitly stated as in scope within this section is to be deemed out of scope for this SOW.'));
  children.push(spacer());
  children.push(body('Other examples of items excluded from scope include:'));
  children.push(bullet('SAP SuccessFactors Recruiting platform licensing fees (contracted directly between ' + clientName + ' and SAP SuccessFactors Recruiting)'));
  children.push(bullet('Any integrations not explicitly listed in the Integrations Scope section'));
  children.push(bullet('Custom API development, bespoke connectors, or non-standard integration builds'));
  children.push(bullet('Outlook or Google Calendar integration for interview scheduling'));
  children.push(bullet('Advanced referral programme features (bonus tracking, leaderboards, automated payments)'));
  children.push(bullet('Ongoing platform administration or managed services after the Hypercare period'));
  children.push(bullet('Additional training sessions beyond those listed in the Training Scope section'));
  children.push(bullet('Custom dashboards and custom reports'));
  children.push(bullet('Any Training Material beyond the EX3 SAP SF Recruiting Enablement Guide'));
  children.push(bullet('Arabic or any language configuration other than English'));
  children.push(bullet('Countries or languages beyond those agreed in scope'));
  children.push(bullet('Recruitment process design or HR consultancy beyond system configuration'));
  children.push(bullet('Content creation (job descriptions, email copy, brand assets, offer letter text)'));
  children.push(bullet('Change Management consulting, communications development, or iterative process mapping'));
  children.push(bullet('Management of client resources or creation of client internal project plans'));
  children.push(bullet('Changes arising from SAP SuccessFactors Recruiting vendor platform updates'));

  // â”€â”€ LANGUAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Languages'));
  children.push(bullet('Platform language translation: English'));
  children.push(bullet('All communications and deliverables will occur in English'));
  children.push(bullet('The SAP SuccessFactors Recruiting career site and all modules will be implemented in English only. Arabic or any additional language configuration is out of scope and would require a Change Order'));

  // â”€â”€ TESTING RACI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Testing'));
  children.push(raciTable([
    ['Activity', 'EX3', 'Client'],
    ['Iterative Unit Testing', 'Responsible', ''],
    ['Systems Integration Test (where applicable)', 'Responsible', ''],
    ['Creation of Test Users', 'Responsible', ''],
    ['Detailed Test Scenarios in Smartsheets', 'Responsible', ''],
    ['Confirmation of Testing Approach', 'Responsible', ''],
    ['Cutover to TEST', 'Responsible', ''],
    ['Additional smoke testing cycle', '', 'Responsible'],
    ['Cut-over planning', 'Responsible', ''],
    ['Creation of UAT Approach and Plan', '', 'Responsible'],
    ['Coordination of UAT (feedback, defect, calls)', '', 'Responsible'],
    ['UAT execution', '', 'Responsible'],
    ['UAT coordination during UAT', '', 'Responsible'],
    ['Triage / feedback calls with EX3 (daily)', '', 'Responsible'],
    ['Define Test Approach', '', 'Responsible'],
    ['Delivery of Test Strategy Document', '', 'Responsible'],
    ['Click-level Test Scripts', '', 'Responsible'],
    ['Testing Reports for Entry/Exit from each phase', '', 'Responsible'],
    ['All test planning & coordination', '', 'Responsible'],
    ['Full defect management through formal test phases', '', 'Responsible'],
    ['Support for all Test Governance during deployment', '', 'Responsible'],
  ]));

  // â”€â”€ DATA MIGRATION RACI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(h1('Data Migration'));
  children.push(raciTable([
    ['Activity', 'EX3', 'Client'],
    ['Provision of Data Load Templates', 'Responsible', ''],
    ['Basic data validation (general format checks)', 'Responsible', ''],
    ['Performing Data Loads (1 test + 1 production)', 'Responsible', ''],
    ['Admin Training on BAU data loading', 'Responsible', ''],
    ['Confirmation of Data Migration Approach', 'Responsible', ''],
    ['Coordination of data migration tasks', 'Responsible', ''],
    ['Support for extraction process from client systems', '', 'Responsible'],
    ['Support for governance around data migration', '', 'Responsible'],
    ['Delivery of Data Migration Strategy Document', '', 'Responsible'],
    ['Data Transformation to SAP SuccessFactors Recruiting templates', '', 'Responsible'],
    ['Additional cycle of data migration testing', '', 'Responsible'],
    ['Additional training on data loading', '', 'Responsible'],
    ['Data transformation', '', 'Responsible'],
  ]));

  children.push(spacer());
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Prepared by EX3  |  Confidential  |  via EXcelerate', size: 18, color: '888888', italics: true })],
    alignment: AlignmentType.CENTER, spacing: { before: 400, after: 0 }
  }));

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 22 } },
        heading1: { run: { font: 'Arial', size: 28, bold: true, color: '0F0F0F' }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: 'Arial', size: 24, bold: true, color: '222222' }, paragraph: { spacing: { before: 240, after: 80 } } },
        heading3: { run: { font: 'Arial', size: 22, bold: true, color: '444444' }, paragraph: { spacing: { before: 160, after: 60 } } },
      }
    },
    sections: [{ properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = 'SOW_' + clientName.replace(/[^a-z0-9]/gi, '_') + '.docx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(buffer);
});

// SOW Email
app.post('/consultant/sow-email', async (req, res) => {
  const { content, clientName, toEmail } = req.body;
  if (!content || !toEmail) return res.status(400).json({ error: 'Missing fields' });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'EX3 Consulting <onboarding@resend.dev>',
        to: [toEmail],
        subject: 'Statement of Work &mdash; SAP SuccessFactors Recruiting Implementation &mdash; ' + (clientName || 'Client'),
        text: content,
        html: '<pre style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;white-space:pre-wrap">' + content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>',
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Send failed');
    res.json({ ok: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// SOW Builder
app.all('/consultant/sow-builder', requireConsultantPin);
app.get('/consultant/sow-builder', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SOW Builder &mdash; EX3</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Sora',sans-serif;background:#f8f7f4;color:#0f0f0e;min-height:100vh;display:flex;flex-direction:column}
    .topbar{background:#0f0f0f;color:#fff;padding:14px 32px;display:flex;align-items:center;justify-content:space-between}
    .topbar .logo{font-size:24px;font-weight:900;letter-spacing:-.1em}
    .topbar a{color:#aaa;font-size:13px;text-decoration:none;transition:color .15s}
    .topbar a:hover{color:#fff}
    .progress-wrap{background:#1a1a1a;padding:0 32px}
    .progress-bar{height:3px;background:#333;border-radius:2px;overflow:hidden}
    .progress-fill{height:100%;background:#fff;border-radius:2px;transition:width .4s ease}
    .progress-label{padding:8px 0;font-size:11px;color:#888;letter-spacing:.06em;text-transform:uppercase}
    .wizard{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 20px}
    .card{background:#fff;border:1px solid #e4e2dc;border-radius:14px;padding:40px 44px;width:100%;max-width:620px;box-shadow:0 2px 16px rgba(0,0,0,.06)}
    .step{display:none}.step.active{display:block}
    .step-num{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#aaa;margin-bottom:10px}
    .step h2{font-size:24px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px}
    .step p{font-size:14px;color:#666;margin-bottom:28px;line-height:1.6}
    .options{display:flex;flex-direction:column;gap:10px}
    .opt{display:flex;align-items:center;gap:14px;padding:14px 18px;border:1.5px solid #e4e2dc;border-radius:10px;cursor:pointer;transition:all .15s;font-size:14px;font-weight:500}
    .opt:hover{border-color:#0f0f0f;background:#fafafa}
    .opt.sel{border-color:#0f0f0f;background:#0f0f0f;color:#fff}
    .opt .opt-icon{font-size:20px;flex-shrink:0;width:28px;text-align:center}
    .opt-multi{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .opt-multi .opt{padding:12px 14px;font-size:13px}
    .custom-input{margin-top:12px;display:none}
    .custom-input.show{display:block}
    .custom-input input,.custom-input textarea{width:100%;padding:12px 16px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:14px;color:#0f0f0f;outline:none;transition:border-color .15s;resize:vertical}
    .custom-input input:focus,.custom-input textarea:focus{border-color:#0f0f0f}
    .nav{display:flex;justify-content:space-between;align-items:center;margin-top:32px}
    .btn{padding:12px 28px;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
    .btn-primary{background:#0f0f0f;color:#fff}
    .btn-primary:hover{background:#333}
    .btn-secondary{background:transparent;color:#888;border:1.5px solid #e4e2dc}
    .btn-secondary:hover{border-color:#0f0f0f;color:#0f0f0f}
    .btn:disabled{opacity:.4;cursor:not-allowed}
    /* SOW Output */
    .sow-output{display:none}
    .sow-output.show{display:block}
    .sow-doc{background:#fff;border:1px solid #e4e2dc;border-radius:10px;padding:40px;line-height:1.8;font-size:14px;white-space:pre-wrap;font-family:'Sora',sans-serif;color:#0f0f0e}
    .sow-actions{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:#f0fdf6;color:#0d7c4c;margin-bottom:16px}
    .wizard-wrap{max-width:700px;width:100%}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">ex3</div>
    <a href="/consultant">â† Back to Consultant Portal</a>
  </div>
  <div class="progress-wrap">
    <div class="progress-label" id="progress-label">Step 1 of 19</div>
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:5%"></div></div>
  </div>

  <div class="wizard">
    <div class="wizard-wrap">

      <!-- Risk banner -->
      <div id="risk-banner" style="display:none;margin-bottom:16px;padding:14px 18px;border-radius:10px;font-size:13px;line-height:1.6"></div>

      <!-- SOW Output (shown at end) -->
      <div class="sow-output" id="sow-output">
        <span class="badge">SOW Generated</span>
        <h2 style="font-size:26px;font-weight:700;margin-bottom:6px;letter-spacing:-.02em">Your Statement of Work</h2>
        <p style="font-size:14px;color:#666;margin-bottom:20px">Review and edit below, then copy, export or email directly to the client.</p>
        <div class="sow-actions">
          <button class="btn btn-primary" onclick="copySow()">ðŸ“‹ Copy</button>
          <button class="btn btn-primary" style="background:#0d7c4c" onclick="exportWord()">â¬‡ï¸ Export Word</button>
          <button class="btn btn-primary" style="background:#6b21a8" onclick="generateWithAI()">âœ¨ Rewrite with AI</button>
          <button class="btn btn-secondary" onclick="showEmailForm()">ðŸ“§ Email to client</button>
          <button class="btn btn-secondary" onclick="restartWizard()">â†© Start Again</button>
        </div>
        <div id="email-form" style="display:none;background:#f8f7f4;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:16px">
          <p style="font-size:13px;font-weight:600;margin-bottom:12px">Send SOW by email</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <input id="email-to" type="email" placeholder="Client email address" style="flex:1;min-width:200px;padding:10px 14px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:13px;outline:none">
            <button class="btn btn-primary" onclick="sendEmail()">Send</button>
          </div>
          <p id="email-status" style="font-size:12px;margin-top:8px;color:#888"></p>
        </div>
        <div id="ai-status" style="display:none;padding:12px 16px;background:#faf5ff;border:1px solid #ddd6fe;border-radius:8px;margin-bottom:16px;font-size:13px;color:#6b21a8">âœ¨ AI is rewriting your SOW in professional language...</div>
        <div class="sow-doc" id="sow-doc" contenteditable="true"></div>
      </div>

      <!-- Wizard Card -->
      <div class="card" id="wizard-card">

        <!-- Step 1: Client Name -->
        <div class="step active" id="step-1">
          <div class="step-num">Step 1 of 19</div>
          <h2>What's the client's name?</h2>
          <p>This will appear throughout the SOW document.</p>
          <input type="text" id="client-name" placeholder="e.g. Acme Corporation" style="width:100%;padding:14px 18px;border:1.5px solid #e4e2dc;border-radius:10px;font-family:inherit;font-size:15px;outline:none" oninput="answers.clientName=this.value" onfocus="this.style.borderColor='#0f0f0f'" onblur="this.style.borderColor='#e4e2dc'">
        </div>

        <!-- Step 2: Org Size -->
        <div class="step" id="step-2">
          <div class="step-num">Step 2 of 19</div>
          <h2>How large is the organisation?</h2>
          <p>This helps set expectations on implementation complexity.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'orgSize','Small (under 100 employees)')"><span class="opt-icon">ðŸ¢</span>Small &mdash; under 100 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Mid-size (100&ndash;500 employees)')"><span class="opt-icon">ðŸ¬</span>Mid-size &mdash; 100 to 500 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Large (500&ndash;2,000 employees)')"><span class="opt-icon">ðŸ­</span>Large &mdash; 500 to 2,000 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Enterprise (2,000+ employees)')"><span class="opt-icon">ðŸŒ</span>Enterprise &mdash; 2,000+ employees</div>
          </div>
        </div>

        <!-- Step 3: Number of users -->
        <div class="step" id="step-3">
          <div class="step-num">Step 3 of 19</div>
          <h2>How many users will need access?</h2>
          <p>Include all recruiters, hiring managers, and admins.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numUsers','up to 25 users')"><span class="opt-icon">ðŸ‘¤</span>Up to 25 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','25&ndash;50 users')"><span class="opt-icon">ðŸ‘¥</span>25 to 50 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','50&ndash;100 users')"><span class="opt-icon">ðŸ‘¨&rsquo;ðŸ‘©&rsquo;ðŸ‘§&rsquo;ðŸ‘¦</span>50 to 100 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','over 100 users')"><span class="opt-icon">ðŸŸï¸</span>Over 100 users</div>
            <div class="opt" onclick="selectCustom(this,'numUsers-custom')"><span class="opt-icon">âœï¸</span>Custom number</div>
          </div>
          <div class="custom-input" id="numUsers-custom">
            <input type="text" placeholder="e.g. 37 users" oninput="answers.numUsers=this.value">
          </div>
        </div>

        <!-- Step 4: Hiring Processes -->
        <div class="step" id="step-4">
          <div class="step-num">Step 4 of 19</div>
          <h2>How many hiring process workflows are needed?</h2>
          <p>Different job types often have different hiring stages (e.g. office vs warehouse vs graduate).</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numProcesses','1&ndash;2 hiring process workflows')"><span class="opt-icon">1ï¸âƒ£</span>1 to 2 workflows</div>
            <div class="opt" onclick="selectOpt(this,'numProcesses','3&ndash;5 hiring process workflows')"><span class="opt-icon">3ï¸âƒ£</span>3 to 5 workflows</div>
            <div class="opt" onclick="selectOpt(this,'numProcesses','6&ndash;10 hiring process workflows')"><span class="opt-icon">ðŸ”¢</span>6 to 10 workflows</div>
            <div class="opt" onclick="selectCustom(this,'numProcesses-custom')"><span class="opt-icon">âœï¸</span>Custom number</div>
          </div>
          <div class="custom-input" id="numProcesses-custom">
            <input type="text" placeholder="e.g. 8 workflows" oninput="answers.numProcesses=this.value">
          </div>
        </div>

        <!-- Step 5: Job templates -->
        <div class="step" id="step-5">
          <div class="step-num">Step 5 of 19</div>
          <h2>How many job templates are required?</h2>
          <p>Job templates speed up requisition creation for common roles.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numTemplates','up to 5 job templates')"><span class="opt-icon">ðŸ“„</span>Up to 5 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','5&ndash;10 job templates')"><span class="opt-icon">ðŸ“‹</span>5 to 10 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','10&ndash;20 job templates')"><span class="opt-icon">ðŸ“š</span>10 to 20 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','no job templates required at this stage')"><span class="opt-icon">âŒ</span>None required</div>
            <div class="opt" onclick="selectCustom(this,'numTemplates-custom')"><span class="opt-icon">âœï¸</span>Custom number</div>
          </div>
          <div class="custom-input" id="numTemplates-custom">
            <input type="text" placeholder="e.g. 15 templates" oninput="answers.numTemplates=this.value">
          </div>
        </div>

        <!-- Step 6: Integrations -->
        <div class="step" id="step-6">
          <div class="step-num">Step 6 of 19</div>
          <h2>Which integrations are required?</h2>
          <p>Select all that apply. Each integration adds complexity and time.</p>
          <div class="options opt-multi" id="integrations-options">
            <div class="opt" onclick="toggleMulti(this,'integrations','SAP SuccessFactors Employee Central (EC) integration &mdash; recruitment to onboarding to EC')">ðŸ”— SAP SuccessFactors EC</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Position Management (EC) integration &mdash; requisition creation from approved positions')">ðŸ“‹ Position Management (EC)</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Onboarding integration &mdash; hired candidate data passed to onboarding system')">ðŸš€ Onboarding integration</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','DocuSign / e-signature integration')">âœï¸ DocuSign / e-signature</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','HRIS integration (e.g. Workday, SAP, BambooHR)')">ðŸ—„ï¸ Other HRIS System</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Single Sign-On (SSO)')">ðŸ” SSO</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','background screening integration')">ðŸ” Background Screening</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','video interviewing platform integration')">ðŸŽ¥ Video Interviews</div>
          </div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="opt" onclick="selectOpt(this,'integrations','no third-party integrations required')">âŒ No integrations needed</div>
            <div class="opt" onclick="toggleCustomMulti(this,'integrations','integrations-other-input')">âœï¸ Other / not listed</div>
          </div>
          <div class="custom-input" id="integrations-other-input">
            <input type="text" placeholder="e.g. Greenhouse, Workable, Microsoft Teams&hellip;" oninput="setCustomMulti('integrations','integrations-other-val',this.value)">
          </div>
        </div>

        <!-- Step 7: Job Boards -->
        <div class="step" id="step-7">
          <div class="step-num">Step 7 of 19</div>
          <h2>Which job boards need connecting?</h2>
          <p>Select all that apply. Job board credentials will need to be provided by the client.</p>
          <div class="options opt-multi" id="jobboards-options">
            <div class="opt" onclick="toggleMulti(this,'jobBoards','LinkedIn')">LinkedIn</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Indeed')">Indeed</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Bayt')">Bayt</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Naukri Gulf')">Naukri Gulf</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Glassdoor')">Glassdoor</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Wuzzuf')">Wuzzuf</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Reed')">Reed</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Totaljobs')">Totaljobs</div>
          </div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="opt" onclick="selectOpt(this,'jobBoards','no job board connections required at this stage')">âŒ None at this stage</div>
            <div class="opt" onclick="toggleCustomMulti(this,'jobBoards','jobboards-other-input')">âœï¸ Other / not listed</div>
          </div>
          <div class="custom-input" id="jobboards-other-input">
            <input type="text" placeholder="e.g. Bayt, Naukri Gulf, Wuzzuf, Monster&hellip;" oninput="setCustomMulti('jobBoards','jobboards-other-val',this.value)">
          </div>
        </div>

        <!-- Step 8: Career Page -->
        <div class="step" id="step-8">
          <div class="step-num">Step 8 of 19</div>
          <h2>Is career page branding in scope?</h2>
          <p>This covers setting up the SAP SuccessFactors Recruiting hosted careers page with the client's logo, colours, and imagery.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'careerPage','Configuration and branding of the SAP SuccessFactors Recruiting careers page is included in scope. The client will provide brand assets (logo, colour palette, imagery) prior to configuration.')">âœ… Yes &mdash; brand and configure the careers page</div>
            <div class="opt" onclick="selectOpt(this,'careerPage','Career page setup is not in scope for this engagement.')">âŒ No &mdash; out of scope</div>
            <div class="opt" onclick="selectOpt(this,'careerPage','Basic career page configuration is included (logo and colour only). Full creative design is out of scope.')">ðŸŽ¨ Basic only &mdash; logo and colours only</div>
          </div>
        </div>

        <!-- Step 9: Data Migration -->
        <div class="step" id="step-9">
          <div class="step-num">Step 9 of 19</div>
          <h2>Is data migration required?</h2>
          <p>Moving historical jobs, candidates, or offer data from an existing system into SAP SuccessFactors Recruiting.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'dataMigration','Data migration is not in scope for this engagement. Historical data will remain in the client\\'s existing system.')">âŒ No migration needed</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of active job requisitions into SAP SuccessFactors Recruiting is included in scope.')">ðŸ“‹ Active jobs only</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of candidate records is included in scope, subject to a data mapping exercise to be completed during discovery.')">ðŸ‘¤ Candidate records</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of both active job requisitions and candidate records is included in scope, subject to a data mapping exercise to be completed during discovery.')">ðŸ“¦ Both jobs and candidates</div>
          </div>
        </div>

        <!-- Step 10: Training -->
        <div class="step" id="step-10">
          <div class="step-num">Step 10 of 19</div>
          <h2>Which training sessions are required?</h2>
          <p>Select all that apply. Each session is role-specific and delivered separately.</p>
          <div class="options opt-multi">
            <div class="opt" onclick="toggleMulti(this,'training','One Administrator training session (up to 90 minutes, covering system configuration, user management, and reporting)')">ðŸ”§ Administrator (90 mins)</div>
            <div class="opt" onclick="toggleMulti(this,'training','One Recruiter training session (up to 60 minutes, covering end-to-end hiring workflow, candidate management, and communication tools)')">ðŸ“ž Recruiter (60 mins)</div>
            <div class="opt" onclick="toggleMulti(this,'training','One Hiring Manager training session (up to 45 minutes, covering job approval, candidate review, and interview scheduling)')">ðŸ‘” Hiring Manager (45 mins)</div>
          </div>
        </div>

        <!-- Step 11: Hypercare -->
        <div class="step" id="step-11">
          <div class="step-num">Step 11 of 19</div>
          <h2>How long is the hypercare period?</h2>
          <p>Hypercare is the close-support window immediately after go-live where your team is on hand to resolve issues quickly.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'hypercare','2 weeks')">âš¡ 2 weeks &mdash; standard</div>
            <div class="opt" onclick="selectOpt(this,'hypercare','4 weeks')">ðŸ›¡ï¸ 4 weeks &mdash; recommended for larger orgs</div>
            <div class="opt" onclick="selectOpt(this,'hypercare','6 weeks')">ðŸ”’ 6 weeks &mdash; enterprise / complex implementations</div>
            <div class="opt" onclick="selectCustom(this,'hypercare-custom')">âœï¸ Custom</div>
          </div>
          <div class="custom-input" id="hypercare-custom">
            <input type="text" placeholder="e.g. 3 weeks" oninput="answers.hypercare=this.value">
          </div>
        </div>

        <!-- Step 12: Timeline -->
        <div class="step" id="step-12">
          <div class="step-num">Step 12 of 19</div>
          <h2>What is the expected project timeline?</h2>
          <p>From kickoff to go-live. This will appear in the SOW assumptions.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'timeline','8 weeks')">ðŸš€ 8 weeks &mdash; small / simple implementation</div>
            <div class="opt" onclick="selectOpt(this,'timeline','10 weeks')">ðŸ“… 10 weeks &mdash; standard implementation</div>
            <div class="opt" onclick="selectOpt(this,'timeline','12 weeks')">ðŸ—“ï¸ 12 weeks &mdash; larger or more complex</div>
            <div class="opt" onclick="selectOpt(this,'timeline','16 weeks')">ðŸ“† 16 weeks &mdash; enterprise / heavily integrated</div>
            <div class="opt" onclick="selectCustom(this,'timeline-custom')">âœï¸ Custom</div>
          </div>
          <div class="custom-input" id="timeline-custom">
            <input type="text" placeholder="e.g. 14 weeks" oninput="answers.timeline=this.value">
          </div>
        </div>

        <!-- Step 13: Requisition Approval Workflows -->
        <div class="step" id="step-13">
          <div class="step-num">Step 13 of 19</div>
          <h2>How are job requisitions approved before posting?</h2>
          <p>Defines the approval chain a recruiter must go through before a job goes live.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'reqApproval','No approval workflow required &mdash; recruiters can post jobs directly without sign-off.')"><span class="opt-icon">âš¡</span>No approval &mdash; post directly</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','A single-level approval workflow is required (e.g. line manager or HR Director approves each requisition before posting).')"><span class="opt-icon">1ï¸âƒ£</span>Single approver (e.g. HR Director)</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','A multi-level approval workflow is required (e.g. Line Manager â†’ HR â†’ Finance). The exact approval chain will be confirmed during discovery.')"><span class="opt-icon">ðŸ”—</span>Multi-level (e.g. Manager â†’ HR â†’ Finance)</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','Approval workflows vary by role type or department. Configuration of multiple approval chains is in scope, subject to discovery.')"><span class="opt-icon">ðŸ—‚ï¸</span>Different chains per department/role type</div>
          </div>
        </div>

        <!-- Step 14: Offer Management -->
        <div class="step" id="step-14">
          <div class="step-num">Step 14 of 19</div>
          <h2>Is offer management in scope?</h2>
          <p>SAP SuccessFactors Recruiting can manage the full offer lifecycle &mdash; templates, approval, e-signature, and candidate acceptance &mdash; all in-platform.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Offer management is not in scope for this engagement. Offers will be managed outside of SAP SuccessFactors Recruiting.')"><span class="opt-icon">âŒ</span>Not in scope &mdash; offers managed externally</div>
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Configuration of offer letter templates is included in scope. Approval and e-signature are not required.')"><span class="opt-icon">ðŸ“„</span>Offer templates only</div>
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Full offer management is in scope: offer letter templates, an offer approval workflow, and integration with e-signature (DocuSign or equivalent).')"><span class="opt-icon">âœ…</span>Full &mdash; templates + approval + e-signature</div>
            <div class="opt" onclick="selectCustom(this,'offerMgmt-custom')"><span class="opt-icon">âœï¸</span>Custom &mdash; describe below</div>
          </div>
          <div class="custom-input" id="offerMgmt-custom">
            <textarea placeholder="Describe the offer management requirements&hellip;" rows="3" oninput="answers.offerMgmt=this.value"></textarea>
          </div>
        </div>

        <!-- Step 15: Pre-screening questions -->
        <div class="step" id="step-15">
          <div class="step-num">Step 15 of 19</div>
          <h2>Are pre-screening or knockout questions required?</h2>
          <p>These are questions candidates must answer when applying &mdash; wrong answers can auto-reject them before a recruiter reviews.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'screening','No pre-screening or knockout questions are required at this stage.')"><span class="opt-icon">âŒ</span>Not required</div>
            <div class="opt" onclick="selectOpt(this,'screening','Basic knockout questions are required (e.g. right to work, minimum qualifications). Configuration of up to 5 standard screening questions per workflow is in scope.')"><span class="opt-icon">âœ…</span>Basic knockout questions (right to work, qualifications)</div>
            <div class="opt" onclick="selectOpt(this,'screening','Role-specific pre-screening question sets are required for each hiring workflow. The exact questions will be agreed during discovery. Configuration of all question sets is in scope.')"><span class="opt-icon">ðŸŽ¯</span>Role-specific screeners per workflow</div>
            <div class="opt" onclick="selectOpt(this,'screening','A full application form with multi-section screening questions and automatic scoring is required. This will be scoped in detail during the discovery phase.')"><span class="opt-icon">ðŸ“</span>Full scored application form</div>
          </div>
        </div>

        <!-- Step 16: Reporting & Analytics -->
        <div class="step" id="step-16">
          <div class="step-num">Step 16 of 19</div>
          <h2>What level of reporting is required?</h2>
          <p>From standard dashboards to fully custom exec-level analytics.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'reporting','Standard SAP SuccessFactors Recruiting dashboards and out-of-the-box reports will be used. No custom report configuration is required.')"><span class="opt-icon">ðŸ“Š</span>Standard dashboards only</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Configuration of custom reports is in scope. Up to 5 custom report templates will be created based on requirements agreed during discovery.')"><span class="opt-icon">ðŸ“ˆ</span>Custom reports (up to 5 agreed templates)</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Executive-level dashboards and custom KPI reports are required. Reporting requirements will be captured during discovery and agreed prior to build.')"><span class="opt-icon">ðŸ†</span>Exec dashboards and custom KPIs</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Business intelligence (BI) tool integration is required (e.g. Power BI, Tableau, Looker). This will be scoped separately.')"><span class="opt-icon">ðŸ”Œ</span>BI tool integration (Power BI, Tableau etc.)</div>
          </div>
        </div>

        <!-- Step 17: GDPR & Compliance -->
        <div class="step" id="step-17">
          <div class="step-num">Step 17 of 19</div>
          <h2>What compliance and data privacy configuration is needed?</h2>
          <p>Select all that apply. GDPR configuration is strongly recommended for all UK/EU clients.</p>
          <div class="options opt-multi" id="compliance-options">
            <div class="opt" onclick="toggleMulti(this,'compliance','Candidate consent and privacy notice configuration')">âœ… Candidate consent notices</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Data retention policy configuration (automated deletion schedules for candidate records)')">ðŸ—‘ï¸ Data retention policy</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','UAE Personal Data Protection Law (PDPL) compliance configuration')">ðŸ‡¦ðŸ‡ª UAE PDPL</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Saudi Arabia Personal Data Protection Law (PDPPL) compliance configuration')">ðŸ‡¸ðŸ‡¦ Saudi PDPPL</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','GDPR compliance configuration (EU/UK)')">ðŸ‡ªðŸ‡º GDPR</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','EEO / diversity monitoring data collection setup')">ðŸ“‹ EEO / diversity monitoring</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Audit trail and access log configuration')">ðŸ” Audit trail setup</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','ISO 27001 / SOC 2 evidence documentation support')">ðŸ”’ ISO 27001 / SOC 2 support</div>
          </div>
          <div style="margin-top:10px">
            <div class="opt" onclick="selectOpt(this,'compliance','No specific compliance or data privacy configuration is required beyond platform defaults.')">âŒ No specific compliance requirements</div>
          </div>
        </div>

        <!-- Step 18: Multi-country / International -->
        <div class="step" id="step-18">
          <div class="step-num">Step 18 of 19</div>
          <h2>What is the geographic scope of the implementation?</h2>
          <p>Multi-country or multilingual setups require additional configuration time.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation is for a single country with a single language (English). No multi-country or multi-language configuration is required.');hideGeoCustom()"><span class="opt-icon">ðŸ¢</span>Single country &mdash; English only</div>
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation covers multiple European markets. Multi-country configuration and at least one additional language is in scope. Specific countries and languages will be confirmed during discovery.');hideGeoCustom()"><span class="opt-icon">ðŸ‡ªðŸ‡º</span>Multiple European markets</div>
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation is global in scope. Multi-region configuration, timezone support, and multiple languages are required. Full scope will be confirmed during discovery.');hideGeoCustom()"><span class="opt-icon">ðŸŒ</span>Global &mdash; multiple regions and languages</div>
            <div class="opt" id="geo-custom-trigger" onclick="selectCustomGeo(this)"><span class="opt-icon">âœï¸</span>Other / Custom &mdash; specify regions below</div>
          </div>
          <div class="custom-input" id="geoScope-custom" style="margin-top:14px">
            <div id="geo-entries" style="display:flex;flex-direction:column;gap:8px"></div>
            <button type="button" onclick="addGeoEntry()" style="margin-top:8px;padding:7px 14px;border:1.5px dashed #ccc;border-radius:8px;background:none;font-family:inherit;font-size:13px;color:#666;cursor:pointer;transition:all .15s" onmouseover="this.style.borderColor='#0f0f0f';this.style.color='#0f0f0f'" onmouseout="this.style.borderColor='#ccc';this.style.color='#666'">ï¼‹ Add another region</button>
          </div>
        </div>

        <!-- Step 19: Agency / Vendor Portal -->
        <div class="step" id="step-19">
          <div class="step-num">Step 19 of 19</div>
          <h2>Do you work with external recruitment agencies?</h2>
          <p>SAP SuccessFactors Recruiting has a built-in vendor/agency portal for managing third-party recruiters and their submissions.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'agencyPortal','No external recruitment agencies are used. Agency/vendor portal configuration is not in scope.')"><span class="opt-icon">âŒ</span>No agencies used</div>
            <div class="opt" onclick="selectOpt(this,'agencyPortal','External agencies are used. Basic vendor portal configuration is in scope, including agency account setup and job sharing. The number of agencies will be confirmed during discovery.')"><span class="opt-icon">ðŸ¤</span>Yes &mdash; basic agency portal setup</div>
            <div class="opt" onclick="selectOpt(this,'agencyPortal','External agencies are a core part of the hiring strategy. Full vendor management configuration is in scope: agency tiers, submission rules, fee agreements, and communication workflows.')"><span class="opt-icon">ðŸ¢</span>Yes &mdash; full vendor management (tiers, fees, rules)</div>
          </div>
        </div>

        <div class="nav">
          <button class="btn btn-secondary" id="btn-back" onclick="prevStep()" style="display:none">â† Back</button>
          <button class="btn btn-primary" id="btn-next" onclick="nextStep()">Next â†’</button>
        </div>
      </div>

    </div>
  </div>

<script>
  const TOTAL = 19;
  let current = 1;
  const answers = {
    clientName: '', orgSize: '', numUsers: '', numProcesses: '',
    numTemplates: '', integrations: [], jobBoards: [], careerPage: '',
    dataMigration: '', training: [], hypercare: '', timeline: '',
    reqApproval: '', offerMgmt: '', screening: '', reporting: '',
    compliance: [], geoScope: '', agencyPortal: ''
  };

  function selectOpt(el, key, value) {
    // Deselect all in same step
    el.closest('.step').querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    answers[key] = value;
    // Hide all custom inputs in this step
    el.closest('.step').querySelectorAll('.custom-input').forEach(c => c.classList.remove('show'));
  }

  function selectCustom(el, inputId) {
    el.closest('.step').querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    const inp = document.getElementById(inputId);
    inp.classList.add('show');
    inp.querySelector('input,textarea').focus();
  }

  function selectCustomGeo(el) {
    el.closest('.step').querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
    el.classList.add('sel');
    const wrap = document.getElementById('geoScope-custom');
    wrap.classList.add('show');
    const entries = document.getElementById('geo-entries');
    if (entries.children.length === 0) addGeoEntry();
    else entries.querySelector('input').focus();
  }

  function hideGeoCustom() {
    const wrap = document.getElementById('geoScope-custom');
    if (wrap) wrap.classList.remove('show');
  }

  function addGeoEntry() {
    const entries = document.getElementById('geo-entries');
    const idx = entries.children.length;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const placeholders = [
      'e.g. Middle East (UAE, KSA, Oman, Jordan, Lebanon, Iraq) &mdash; English only, UAE PDPL & Saudi PDPPL apply',
      'e.g. UK & Ireland &mdash; English only',
      'e.g. Germany &mdash; German + English, GDPR applies',
      'e.g. APAC &mdash; Singapore, Australia, Hong Kong',
    ];
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = placeholders[idx] || 'e.g. Country / region &mdash; language, compliance notes';
    inp.style.cssText = 'flex:1;padding:10px 14px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:13px;color:#0f0f0f;outline:none';
    inp.onfocus = function(){ this.style.borderColor='#0f0f0f'; };
    inp.onblur  = function(){ this.style.borderColor='#e4e2dc'; };
    inp.oninput = updateGeoScope;
    if (idx > 0) {
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'âœ•';
      del.title = 'Remove';
      del.style.cssText = 'padding:6px 10px;border:1.5px solid #e4e2dc;border-radius:6px;background:none;font-size:12px;color:#999;cursor:pointer;flex-shrink:0';
      del.onclick = function(){ row.remove(); updateGeoScope(); };
      row.appendChild(inp);
      row.appendChild(del);
    } else {
      row.appendChild(inp);
    }
    entries.appendChild(row);
    inp.focus();
  }

  function updateGeoScope() {
    const inputs = document.querySelectorAll('#geo-entries input');
    const vals = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    answers.geoScope = vals.length ? vals.join('; ') : '';
  }

  function toggleMulti(el, key, value) {
    el.classList.toggle('sel');
    if (!Array.isArray(answers[key])) answers[key] = [];
    if (el.classList.contains('sel')) {
      if (!answers[key].includes(value)) answers[key].push(value);
    } else {
      answers[key] = answers[key].filter(v => v !== value);
    }
  }

  function toggleCustomMulti(el, key, inputId) {
    el.classList.toggle('sel');
    const inp = document.getElementById(inputId);
    inp.classList.toggle('show', el.classList.contains('sel'));
    if (el.classList.contains('sel')) inp.querySelector('input').focus();
    else {
      // Remove custom value from array
      if (Array.isArray(answers[key])) {
        answers[key] = answers[key].filter(v => !v.startsWith('Other:'));
      }
    }
  }

  function setCustomMulti(key, valId, value) {
    if (!Array.isArray(answers[key])) answers[key] = [];
    answers[key] = answers[key].filter(v => !v.startsWith('Other:'));
    if (value.trim()) answers[key].push('Other: ' + value.trim());
  }

  function updateProgress() {
    const pct = Math.round((current / TOTAL) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-label').textContent = 'Step ' + current + ' of ' + TOTAL;
    document.getElementById('btn-back').style.display = current > 1 ? 'block' : 'none';
    document.getElementById('btn-next').textContent = current === TOTAL ? 'Generate SOW âœ¨' : 'Next â†’';
  }

  function nextStep() {
    // Validate step 1
    if (current === 1) {
      const inp = document.getElementById('client-name');
      const val = inp.value.trim();
      if (!val) {
        inp.style.borderColor = '#ef4444';
        inp.placeholder = 'Please enter the client name to continue';
        inp.focus();
        setTimeout(() => { inp.style.borderColor = '#e4e2dc'; inp.placeholder = 'e.g. Acme Corporation'; }, 3000);
        return;
      }
      answers.clientName = val;
    }
    if (current === TOTAL) {
      generateSOW();
      return;
    }
    document.getElementById('step-' + current).classList.remove('active');
    current++;
    document.getElementById('step-' + current).classList.add('active');
    updateProgress();
  }

  function prevStep() {
    document.getElementById('step-' + current).classList.remove('active');
    current--;
    document.getElementById('step-' + current).classList.add('active');
    updateProgress();
  }

  function generateSOW() {
    var a = answers;
    var L = [];
    function add(s) { L.push(s !== undefined ? s : ''); }

    var intCount = Array.isArray(a.integrations) ? a.integrations.length : 0;
    var integrationsList = Array.isArray(a.integrations) ? a.integrations : [];
    var jobBoardsList = Array.isArray(a.jobBoards) ? a.jobBoards : [];
    var trainingList = Array.isArray(a.training) ? a.training : [];
    var complianceList = Array.isArray(a.compliance) ? a.compliance : [];

    var isEnterprise = !!(a.orgSize && (a.orgSize.indexOf('Enterprise') >= 0 || a.orgSize.indexOf('2,001') >= 0));
    var hasMigration = !!(a.dataMigration && a.dataMigration.toLowerCase().indexOf('not in scope') < 0 && a.dataMigration.toLowerCase().indexOf('no migration') < 0 && a.dataMigration.toLowerCase().indexOf('no data') < 0);
    var isMiddleEast = !!(a.geoScope && a.geoScope.indexOf('Middle East') >= 0);
    var isMultiCountry = !!(a.geoScope && a.geoScope.indexOf('single country') < 0);
    var hasFullOffer = !!(a.offerMgmt && (a.offerMgmt.indexOf('Full offer') >= 0 || a.offerMgmt.indexOf('full') >= 0));
    var hasMultiApproval = !!(a.reqApproval && (a.reqApproval.indexOf('multi-level') >= 0 || a.reqApproval.indexOf('different chains') >= 0));
    var hasAgency = !!(a.agencyPortal && a.agencyPortal.indexOf('No external') < 0);
    var hasCareerPage = !!(a.careerPage && a.careerPage.indexOf('not in scope') < 0 && a.careerPage.indexOf('not required') < 0);
    var hasOfferMgmt = !!(a.offerMgmt && a.offerMgmt.indexOf('Not in scope') < 0 && a.offerMgmt.indexOf('not in scope') < 0);
    var hasDocuSign = integrationsList.some(function(i){ return i.indexOf('DocuSign') >= 0 || i.indexOf('e-signature') >= 0; });
    var hasSFEC = integrationsList.some(function(i){ return i.indexOf('Employee Central') >= 0 || i.indexOf('SAP SuccessFactors') >= 0; });
    var hasPositionMgmt = integrationsList.some(function(i){ return i.indexOf('Position Management') >= 0; });
    var hasOnboarding = integrationsList.some(function(i){ return i.indexOf('Onboarding') >= 0 || i.indexOf('onboarding') >= 0; });

    var now = new Date();
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dateStr = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
    var clientName = a.clientName || 'To be confirmed';
    var clientUpper = clientName.toUpperCase();

    // â”€â”€ HEADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('SAP SuccessFactors Recruiting Recruiting Implementation');
    add('via EXcelerate');
    add('');
    add('Client:      ' + clientName);
    add('Prepared by: EX3');
    add('Date:        ' + dateStr);
    add('Version:     1.0 (Draft)');
    add('');

    // â”€â”€ OVERVIEW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Overview');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('EX3 has been asked to provide a Statement of Work for the SAP SuccessFactors Recruiting');
    add('implementation for ' + clientName + '. This section outlines the scope,');
    add('methodology, responsibilities, and deliverables for the SAP SuccessFactors Recruiting');
    add('deployment.');
    add('');
    add('The modules in scope for this workstream are:');
    add('  &bull; SAP SuccessFactors Recruiting Recruiting Management (SMRC)');
    if (hasCareerPage) add('  &bull; Career Site / Recruiting Marketing configuration');
    if (integrationsList.length > 0) add('  &bull; Integration to ' + (hasSFEC ? 'Employee Central (EC), Position Management, and Onboarding' : integrationsList.join('; ')));
    add('');
    if (isMiddleEast) {
      add('The countries in scope are:');
      add('  &bull; United Arab Emirates, Saudi Arabia, Oman, Jordan, Lebanon and Iraq');
      add('');
    } else if (a.geoScope) {
      add('Geography: ' + a.geoScope);
      add('');
    }
    add('EX3 will apply the EXcelerate methodology, which is optimised for rapid');
    add('deployment using model company content. EXcelerate is designed to deliver a');
    add('high-quality SAP SuccessFactors Recruiting implementation efficiently, leveraging EX3\\'s');
    add('pre-built assets as a baseline while allowing for configuration aligned to');
    add(clientName + '\\'s hiring processes.');
    add('');

    // â”€â”€ PERIOD OF PERFORMANCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Period of Performance');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('The Services for the SAP SuccessFactors Recruiting workstream shall take place within');
    add((a.timeline || 'a timeline to be agreed') + ' of SOW execution and will run in parallel');
    add('with the broader implementation.');
    add('');
    add('Organisation profile:');
    add('  &bull; Organisation size: ' + (a.orgSize || 'To be confirmed'));
    add('  &bull; Geography: ' + (a.geoScope ? a.geoScope.split('.')[0] : 'To be confirmed'));
    add('  &bull; Platform language: English only');
    add('  &bull; Users in scope: ' + (a.numUsers || 'To be confirmed'));
    add('');

    // â”€â”€ ENGAGEMENT RESOURCES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Engagement Resources');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('As part of this engagement, EX3 will assign the required resources.');
    add('Resources will have experience of the SAP SuccessFactors Recruiting platform and');
    add('enterprise talent acquisition implementations.');
    add('');
    add('Key information on our resources:');
    add('  &bull; All resources have worked effectively as remote resources on projects');
    add('    scaling from small to very large global implementations');
    add('  &bull; Resources will have experience of the SAP SuccessFactors Recruiting platform and');
    add('    relevant TA processes');
    add('  &bull; Resources have global and Middle East regional experience');
    add('  &bull; Resources and responsibilities are subject to change throughout the project');
    add('');
    add('The EX3 implementation team shall engage with the Customer no later than');
    add('four (4) weeks from SOW execution. Delivery dates for tasks included in this');
    add('SOW shall be based upon mutual agreement as documented within an approved');
    add('project schedule.');
    add('');

    // â”€â”€ METHODOLOGY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Implementation Methodology, Services & Responsibilities');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('EX3 has created its own implementation methodology, EXcelerate, which');
    add('incorporates both industry best practices and lessons learned from our years');
    add('of experience doing high quality SAP SuccessFactors Recruiting implementations. We use our');
    add('EXcelerate methodology to efficiently deploy SAP SuccessFactors Recruiting while meeting');
    add('our high standards for quality, customer satisfaction and project success.');
    add('');
    add('EXcelerate is optimised for rapid deployment using model company content. It');
    add('is structured across the following phases:');
    add('');
    add('  Examine          Adopt               Validate            Launch');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Kick-off,        Platform config:    UAT test scripts,   Go-live readiness');
    add('  requirements,    route maps, job     facilitation,       review, production');
    add('  process mapping, templates, user     defect resolution,  cutover, training,');
    add('  design sign-off, roles, offer mgmt,  written sign-off    Hypercare support');
    add('  integration      career site,        prior to go-live');
    add('  scoping          integrations,');
    add('                   data migration');
    add('');

    // â”€â”€ EXAMINE PHASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Examine Phase');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('The purpose of the Examine Phase is to establish the framework for a');
    add('successful project, confirm platform design, map hiring processes, and sign');
    add('off the configuration blueprint before Adopt commences.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client and EX3                          EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Review Examine findings and agree         Lead kick-off workshop and');
    add('  configuration blueprint                   process mapping sessions');
    add('');
    add('  Confirm route map stages and approval     Produce platform design document');
    add('  chain definitions                         for sign-off');
    add('');
    add('  Sign off RBP access matrix and job        Begin integration scoping and');
    add('  template structure                        data migration assessment');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Signed-off configuration blueprint       Kick-off and workshop presentations');
    add('  Completed RBP access matrix              Platform design sign-off document');
    add('  Approval chain definitions confirmed     Data migration assessment report');
    add('');

    // â”€â”€ ADOPT PHASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Adopt Phase');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('The purpose of the Adopt Phase is to configure the SAP SuccessFactors Recruiting platform');
    add('per the agreed design, leveraging EX3 model company content as a baseline.');
    add('Iterative unit testing occurs throughout this phase.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client and EX3                          EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Review configuration playbacks and       Configure route maps, job templates,');
    add('  provide timely feedback                  offer management, screening');
    add('');
    add('  Confirm email copy and brand assets      Configure user accounts, RBP roles,');
    add('  for career site build                    and approval chains');
    add('');
    add('  Sign off configuration before            Conduct unit testing and playback');
    add('  Validate commences                       sessions');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Approved email copy, branding assets,    Configured SAP SuccessFactors Recruiting sandbox');
    add('  offer letter content                     environment');
    add('  Build sign-off                           Updated configuration workbooks');
    add('                                           Unit test results and playback docs');
    add('');

    // â”€â”€ VALIDATE PHASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Validate Phase');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('The purpose of the Validate Phase is to confirm all configured functionality');
    add('through client-led UAT. Written sign-off is required before go-live proceeds.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client                                  EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Execute UAT test scripts and log         Deliver UAT test scripts and');
    add('  all findings                             facilitate sessions');
    add('');
    add('  Coordinate feedback, triage calls,       Resolve all Critical and High');
    add('  and final UAT sign-off                   priority defects within SLA');
    add('');
    add('  Creation of test users                   Update configuration workbooks');
    add('                                           post-UAT');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Signed UAT sign-off document             UAT test scripts');
    add('                                           Defect log and resolution summary');
    add('                                           Updated instance configuration');
    add('');

    // â”€â”€ LAUNCH PHASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Launch Phase');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('The purpose of the Launch Phase is to move configuration to the production');
    add('environment, support the go-live, deliver training, and provide post-go-live');
    add('Hypercare for a smooth transition to BAU.');
    add('');
    add('Key Tasks');
    add('');
    add('  Client                                  EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  PROD smoke test                          Execute cutover checklist and move');
    add('                                           configuration to PROD');
    add('  Attend training sessions and             Deliver recruiter, admin and hiring');
    add('  complete pre-reading                     manager training');
    add('  Participate in go-live readiness         Administer Hypercare and project');
    add('  review                                   closure');
    add('');
    add('Deliverables');
    add('');
    add('  Client                                  EX3');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  PROD smoke test sign-off                 Final PROD configuration');
    add('  Project closeout complete                Post-implementation handover pack');
    add('                                           HelpMyCloud Hypercare');
    add('                                           Completed configuration workbooks');
    add('');

    // â”€â”€ SCOPE OF WORK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Scope of Work');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('SAP SuccessFactors Recruiting Recruiting Management Scope &mdash; EXcelerate Deployment');
    add('');

    // Route Maps
    add('Route Maps (Hiring Workflows)');
    add('  &bull; Configuration of ' + (a.numProcesses || '6&ndash;8') + ' route maps aligned to ' + clientName + ' hiring workflows');
    add('  &bull; Stage and status configuration per agreed route map design');
    add('  &bull; Rejection reason configuration');
    add('  &bull; Route map design to be confirmed and signed off during the Examine Phase');
    add('');

    // Job Templates
    add('Job Templates');
    add('  &bull; Configuration of ' + (a.numTemplates || '5&ndash;8') + ' job templates with custom fields');
    add('  &bull; Department and location hierarchy setup');
    add('  &bull; Template structure and field requirements to be confirmed during Examine Phase');
    add('');

    // Application Template
    add('Application Template');
    add('  &bull; 1 Application Template [Single Stage only &mdash; up to 3 fields additional or amended]');
    if (a.screening && a.screening.indexOf('not required') < 0) {
      add('  &bull; Knockout / screening questions: ' + a.screening);
    } else {
      add('  &bull; Knockout / screening questions: up to 5 standard screening questions per workflow');
      add('    (e.g. right to work, minimum qualifications)');
    }
    add('  &bull; Screening question content to be provided by Client prior to configuration');
    add('');

    // Offer Management
    add('Offer Management');
    if (hasOfferMgmt) {
      add('  &bull; 1 Offer Detail Template');
      add('  &bull; 1 Offer Letter Template');
      add('  &bull; Offer approval workflow configuration &mdash; approval chain to be confirmed during Examine Phase');
      if (hasDocuSign) add('  &bull; E-signature integration (DocuSign) &mdash; subject to integration scope below');
    } else {
      add('  &bull; Offer management is not in scope for this engagement');
    }
    add('');

    // Approval Workflows
    add('Approval Workflows');
    add('  &bull; Requisition approval: ' + (a.reqApproval || 'multi-level approval chain (e.g. Line Manager â†’ HR â†’ Finance)'));
    add('  &bull; Exact approval chain structure to be confirmed and signed off during Examine Phase');
    add('    before Adopt commences');
    add('  &bull; Up to ' + (a.numProcesses || '6&ndash;8') + ' approval workflow configurations');
    add('');

    // Candidate Profile & Status Pipeline
    add('Candidate Profile & Status Pipeline');
    add('  &bull; 1 Candidate Profile');
    add('  &bull; 1 Applicant Status Pipeline');
    add('  &bull; Candidate profile fields and data capture configuration');
    add('  &bull; Status pipeline aligned to agreed route map stages');
    add('  &bull; Rejection reason configuration');
    add('');

    // Email Templates
    add('Email Templates');
    add('  &bull; Up to 20 recruiting email templates (e.g. application received, interview');
    add('    invite, rejection, offer)');
    add('  &bull; 1 custom declined email template linked to status');
    add('  &bull; Client to provide email copy and branding prior to configuration');
    add('');

    // Agency / Vendor Portal
    if (hasAgency) {
      add('Agency / Vendor Portal');
      add('  &bull; Basic vendor portal configuration including agency account setup and job sharing');
      add('  &bull; Agency account setup for up to 5 agreed vendors (client to provide agency list)');
      add('    or training provided on how to set up additional agencies independently');
      add('  &bull; Agency submission workflow and visibility controls');
      add('');
    }

    // Interview Scheduling
    add('Interview Scheduling');
    add('  &bull; Interview scheduling configuration aligned to agreed route map stages');
    add('  &bull; Central interview scheduling setup (no Outlook / Google Calendar integration');
    add('    unless separately scoped)');
    add('');

    // Referral Management
    add('Referral Management');
    add('  &bull; Enablement of SAP SuccessFactors Recruiting standard employee referral portal');
    add('  &bull; Employees can view open roles, submit referrals, and track referral status');
    add('    natively within the platform');
    add('  &bull; Advanced referral programme features (bonus tracking, leaderboards, automated');
    add('    payments) require a third-party Marketplace integration and are out of scope');
    add('');

    // Mobile Enablement
    add('Mobile Enablement');
    add('  &bull; Mobile enablement for recruiters and hiring managers via SAP SuccessFactors Recruiting');
    add('    native mobile application (iOS and Android)');
    add('  &bull; Mobile-responsive career site configuration included within career site scope');
    add('');

    // Recruiting Posting
    add('Recruiting Posting');
    add('  &bull; 1 Posting Profile');
    if (jobBoardsList.length > 0) {
      add('  &bull; Up to ' + Math.min(jobBoardsList.length, 5) + ' job boards: ' + jobBoardsList.slice(0, 5).join(', '));
    } else {
      add('  &bull; Up to 5 job boards (to be confirmed during Examine Phase &mdash; e.g. LinkedIn, Indeed, Bayt)');
    }
    add('  &bull; Basic field mapping &mdash; 5 key fields');
    add('  &bull; Internal posting configuration');
    add('  &bull; Standard Internal Careers options');
    add('');

    // User Accounts & RBP
    add('User Accounts & Role-Based Permissions (RBP)');
    add('  &bull; Creation of ' + (a.numUsers || 'agreed number of') + ' user accounts');
    add('  &bull; 1 Recruiter RBP role (minimal admin permissions)');
    add('  &bull; RBP configuration per agreed access matrix');
    add('  &bull; EX3 to provide RBP design template; Client to complete and sign off before');
    add('    Adopt commences');
    add('');

    // Reporting & Analytics
    add('Reporting & Analytics');
    add('  &bull; Standard SAP SuccessFactors Recruiting dashboards and out-of-the-box reports');
    add('  &bull; Configuration of agreed saved reports and scheduled report distribution');
    if (a.reporting && a.reporting.indexOf('Standard') < 0 && a.reporting.indexOf('standard') < 0) {
      add('  &bull; ' + a.reporting);
    } else {
      add('  &bull; No custom report development is included');
    }
    add('');

    // Career Site
    if (hasCareerPage) {
      add('Recruiting Marketing / Career Site Scope &mdash; EXcelerate Deployment');
      add('');
      add('  &bull; Integration of Recruiting Management and Career Site');
      add('  &bull; Field mapping between Recruiting Management and Career Site');
      add('  &bull; 1 Brand');
      add('  &bull; 1 Locale (English only)');
      add('  &bull; 1 Career Site Homepage');
      add('  &bull; Up to 8 Category Pages');
      add('  &bull; Up to 3 Content Pages');
      add('  &bull; Standard career site builder components only &mdash; bespoke front-end development');
      add('    is out of scope');
      add('  &bull; Standard job search and apply flow');
      add('  &bull; Mobile-responsive career site validation');
      add('  &bull; Brand application (logo, colours, imagery) &mdash; Client to provide all assets');
      add('    prior to configuration');
      add('');
    }

    // Integrations
    add('Integrations Scope &mdash; EXcelerate Deployment');
    add('');
    if (integrationsList.length > 0) {
      add('The following standard integrations are in scope:');
      integrationsList.forEach(function(i){ add('  &bull; ' + i); });
    } else {
      add('The following standard integrations are in scope:');
      if (hasSFEC || (!integrationsList.length && isMiddleEast)) {
        add('  &bull; Recruitment to Onboarding to Employee Central');
        add('  &bull; Integration to Position Management (EC) &mdash; requisition creation from approved positions');
        add('  &bull; E-signature / DocuSign &mdash; to be confirmed during Examine Phase');
      } else {
        add('  &bull; No third-party integrations in scope for this engagement');
      }
    }
    add('');
    add('All integrations use standard SAP SuccessFactors Recruiting Marketplace connectors. Custom');
    add('API builds or non-standard connectors are out of scope and would require a');
    add('Change Order.');
    add('');

    // Data Privacy & Compliance
    add('Data Privacy & Compliance');
    add('');
    add('  &bull; Candidate consent and privacy notice configuration');
    add('  &bull; Data retention policy configuration (automated deletion schedules for');
    add('    candidate records)');
    if (isMiddleEast || complianceList.some(function(c){ return c.indexOf('PDPL') >= 0 || c.indexOf('PDPPL') >= 0; })) {
      add('  &bull; Compliance configuration aligned to applicable regional requirements including');
      add('    UAE Personal Data Protection Law (PDPL), Saudi Arabia Personal Data Protection');
      add('    Law (PDPPL), and GDPR where relevant');
    } else if (complianceList.length > 0) {
      complianceList.forEach(function(c){ add('  &bull; ' + c); });
    } else {
      add('  &bull; Standard data privacy defaults will be applied');
    }
    add('  &bull; Specific regional compliance requirements to be confirmed during Examine Phase');
    add('');

    // Data Migration
    add('Data Migration Scope');
    add('');
    if (hasMigration) {
      add('  &bull; ' + a.dataMigration);
      add('  &bull; Data mapping document to be agreed during Examine Phase');
      add('  &bull; Client responsible for data extraction in the EX3-specified format');
      add('  &bull; Migration performed in sandbox environment first for validation before cutover');
      add('  &bull; Maximum of 1 test cycle and 1 production migration cycle');
    } else {
      add('  &bull; Migration of active job requisitions into SAP SuccessFactors Recruiting is included in scope');
      add('  &bull; Data mapping document to be agreed during Examine Phase');
      add('  &bull; Client responsible for data extraction in the EX3-specified format');
      add('  &bull; Migration performed in sandbox environment first for validation before cutover');
      add('  &bull; Maximum of 1 test cycle and 1 production migration cycle');
    }
    add('');

    // Training
    add('Training Scope');
    add('');
    if (trainingList.length > 0) {
      trainingList.forEach(function(t){ add('  &bull; ' + t); });
    } else {
      add('  &bull; 1 Recruiter training session (up to 60 minutes &mdash; end-to-end hiring workflow,');
      add('    candidate management, communication tools)');
      add('  &bull; 1 Administrator training session (up to 90 minutes &mdash; system configuration,');
      add('    user management, reporting)');
      add('  &bull; 1 Hiring Manager training session (up to 45 minutes &mdash; job approval, candidate');
      add('    review, interview scheduling)');
    }
    add('  &bull; All users receive access to the EX3 SAP SF Recruiting Enablement Guide');
    add('  &bull; Sessions recorded and shared with Client for future reference');
    add('  &bull; Training materials provided in advance for pre-reading');
    add('');

    // General Scope
    add('General Scope');
    add('');
    add('Hypercare:');
    add('  &bull; ' + (a.hypercare ? a.hypercare + ' of Hypercare Support' : '10 hours or 20 days of Hypercare Support, whichever comes first'));
    add('');
    add('General Assumptions:');
    add('  &bull; A 3-tier landscape will be used for the project: DEV, STAGE (Test), and PROD');
    add('  &bull; ' + clientName + ' holds a valid SAP SuccessFactors Recruiting licence for the project duration');
    add('    including sandbox/test environments required');
    add('  &bull; Testing time will be allocated for both EX3 and the Client in each iteration');
    add('');
    add('Module Assumptions:');
    add('  &bull; We assume all requirements can be met by standard SAP SuccessFactors Recruiting platform');
    add('    functionality. Use of third-party applications not listed in scope would');
    add('    require a Change Order and may impact timelines and cost');
    add('  &bull; New requirements arising during the project will be considered additional');
    add('    scope and will require a Change Request (CR)');
    add('  &bull; EX3 is not responsible for managing any 3rd party vendors or issues that');
    add('    can only be resolved by a 3rd party');
    add('  &bull; The project will be executed using EX3\\'s EXcelerate Methodology, document');
    add('    templates, and delivery project tools (Smartsheet)');
    add('');

    // â”€â”€ OUT OF SCOPE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Out of Scope');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('Any item, deliverable or activity not explicitly stated as in scope within');
    add('this section is to be deemed out of scope for this SOW.');
    add('');
    add('Other examples of items excluded from scope include:');
    add('  &bull; SAP SuccessFactors Recruiting platform licensing fees (contracted directly between');
    add('    ' + clientName + ' and SAP SuccessFactors Recruiting)');
    add('  &bull; Any integrations not explicitly listed in the Integrations Scope section');
    add('  &bull; Custom API development, bespoke connectors, or non-standard integration builds');
    add('  &bull; Outlook or Google Calendar integration for interview scheduling');
    add('  &bull; Advanced referral programme features (bonus tracking, leaderboards,');
    add('    automated payments)');
    add('  &bull; Ongoing platform administration or managed services after the Hypercare period');
    add('  &bull; Additional training sessions beyond those listed in the Training Scope section');
    add('  &bull; Custom dashboards and custom reports');
    add('  &bull; Any Training Material beyond the EX3 SAP SF Recruiting Enablement Guide');
    add('  &bull; Arabic or any language configuration other than English');
    add('  &bull; Countries or languages beyond those agreed in scope');
    add('  &bull; Recruitment process design or HR consultancy beyond system configuration');
    add('  &bull; Content creation (job descriptions, email copy, brand assets, offer letter text)');
    add('  &bull; Change Management consulting, communications development, or iterative');
    add('    process mapping');
    add('  &bull; Management of client resources or creation of client internal project plans');
    add('  &bull; Changes arising from SAP SuccessFactors Recruiting vendor platform updates');
    add('');

    // â”€â”€ LANGUAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Languages');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('  &bull; Platform language translation: English');
    add('  &bull; All communications and deliverables will occur in English');
    add('  &bull; The SAP SuccessFactors Recruiting career site and all modules will be implemented in');
    add('    English only. Arabic or any additional language configuration is out of');
    add('    scope and would require a Change Order');
    add('');

    // â”€â”€ TESTING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Testing');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('  Activities                                          EX3        Client');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Iterative Unit Testing                              Responsible');
    add('  Systems Integration Test (where applicable)                    Responsible');
    add('  Creation of Test Users                             Responsible');
    add('  Detailed Test Scenarios in Smartsheets             Responsible');
    add('  Confirmation of Testing Approach                   Responsible');
    add('  Cutover to TEST                                    Responsible');
    add('  Additional smoke testing cycle                                 Responsible');
    add('  Cut-over planning                                  Responsible');
    add('  Creation of UAT Approach and Plan                             Responsible');
    add('  Coordination of UAT (feedback, defect, calls)                 Responsible');
    add('  UAT execution                                                  Responsible');
    add('  UAT coordination during UAT                                    Responsible');
    add('  Triage / feedback calls with EX3 (daily)                      Responsible');
    add('  Define Test Approach                                           Responsible');
    add('  Delivery of Test Strategy Document                             Responsible');
    add('  Click-level Test Scripts                                       Responsible');
    add('  Testing Reports for Entry/Exit from each phase                 Responsible');
    add('  All test planning & coordination                               Responsible');
    add('  Full defect management through formal test phases              Responsible');
    add('  Support for all Test Governance during deployment              Responsible');
    add('');

    // â”€â”€ DATA MIGRATION RACI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('Data Migration');
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('');
    add('  Activities                                          EX3        Client');
    add('  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('  Provision of Data Load Templates                   Responsible');
    add('  Basic data validation (general format checks)      Responsible');
    add('  Performing Data Loads (1 test + 1 production)      Responsible');
    add('  Admin Training on BAU data loading                 Responsible');
    add('  Confirmation of Data Migration Approach            Responsible');
    add('  Coordination of data migration tasks               Responsible');
    add('  Support for extraction process from client systems             Responsible');
    add('  Support for governance around data migration                   Responsible');
    add('  Delivery of Data Migration Strategy Document                   Responsible');
    add('  Data Transformation to SAP SuccessFactors Recruiting templates              Responsible');
    add('  Additional cycle of data migration testing                     Responsible');
    add('  Additional training on data loading                            Responsible');
    add('  Data transformation                                             Responsible');
    add('');

    // â”€â”€ FOOTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    add('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
    add('Prepared by EX3  |  Confidential  |  via EXcelerate');

    var sow = L.join('\\n');

    // â”€â”€ end of SOW â”€â”€
    document.getElementById('sow-doc').textContent = sow;
    document.getElementById('wizard-card').style.display = 'none';
    document.getElementById('sow-output').classList.add('show');
    document.getElementById('progress-fill').style.width = '100%';
    document.getElementById('progress-label').textContent = 'Complete \u2713';
    checkRisks();
  }

  function checkRisks() {
    const a = answers;
    const risks = [];
    const warnings = [];
    const integrations = Array.isArray(a.integrations) ? a.integrations : [];
    const hasHRIS = integrations.some(i => i.includes('HRIS'));
    const hasSSO = integrations.some(i => i.includes('SSO'));
    const hasMigration = a.dataMigration && !a.dataMigration.includes('not in scope');
    const shortTimeline = a.timeline === '8 weeks';
    const medTimeline = a.timeline === '10 weeks';
    const isEnterprise = a.orgSize && a.orgSize.includes('Enterprise');
    const isLarge = a.orgSize && (a.orgSize.includes('Large') || a.orgSize.includes('Enterprise'));
    const hasFullOffer = a.offerMgmt && a.offerMgmt.includes('Full offer');
    const hasMultiApproval = a.reqApproval && (a.reqApproval.includes('multi-level') || a.reqApproval.includes('different chains'));
    const isMultiCountry = a.geoScope && !a.geoScope.includes('single country');
    const hasAgency = a.agencyPortal && !a.agencyPortal.includes('No external');
    const complianceCount = Array.isArray(a.compliance) ? a.compliance.length : 0;

    if (shortTimeline && hasHRIS && hasSSO) risks.push('HRIS + SSO + 8 weeks is very aggressive &mdash; consider extending to at least 12 weeks');
    if (shortTimeline && hasMigration) risks.push('Data migration in 8 weeks is high risk &mdash; this typically adds 2&ndash;4 weeks');
    if (isEnterprise && (shortTimeline || medTimeline)) risks.push('Enterprise organisations rarely complete in under 12 weeks &mdash; consider 16 weeks');
    if (integrations.length >= 3 && shortTimeline) risks.push(integrations.length + ' integrations in 8 weeks is very tight &mdash; each integration can take 1&ndash;2 weeks');
    if (isMultiCountry && shortTimeline) risks.push('Multi-country scope in 8 weeks is extremely ambitious &mdash; plan for at least 16 weeks');
    if (hasMultiApproval && shortTimeline) risks.push('Complex multi-level approval chains require significant configuration time &mdash; 8 weeks leaves little room for iteration');
    if (hasFullOffer && hasMigration && shortTimeline) risks.push('Full offer management + data migration + 8 weeks is very high risk &mdash; extend timeline or reduce scope');
    if (hasHRIS) warnings.push('HRIS integrations require IT involvement early &mdash; confirm credentials are available before the build phase');
    if (hasSSO) warnings.push("SSO setup requires the client's IT team &mdash; get them in the kickoff call");
    if (isLarge && a.training && Array.isArray(a.training) && a.training.length < 2) warnings.push('A large organisation with fewer than 2 training sessions may lead to low adoption &mdash; consider adding more');
    if (hasMultiApproval) warnings.push('Multi-level approval chains: map the exact approval flow in discovery before build starts &mdash; late changes are expensive');
    if (isMultiCountry) warnings.push('Multi-country/language: confirm which markets are live at go-live vs phased in later &mdash; scope creep risk is high');
    if (hasAgency) warnings.push('Agency portal: get a list of agencies and their contacts from the client early &mdash; account setup takes time');
    if (complianceCount >= 3) warnings.push('High compliance scope (' + complianceCount + ' items) &mdash; involve the client\\'s DPO or legal team in discovery');

    const banner = document.getElementById('risk-banner');
    if (risks.length === 0 && warnings.length === 0) { banner.style.display = 'none'; return; }

    let html = '';
    if (risks.length) {
      html += '<div style="font-weight:700;color:#991b1b;margin-bottom:8px">ðŸ”´ Risk flags</div>';
      html += risks.map(r => '<div style="margin-bottom:4px">&bull; ' + r + '</div>').join('');
    }
    if (warnings.length) {
      if (risks.length) html += '<div style="margin:10px 0;border-top:1px solid #fde68a"></div>';
      html += '<div style="font-weight:700;color:#92400e;margin-bottom:8px">âš ï¸ Things to watch</div>';
      html += warnings.map(w => '<div style="margin-bottom:4px">&bull; ' + w + '</div>').join('');
    }
    banner.innerHTML = html;
    banner.style.display = 'block';
    banner.style.background = risks.length ? '#fef2f2' : '#fffbeb';
    banner.style.border = '1px solid ' + (risks.length ? '#fecaca' : '#fde68a');
    banner.style.color = risks.length ? '#7f1d1d' : '#78350f';
  }

  async function generateWithAI() {
    const aiStatus = document.getElementById('ai-status');
    aiStatus.style.display = 'block';
    const doc = document.getElementById('sow-doc');
    doc.textContent = '';

    try {
      const res = await fetch('/consultant/sow-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) throw new Error('AI request failed');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        doc.textContent = text;
      }
      aiStatus.style.display = 'none';
    } catch (err) {
      aiStatus.textContent = 'AI generation failed &mdash; please try again.';
      aiStatus.style.background = '#fef2f2';
      aiStatus.style.color = '#991b1b';
    }
  }

  async function exportWord() {
    const res = await fetch('/consultant/sow-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, clientName: answers.clientName }),
    });
    if (!res.ok) { alert('Export failed'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SOW_' + (answers.clientName || 'Client').replace(/[^a-z0-9]/gi, '_') + '.docx';
    a.click();
    URL.revokeObjectURL(url);
  }

  function showEmailForm() {
    const form = document.getElementById('email-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }

  async function sendEmail() {
    const toEmail = document.getElementById('email-to').value.trim();
    const status = document.getElementById('email-status');
    if (!toEmail) { status.textContent = 'Please enter an email address'; return; }
    status.textContent = 'Sending...';
    const content = document.getElementById('sow-doc').textContent;
    const res = await fetch('/consultant/sow-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, clientName: answers.clientName, toEmail }),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = 'âœ… Sent successfully!';
      status.style.color = '#0d7c4c';
    } else {
      status.textContent = 'âŒ ' + (data.error || 'Failed to send');
      status.style.color = '#991b1b';
    }
  }

  function copySow() {
    const text = document.getElementById('sow-doc').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = event.target;
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = orig, 2000);
    });
  }

  function restartWizard() {
    location.reload();
  }
  window.addEventListener('message', function(e){
    if(!e.data || e.data.type !== 'EX3_DEMO') return;
    var d = e.data;

    if(d.action === 'demoWalkSOW'){
      var sowOut = document.getElementById('sow-output');
      if(sowOut && sowOut.classList.contains('show')) return;
      var inp = document.getElementById('client-name');
      if(!inp) return;
      inp.value = '';
      var name = 'Acme Corporation';
      var ni = 0;
      var nameT = setInterval(function(){
        if(ni >= name.length){ clearInterval(nameT); answers.clientName = name; setTimeout(runDemoWalk, 500); return; }
        inp.value += name[ni++];
        answers.clientName = inp.value;
      }, 55);

      function q(arr, delay, fn){ var last = arr.length ? arr[arr.length-1][0] : 0; arr.push([last+delay, fn]); return arr; }
      function runDemoWalk(){
        var actions = [];
        function sc(delay, fn){ var last = actions.length ? actions[actions.length-1][0] : 0; actions.push([last+delay, fn]); }
        var nxt = function(){ document.getElementById('btn-next').click(); };
        sc(400, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-2 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-3 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-4 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-5 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#integrations-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[1])o[1].click(); },250); });
        sc(900, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#jobboards-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[1])o[1].click(); },220); setTimeout(function(){ if(o[3])o[3].click(); },440); });
        sc(950, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-8 .opt'); if(o[0])o[0].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-9 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-10 .opt'); if(o[1])o[1].click(); setTimeout(function(){ if(o[2])o[2].click(); },250); });
        sc(900, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-11 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-12 .opt'); if(o[2])o[2].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-13 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-14 .opt'); if(o[2])o[2].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-15 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-16 .opt'); if(o[1])o[1].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#compliance-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[2])o[2].click(); },250); });
        sc(900, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-18 .opt'); if(o[0])o[0].click(); });
        sc(500, nxt);
        sc(650, function(){ var o=document.querySelectorAll('#step-19 .opt'); if(o[0])o[0].click(); });
        sc(500, nxt);
        actions.forEach(function(a){ setTimeout(a[1], a[0]); });
      }
    }

    if(d.action === 'triggerAIRewrite'){
      var sowOut2 = document.getElementById('sow-output');
      if(!sowOut2 || !sowOut2.classList.contains('show')) return;
      var btns = document.querySelectorAll('button');
      for(var i=0; i<btns.length; i++){
        if(btns[i].textContent.indexOf('Rewrite with AI') > -1){ btns[i].click(); break; }
      }
    }

    if(d.action === 'scrollToExport'){
      var sa = document.querySelector('.sow-actions');
      if(sa) sa.scrollIntoView({behavior:'smooth'});
    }
  });

</script>
</body>
</html>`);
});

// ── UAT Test Scripts ──
app.get('/uat', (_req, res) => {
  res.send(buildUATPage());
});

function buildUATPage() {
  const _data = {"sections":[{"id":"prereqs","title":"PRE-REQUISITES & SYSTEM ACCESS","scenarios":[{"id":"LOGIN-100","title":"System Login","role":"Recruiter","steps":[{"id":"LOGIN-100-1","num":1,"role":"Recruiter","action":"Open your browser (Firefox, Chrome, or Edge recommended) and navigate to the SuccessFactors testing environment","input":"URL: https://hcm-eu10-preview.hr.cloud.sap/login?company=veritasp01T2","expected":"SuccessFactors login page loads successfully"},{"id":"LOGIN-100-2","num":2,"role":"Recruiter","action":"Bookmark the page for quick access during testing","input":"—","expected":"Page is bookmarked"},{"id":"LOGIN-100-3","num":3,"role":"Recruiter","action":"Enter your Username and Password and click Log In","input":"Username: Alex Brackley\nPassword: [TO BE PROVIDED]","expected":"Login is successful — SuccessFactors home page is displayed"}]},{"id":"LOGIN-101","title":"Navigating Modules","role":"Recruiter","steps":[{"id":"LOGIN-101-1","num":1,"role":"Recruiter","action":"In the top-left corner, locate the word 'Home' with a dropdown arrow — this is the Module Picker","input":"—","expected":"Module Picker dropdown arrow is visible next to 'Home'"},{"id":"LOGIN-101-2","num":2,"role":"Recruiter","action":"Click the Module Picker to see the list of available SuccessFactors modules","input":"—","expected":"List of available modules is displayed"},{"id":"LOGIN-101-3","num":3,"role":"Recruiter","action":"Click any module to navigate to it — confirm the correct module page opens","input":"—","expected":"Selected module page opens successfully"}]},{"id":"LOGIN-102","title":"How to Proxy (Impersonate Another User)","role":"Recruiter","steps":[{"id":"LOGIN-102-1","num":1,"role":"Recruiter","action":"In the top-right corner, click your name to open the dropdown menu","input":"—","expected":"Dropdown menu appears"},{"id":"LOGIN-102-2","num":2,"role":"Recruiter","action":"Select 'Proxy Now' from the dropdown","input":"—","expected":"'Select Target User' window appears"},{"id":"LOGIN-102-3","num":3,"role":"Recruiter","action":"Type the full name of the user you wish to proxy as and select them from the results","input":"Input name of the target employee","expected":"Search results display the employee — select to begin proxy"},{"id":"LOGIN-102-4","num":4,"role":"Recruiter","action":"Confirm you are now viewing the system from that user's perspective","input":"—","expected":"Target user's home page is displayed — proxy is active"}]}]},{"id":"rcm","title":"RECRUITING (RCM) — END-TO-END LIFECYCLE","scenarios":[{"id":"RCM-RC-100","title":"Login as Originator","role":"Originator","steps":[{"id":"RCM-RC-100-1","num":1,"role":"Originator","action":"Log in to SuccessFactors as the Originator (or proxy as the Originator)","input":"Username: [ORIGINATOR USERNAME]\nPassword: [TO BE PROVIDED]\n(or use SSO / Proxy)","expected":"Login is successful — SuccessFactors home page is displayed"}]},{"id":"RCM-RC-101","title":"Create a Position","role":"Originator","steps":[{"id":"RCM-RC-101-1","num":1,"role":"Originator","action":"From the Module Picker, navigate to Company Info → Position Org Chart","input":"—","expected":"Position Org Chart is displayed"},{"id":"RCM-RC-101-2","num":2,"role":"Originator","action":"In the Position Org Chart, search for the parent position under which you want to create a new position","input":"Parent Position Number (e.g. POS100001)","expected":"Parent position is displayed in the Org Chart"},{"id":"RCM-RC-101-3","num":3,"role":"Originator","action":"Select the parent position, click the 'Action' button, then click 'Create same level Position' or for ease 'Copy Position'","input":"—","expected":"Create New Position form opens"},{"id":"RCM-RC-101-4","num":4,"role":"Originator","action":"Fill in all required fields (marked with *): Position Title, Department, Location, Cost Center, etc.","input":"Position Title: [e.g. Finance Analyst]\nDepartment, Location, Cost Centre as required","expected":"All required fields are populated correctly"},{"id":"RCM-RC-101-5","num":5,"role":"Originator","action":"Click 'Save' to create the position","input":"—","expected":"Position is created successfully and a Position Number is assigned (e.g. POS100121) ✓ Note the Position Number for the next step"}]},{"id":"RCM-RC-102","title":"Create Job Requisition from Position","role":"Originator","steps":[{"id":"RCM-RC-102-1","num":1,"role":"Originator","action":"In the Position Org Chart, search for the position just created using its Position Number","input":"Position Number from RCM-RC-101 (e.g. POS100121)","expected":"Position is displayed in the Org Chart"},{"id":"RCM-RC-102-2","num":2,"role":"Originator","action":"Select the position and click the 'Action' button, then click 'Create Job Requisition'","input":"—","expected":"Create Job Requisition pop-up appears"},{"id":"RCM-RC-102-3","num":3,"role":"Originator","action":"On the pop-up, select 'Standard Job Requisition' and click 'Create'","input":"Template: Standard Job Requisition","expected":"Standard Job Requisition form opens — position details are pre-populated"},{"id":"RCM-RC-102-4","num":4,"role":"Originator","action":"To edit the requisition, select the clipboard icon and hover over the icon next to the Req ID","input":"—","expected":"Requisition edit options are accessible"},{"id":"RCM-RC-102-5","num":5,"role":"Originator","action":"Fill in all required fields (marked with *) on the requisition form — review all sections thoroughly","input":"Complete all mandatory fields: hiring manager, target start date, number of openings, etc.","expected":"All required fields are populated on the requisition"},{"id":"RCM-RC-102-6","num":6,"role":"Originator","action":"To view the Req ID, status and further details, click the requisition icon at the top of the page","input":"—","expected":"Requisition details page opens showing Req ID, status, and position details ✓ Note the Req ID"}]},{"id":"RCM-RC-103","title":"Send Requisition for Approval","role":"Originator","steps":[{"id":"RCM-RC-103-1","num":1,"role":"Originator","action":"Ensure all required fields are completed on the requisition form","input":"Check all mandatory fields are filled","expected":"All required fields are populated — no validation errors"},{"id":"RCM-RC-103-2","num":2,"role":"Originator","action":"Click 'Send to Next Step' in the bottom-right corner of the page","input":"—","expected":"A confirmation prompt appears — confirm the action"},{"id":"RCM-RC-103-3","num":3,"role":"Originator","action":"Confirm the send action on the confirmation prompt","input":"—","expected":"Requisition is sent to the Recruiter for review/approval — status updates accordingly"}]},{"id":"RCM-RC-104","title":"Approve Requisition","role":"Recruiter","steps":[{"id":"RCM-RC-104-1","num":1,"role":"Recruiter","action":"Log in (or proxy) as the Recruiter who is the first approver of the requisition","input":"—","expected":"Recruiter home page opens"},{"id":"RCM-RC-104-2","num":2,"role":"Recruiter","action":"Locate the 'Approvals' tile on the home page and click it","input":"—","expected":"Recruiting Approvals window opens — the requisition is listed"},{"id":"RCM-RC-104-3","num":3,"role":"Recruiter","action":"Review the requisition details in full","input":"—","expected":"Requisition details are accurate and match what was submitted by the Originator"},{"id":"RCM-RC-104-4","num":4,"role":"Recruiter","action":"In the 'Posting Information' section, add a screening question to the requisition","input":"Select a question from the question library or create a new one","expected":"Question is added to the requisition successfully"},{"id":"RCM-RC-104-5","num":5,"role":"Recruiter","action":"Assign competencies to the requisition for use in Interview Central","input":"Select relevant competencies from the competency library","expected":"Competencies are added to the requisition successfully"},{"id":"RCM-RC-104-6","num":6,"role":"Recruiter","action":"Click 'Approve' to approve the requisition","input":"—","expected":"Requisition is approved — status updates to 'Approved' and it is now ready for posting"}]},{"id":"RCM-RC-105","title":"Post the Job","role":"Recruiter","steps":[{"id":"RCM-RC-105-1","num":1,"role":"Recruiter","action":"From the Module Picker, navigate to the Recruiting module","input":"—","expected":"Recruiting dashboard opens"},{"id":"RCM-RC-105-2","num":2,"role":"Recruiter","action":"Select 'Job Requisitions' from the task bar at the top of the page","input":"—","expected":"Job Requisition list is displayed"},{"id":"RCM-RC-105-3","num":3,"role":"Recruiter","action":"Locate and open the approved Job Requisition from RCM-RC-104","input":"Req ID from RCM-RC-102","expected":"Approved Job Requisition opens"},{"id":"RCM-RC-105-4","num":4,"role":"Recruiter","action":"Click 'Job Postings' within the requisition","input":"—","expected":"Job Postings section opens — available posting channels are displayed"},{"id":"RCM-RC-105-5","num":5,"role":"Recruiter","action":"Select the required posting type, click 'Posting Start Date' and set a Start Date and End Date. Use external private posting with an end date of one week.","input":"Start Date: [today's date]\nEnd Date: [e.g. +7 days]","expected":"Posting dates are set — requisition will be posted on the start date"},{"id":"RCM-RC-105-6","num":6,"role":"Recruiter","action":"Hover over the chain-link icon next to the posting type to copy the posting URL — click it to open in a new tab","input":"—","expected":"URL is copied and the job posting page opens in a new browser tab ✓ Save this URL for RCM-RC-106"}]},{"id":"RCM-RC-106","title":"Apply to the Job (as Candidate)","role":"Candidate","steps":[{"id":"RCM-RC-106-1","num":1,"role":"Candidate","action":"Open a separate browser (or incognito window) and paste the job posting URL from RCM-RC-105","input":"Posting URL from RCM-RC-105","expected":"Job posting opens on the career site — position details are visible"},{"id":"RCM-RC-106-2","num":2,"role":"Candidate","action":"Review the posting details and click 'Apply'","input":"—","expected":"Sign-in / account creation page opens"},{"id":"RCM-RC-106-3","num":3,"role":"Candidate","action":"Create a new candidate account or log in with existing career site credentials","input":"Candidate email and password [TO BE PROVIDED]","expected":"Email verification page opens (if creating a new account)"},{"id":"RCM-RC-106-4","num":4,"role":"Candidate","action":"Verify that a Data Privacy Consent Statement (DPCS) appears before or during account creation","input":"—","expected":"'Privacy Statement – Careers' consent screen is displayed — candidate can accept or decline"},{"id":"RCM-RC-106-5","num":5,"role":"Candidate","action":"Complete email verification if prompted — a confirmation email should arrive","input":"Verification code from email","expected":"Confirmation email received — application form opens"},{"id":"RCM-RC-106-6","num":6,"role":"Candidate","action":"Fill in all required application fields (CV/Resume, address, screening question responses, etc.) and submit","input":"Resume/CV file, personal details, screening question answers","expected":"Application is submitted successfully — confirmation message is displayed"}]},{"id":"RCM-RC-107","title":"Review Candidate Application","role":"Mixed","steps":[{"id":"RCM-RC-107-1","num":1,"role":"Recruiter","action":"Log in (or proxy) as the Recruiter. Navigate to Recruiting → Job Requisitions and open the relevant requisition. Under the 'Candidates' tab, select the candidate and click 'Move Candidate' to move them to 'Screening' status","input":"Req ID from RCM-RC-102","expected":"Candidate is moved to 'Screening' status — pipeline status updates accordingly"},{"id":"RCM-RC-107-2","num":2,"role":"Recruiter","action":"Click the candidate's name to open their profile. Review the application information including name, contact details, CV/Resume, and responses to screening questions","input":"—","expected":"Candidate profile opens — application info is displayed correctly"},{"id":"RCM-RC-107-3","num":3,"role":"Recruiter","action":"Verify the candidate's application status, attached documents, and screening question responses are complete and accurate","input":"—","expected":"All application details are present and correct — candidate is ready to progress"},{"id":"RCM-RC-107-4","num":4,"role":"Recruiter","action":"Click 'Move Candidate' and move the candidate to 'Hiring Manager Review' status","input":"Status: Hiring Manager Review","expected":"Candidate is moved to 'Hiring Manager Review' status"},{"id":"RCM-RC-107-5","num":5,"role":"Hiring Manager","action":"Proxy as the Hiring Manager. Navigate to Recruiting → Job Requisitions and open the relevant requisition. Verify the candidate is visible under the 'Candidates' tab with 'Hiring Manager Review' status","input":"Req ID from RCM-RC-102","expected":"Candidate application is visible to the Hiring Manager under 'Hiring Manager Review' status"},{"id":"RCM-RC-107-6","num":6,"role":"Hiring Manager","action":"Click the candidate's name to open their profile. Verify the application information is visible — view only","input":"—","expected":"Candidate profile opens — application info is visible to the Hiring Manager"},{"id":"RCM-RC-107-7","num":7,"role":"Hiring Manager","action":"Select the candidate, click 'Move Candidate', and move the candidate to 'Proceed' status","input":"Status: Proceed","expected":"Candidate is moved to 'Proceed' status"}]},{"id":"RCM-RC-108a","title":"Schedule an Interview","role":"Recruiter","steps":[{"id":"RCM-RC-108a-1","num":1,"role":"Recruiter","action":"Navigate to Recruiting and open the relevant Job Requisition","input":"Req ID from RCM-RC-102","expected":"Job Requisition is open"},{"id":"RCM-RC-108a-2","num":2,"role":"Recruiter","action":"Click the 'Candidates' tab to view the candidate pipeline","input":"—","expected":"Candidates tab opens — the applicant from RCM-RC-106 is visible"},{"id":"RCM-RC-108a-3","num":3,"role":"Recruiter","action":"Select the candidate by checking the checkbox next to their name","input":"—","expected":"Candidate is selected — action options become available"},{"id":"RCM-RC-108a-4","num":4,"role":"Recruiter","action":"Click 'Move Candidate' and move them to the 'Schedule Interview' status","input":"Status: Schedule Interview","expected":"Candidate pipeline status updates to 'Schedule Interview'"},{"id":"RCM-RC-108a-5","num":5,"role":"Recruiter","action":"Click 'Interview Scheduling' at the top of the page","input":"—","expected":"Interview Scheduling page opens"},{"id":"RCM-RC-108a-6","num":6,"role":"Recruiter","action":"Find the tile for your Req ID and click 'Not Started' to begin scheduling","input":"—","expected":"Select Candidates menu opens"},{"id":"RCM-RC-108a-7","num":7,"role":"Recruiter","action":"Choose the Interview Type (Phone, Virtual, or Face-to-Face)","input":"Interview Type: [e.g. Virtual]","expected":"Interview type is selected"},{"id":"RCM-RC-108a-8","num":8,"role":"Recruiter","action":"Set the interviewer — add by 'Name' or 'Role in Requisition' and select the Hiring Manager","input":"Hiring Manager name","expected":"Hiring Manager is listed as the assigned interviewer"},{"id":"RCM-RC-108a-9","num":9,"role":"Recruiter","action":"Click 'Find Availability' to open the Hiring Manager's calendar","input":"—","expected":"Hiring Manager calendar opens"},{"id":"RCM-RC-108a-10","num":10,"role":"Recruiter","action":"Click '+ Add Custom Slot' and select a suitable date and time, then click 'Add and Select'","input":"Interview date & time","expected":"Date and time slot is added to the interview schedule"},{"id":"RCM-RC-108a-11","num":11,"role":"Recruiter","action":"Click 'Continue', check 'Book this slot for candidates', then click 'Send to candidate'","input":"—","expected":"Confirmation message appears — interview invitation is sent to the candidate"}]},{"id":"RCM-RC-108b","title":"Confirm Interview Time (Candidate)","role":"Candidate","steps":[{"id":"RCM-RC-108b-1","num":1,"role":"Candidate","action":"Log in to the candidate portal using the candidate credentials created in RCM-RC-106","input":"Candidate login credentials from RCM-RC-106","expected":"Candidate portal home page opens successfully"},{"id":"RCM-RC-108b-2","num":2,"role":"Candidate","action":"Check the email inbox for the interview invitation email sent from SuccessFactors","input":"Candidate email address","expected":"Interview invitation email is received with correct date, time, and interview details"},{"id":"RCM-RC-108b-3","num":3,"role":"Candidate","action":"Click the link in the email to open the interview self-scheduling page in the candidate portal","input":"—","expected":"Interview self-scheduling page opens showing the available time slot(s)"},{"id":"RCM-RC-108b-4","num":4,"role":"Candidate","action":"Review the proposed interview date, time, and format (Phone / Virtual / Face-to-Face)","input":"Interview date & time from RCM-RC-108a","expected":"Interview details are displayed correctly — date, time, and type match what was scheduled"},{"id":"RCM-RC-108b-5","num":5,"role":"Candidate","action":"Select the proposed time slot and click 'Confirm' (or 'Book') to accept the interview time","input":"—","expected":"Time slot is selected — 'Confirm' button is enabled"},{"id":"RCM-RC-108b-6","num":6,"role":"Candidate","action":"Verify the confirmation message appears and check that a confirmation email is received","input":"—","expected":"Confirmation message is displayed on screen and a confirmation email is sent to the candidate"},{"id":"RCM-RC-108b-7","num":7,"role":"Candidate","action":"Navigate to the candidate's 'My Applications' page and verify the interview status shows as 'Confirmed'","input":"—","expected":"Application status reflects 'Interview Confirmed' — the scheduled date and time are visible"}]},{"id":"RCM-RC-109","title":"Provide Interview Feedback","role":"Hiring Manager","steps":[{"id":"RCM-RC-109-1","num":1,"role":"Hiring Manager","action":"Log in (or proxy) as the Hiring Manager assigned to conduct the interview","input":"—","expected":"Hiring Manager home page opens"},{"id":"RCM-RC-109-2","num":2,"role":"Hiring Manager","action":"Locate the 'Provide Interview Feedback' tile on the home page and click it","input":"—","expected":"'Provide Interview Feedback' window opens"},{"id":"RCM-RC-109-3","num":3,"role":"Hiring Manager","action":"Select the interview to provide feedback on","input":"—","expected":"Interview feedback form opens — competencies from RCM-RC-104 are displayed with rating fields"},{"id":"RCM-RC-109-4","num":4,"role":"Hiring Manager","action":"For each competency, assign a rating using the EX3 Interview Assessment scale","input":"Scale: 0 (Not Applicable) through 5 (Exceptional)","expected":"All competencies are rated"},{"id":"RCM-RC-109-5","num":5,"role":"Hiring Manager","action":"Provide an overall recommendation (Recommended / Not Recommended) and add comments if required. Click Save.","input":"Overall rating & comments","expected":"Review is complete — feedback is saved"},{"id":"RCM-RC-109-6","num":6,"role":"Recruiter","action":"Log back in (or proxy) as the Recruiter and verify the candidate feedback is visible on the candidate application profile","input":"—","expected":"Interview feedback is visible — rating and comments are shown correctly"}]},{"id":"RCM-RC-110","title":"Prepare Offer for Approval","role":"Recruiter","steps":[{"id":"RCM-RC-110-1","num":1,"role":"Recruiter","action":"Navigate to Recruiting and open the Job Requisition","input":"Req ID from RCM-RC-102","expected":"Job Requisition is open"},{"id":"RCM-RC-110-2","num":2,"role":"Recruiter","action":"Click the 'Candidates' tab","input":"—","expected":"Candidate pipeline is displayed"},{"id":"RCM-RC-110-3","num":3,"role":"Recruiter","action":"Find the candidate and open their candidate profile","input":"—","expected":"Candidate profile opens"},{"id":"RCM-RC-110-4","num":4,"role":"Recruiter","action":"Check the checkbox next to the candidate's name, click 'Action' → 'Move Candidate'","input":"—","expected":"Move Candidate menu appears"},{"id":"RCM-RC-110-5","num":5,"role":"Recruiter","action":"Select Status: 'Prepare Offer', add a comment if desired, and click 'Move'","input":"Status: Prepare Offer","expected":"Candidate is moved to Offer status — sub-item: Prepare Offer"},{"id":"RCM-RC-110-6","num":6,"role":"Recruiter","action":"Click the candidate's name to open their profile, then click the additional action menu (…)","input":"—","expected":"Additional action menu appears"},{"id":"RCM-RC-110-7","num":7,"role":"Recruiter","action":"Click 'Initiate Offer Approval'","input":"—","expected":"Offer Approval screen opens"},{"id":"RCM-RC-110-8","num":8,"role":"Recruiter","action":"Select the Offer Approval template and fill in all required offer fields","input":"Template: [EX3 Offer Approval Template]\nOffer fields: Salary, Start Date, Contract Type, etc.","expected":"Offer Detail is populated — Hiring Manager appears as Approver 1 and Recruiter as Approver 2"},{"id":"RCM-RC-110-9","num":9,"role":"Recruiter","action":"If needed, add an Adhoc approver using the additional approver option","input":"Adhoc approver name (optional)","expected":"Approver chain is configured correctly"},{"id":"RCM-RC-110-10","num":10,"role":"Recruiter","action":"Click 'Send for Approval' at the bottom of the page","input":"—","expected":"Offer is sent for approval — status updates accordingly"}]},{"id":"RCM-RC-111","title":"Approve or Decline an Offer","role":"Approver","steps":[{"id":"RCM-RC-111-1","num":1,"role":"Approver","action":"Log in (or proxy) as the first offer approver (Hiring Manager). A 'Job Offer' tile will appear on the home page — click it","input":"—","expected":"Window with all pending recruiting approvals appears"},{"id":"RCM-RC-111-2","num":2,"role":"Approver","action":"Click the tile to open the offer for review","input":"—","expected":"Offer Detail template opens showing: Type of Hire, Name, Salary, Start Date, and other offer fields"},{"id":"RCM-RC-111-3","num":3,"role":"Approver","action":"Review the offer details. Add a comment if desired, then click 'Approve' (or 'Decline' if testing a decline scenario)","input":"Comments (optional)","expected":"Offer is approved (or declined) — status updates and the next approver is notified"},{"id":"RCM-RC-111-4","num":4,"role":"Approver","action":"If testing a full approval chain: repeat steps 1–3 as the second approver (Recruiter)","input":"—","expected":"All approvers in the chain have approved — offer status changes to 'Offer Approved'"}]},{"id":"RCM-RC-112","title":"Verify Offer Details (Recruiter)","role":"Recruiter","steps":[{"id":"RCM-RC-112-1","num":1,"role":"Recruiter","action":"Log in (or proxy) as the Recruiter. Navigate to Recruiting, open the Job Requisition and click the 'Candidates' tab","input":"Req ID from RCM-RC-102","expected":"Candidate pipeline is displayed — candidate is in 'Offer Approved' status"},{"id":"RCM-RC-112-2","num":2,"role":"Recruiter","action":"Click the candidate's name to open their profile, then navigate to the 'Applicant Info' section","input":"—","expected":"Candidate profile opens — 'Applicant Info' section is visible"},{"id":"RCM-RC-112-3","num":3,"role":"Recruiter","action":"Verify that the 'Start Date' field is populated with the correct date","input":"Expected start date from offer","expected":"Start Date is populated and matches the date entered during offer approval in RCM-RC-110"},{"id":"RCM-RC-112-4","num":4,"role":"Recruiter","action":"Verify that the 'Offered Salary' field is populated with the correct amount","input":"Offered salary from RCM-RC-110","expected":"Offered Salary is populated and matches the salary entered during offer preparation in RCM-RC-110"}]},{"id":"RCM-RC-113","title":"Extend Offer to Candidate","role":"Recruiter","steps":[{"id":"RCM-RC-113-1","num":1,"role":"Recruiter","action":"Navigate to Recruiting, open the requisition, and move the candidate to 'Offer Extended' status","input":"Req ID from RCM-RC-102","expected":"Candidate is moved to 'Offer Extended' sub-status in the pipeline"},{"id":"RCM-RC-113-2","num":2,"role":"Recruiter","action":"Open the candidate's profile and click the additional action menu","input":"—","expected":"Additional action menu appears"},{"id":"RCM-RC-113-3","num":3,"role":"Recruiter","action":"Hover over 'Offer' then click 'Offer Letter'","input":"—","expected":"Offer Letter template selection opens"},{"id":"RCM-RC-113-4","num":4,"role":"Recruiter","action":"Select: Country/Region = United Kingdom, Language = en_GB, Template = EX3 UK Offer Letter","input":"Country: United Kingdom\nLanguage: en_GB\nTemplate: EX3 UK Offer Letter","expected":"Offer Letter page opens with EX3 UK Offer Letter template loaded — validate tokens are visible"},{"id":"RCM-RC-113-5","num":5,"role":"Recruiter","action":"Validate that all tokens in the offer letter are populating correctly (e.g. Department, Job Title, Salary, Start Date)","input":"—","expected":"All tokens are correctly populated with dynamic values from the requisition and offer"},{"id":"RCM-RC-113-6","num":6,"role":"Recruiter","action":"Edit any elements of the offer letter as needed and add any attachments. Click 'Next Step' to preview","input":"Any edits or attachments required","expected":"Offer letter preview appears along with offer delivery method options"},{"id":"RCM-RC-113-7","num":7,"role":"Recruiter","action":"Select the delivery method and send the offer letter to the candidate","input":"Delivery method: [e.g. E-Signature / Email]","expected":"Offer letter is sent via the selected method"},{"id":"RCM-RC-113-8","num":8,"role":"Recruiter","action":"Click Send.","input":"—","expected":"Candidate status is updated to 'Offer Extended'"}]},{"id":"RCM-RC-114","title":"Accept / Decline Offer as Candidate","role":"Candidate","steps":[{"id":"RCM-RC-114-1","num":1,"role":"Candidate","action":"Check the candidate email inbox for the 'Offer of Employment' email and click 'View / Accept Offer'","input":"—","expected":"Candidate receives the 'Offer of Employment' email with a link to the offer"},{"id":"RCM-RC-114-2","num":2,"role":"Candidate","action":"Sign in to the career site using the candidate credentials","input":"Career site credentials: [CANDIDATE USERNAME / PASSWORD]","expected":"Career site login is successful"},{"id":"RCM-RC-114-3","num":3,"role":"Candidate","action":"Navigate to 'My Offers' section — the offer should be visible","input":"—","expected":"Offer is displayed in the 'My Offers' section"},{"id":"RCM-RC-114-4","num":4,"role":"Candidate","action":"Review the offer letter — options to Accept, Decline, and Download should be present","input":"—","expected":"Offer letter is displayed with Accept, Decline, and Download options visible"},{"id":"RCM-RC-114-5","num":5,"role":"Candidate","action":"Test Accept path: Click 'Accept' — a confirmation pop-up should appear. Confirm acceptance.","input":"—","expected":"'Congratulations' pop-up appears confirming the offer has been accepted"},{"id":"RCM-RC-114-6","num":6,"role":"Candidate","action":"Optional — Test Decline path: Click 'Decline', provide a reason in the comment box, and confirm","input":"Decline reason (comment)","expected":"Comment box opens — offer status updates to 'Offer Declined by Candidate'"},{"id":"RCM-RC-114-7","num":7,"role":"Candidate","action":"After accepting/declining, verify the offer status is updated in the 'My Offers' section","input":"—","expected":"Offer status reflects the candidate's decision correctly"}]},{"id":"RCM-RC-115","title":"Recruiter: Check Offer Status","role":"Recruiter","steps":[{"id":"RCM-RC-115-1","num":1,"role":"Recruiter","action":"Navigate to Recruiting, select the Job Requisitions tab, and open the relevant requisition","input":"Req ID from RCM-RC-102","expected":"Job Requisition and candidate pipeline is displayed"},{"id":"RCM-RC-115-2","num":2,"role":"Recruiter","action":"Click 'Candidates' and open the candidate's profile","input":"—","expected":"Candidate profile opens"},{"id":"RCM-RC-115-3","num":3,"role":"Recruiter","action":"Confirm Status = 'Offer Approved'","input":"—","expected":"Candidate's offer acceptance or decline response is visible and matches the action taken in RCM-RC-114"}]},{"id":"RCM-RC-116","title":"Initiate Onboarding / Move to Hired","role":"Recruiter","steps":[{"id":"RCM-RC-116-1","num":1,"role":"Recruiter","action":"Navigate to Recruiting, open the Job Requisition, and locate the accepted candidate","input":"Req ID from RCM-RC-102","expected":"Job Requisition and candidate pipeline is displayed"},{"id":"RCM-RC-116-2","num":2,"role":"Recruiter","action":"Check the checkbox next to the candidate's name, click 'Action' → 'Move Candidate'","input":"—","expected":"Move Candidate menu appears with post-offer status options"},{"id":"RCM-RC-116-3","num":3,"role":"Recruiter","action":"Select the appropriate post-offer status (e.g. Post-Offer Background Check or move directly to Hirable)","input":"Status: [Post-Offer Background Check / Hirable]","expected":"Candidate is moved to the selected post-offer status"},{"id":"RCM-RC-116-4","num":4,"role":"Recruiter","action":"Confirm all previous steps have completed successfully — offer accepted, onboarding status verified, and candidate details are correct","input":"—","expected":"All prior statuses and checks are confirmed as passed — candidate is ready to be moved to Hired"},{"id":"RCM-RC-116-5","num":5,"role":"Recruiter","action":"Select 'Hired' from the status dropdown and click 'Save' to move the candidate to Hired","input":"Status: Hired","expected":"Candidate is moved to 'Hired' status — the requisition is now fulfilled ✓ If Onboarding is configured, the onboarding trigger fires"}]}]}]};
  const _css = "*{margin:0;padding:0;box-sizing:border-box}\n:root{\n  --canvas:#F5F4F0;--surface:#fff;--surface-2:#FAFAF7;\n  --border:#E6E3DB;--border-light:#EEEBE4;\n  --ink:#18171A;--ink-2:#3A3836;--ink-3:#7C7870;--ink-4:#B8B4AC;\n  --sb:#16161A;--sb-muted:#6A6763;--sb-txt:#DEDAD3;\n  --sb-hover:#1D1D22;--sb-active:#232329;--sb-bar:#4A6FD4;\n  --pass:#1A6640;--pass-bg:#EEF8F2;--pass-bd:#A8D9BB;\n  --fail:#8B1C2F;--fail-bg:#FAF0F2;--fail-bd:#F0B0BC;\n  --blk:#7A5200;--blk-bg:#FBF5E4;--blk-bd:#EDD48A;\n  --na:#5E5A56;--na-bg:#F3F2EF;--na-bd:#D5D2CB;\n  --acc:#2B4EAE;--acc-bg:#EBF0FA;--acc-bd:#B8CBF0;\n  --sb-w:272px;--top-h:52px;\n}\nhtml,body{height:100%;background:var(--canvas);font-family:\"Inter\",system-ui,sans-serif;color:var(--ink);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}\n.topbar{position:fixed;top:0;left:0;right:0;height:var(--top-h);background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:stretch;z-index:100}\n.tb-brand{width:var(--sb-w);flex-shrink:0;border-right:1px solid var(--border);display:flex;align-items:center;gap:10px;padding:0 20px}\n.tb-mark{width:22px;height:22px;border-radius:5px;background:var(--ink);display:flex;align-items:center;justify-content:center;flex-shrink:0}\n.tb-mark svg{width:12px;height:12px;fill:#fff}\n.tb-label{font-size:13px;font-weight:700;letter-spacing:-.02em}\n.tb-center{flex:1;display:flex;align-items:center;gap:14px;padding:0 24px}\n.tb-sep{width:1px;height:20px;background:var(--border)}\n.tb-page{font-size:12.5px;color:var(--ink-3);font-weight:500;white-space:nowrap}\n.prog-track{flex:1;max-width:200px;height:2px;background:var(--border);border-radius:1px;overflow:hidden}\n.prog-fill{height:100%;background:var(--acc);border-radius:1px;transition:width .4s ease;width:0%}\n.prog-lbl{font-size:11.5px;color:var(--ink-3);font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}\n.tb-right{display:flex;align-items:center;gap:6px;padding:0 20px}\n.tbtn{padding:5px 13px;border-radius:6px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--ink-2);transition:background .12s,border-color .12s;white-space:nowrap}\n.tbtn:hover{background:var(--canvas)}\n.tbtn.primary{background:var(--ink);color:#fff;border-color:var(--ink)}\n.tbtn.primary:hover{opacity:.88}\n.layout{display:flex;padding-top:var(--top-h);height:100vh}\n.sidebar{width:var(--sb-w);flex-shrink:0;background:var(--sb);overflow-y:auto;padding:20px 0 48px}\n.sidebar::-webkit-scrollbar{width:3px}.sidebar::-webkit-scrollbar-thumb{background:#333}\n.sb-sec{padding:20px 18px 6px;font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--sb-muted)}\n.sb-item{display:flex;align-items:center;gap:8px;padding:7px 18px;cursor:pointer;border-left:2px solid transparent;transition:background .1s,border-color .1s}\n.sb-item:hover{background:var(--sb-hover)}\n.sb-item.active{background:var(--sb-active);border-left-color:var(--sb-bar)}\n.sb-id{font-size:9.5px;font-weight:600;font-family:\"IBM Plex Mono\",monospace;color:var(--sb-muted);flex-shrink:0;min-width:62px}\n.sb-title{font-size:11.5px;font-weight:500;color:var(--sb-txt);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.sb-ring{flex-shrink:0;width:18px;height:18px}\n.sb-ring circle{fill:none;stroke-width:2.5}\n.sb-ring .track{stroke:#2A2A2F}\n.sb-ring .fill{stroke:var(--pass);stroke-linecap:round;stroke-dasharray:50.3;stroke-dashoffset:50.3;transition:stroke-dashoffset .4s ease,stroke .3s}\n.sb-ring.fail .fill{stroke:var(--fail)}\n.sb-ring.part .fill{stroke:var(--blk)}\n.sb-ring.prog .fill{stroke:var(--acc)}\n.main{flex:1;overflow-y:auto;padding:36px 40px;scroll-behavior:smooth}\n.pg-hdr{margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--border)}\n.pg-eye{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-4);margin-bottom:6px}\n.pg-title{font-size:22px;font-weight:700;letter-spacing:-.03em;line-height:1.2}\n.pg-sub{font-size:13px;color:var(--ink-3);margin-top:4px}\n.stats-row{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:32px}\n.stat-tile{padding:14px 18px;background:var(--surface);display:flex;flex-direction:column;gap:2px}\n.stat-n{font-size:24px;font-weight:700;letter-spacing:-.05em;line-height:1;font-variant-numeric:tabular-nums}\n.stat-l{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}\n.stat-tile.pass .stat-n{color:var(--pass)}.stat-tile.fail .stat-n{color:var(--fail)}.stat-tile.blk .stat-n{color:var(--blk)}.stat-tile.na .stat-n{color:var(--na)}.stat-tile.pend .stat-n{color:var(--acc)}\n.sec-lbl{font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-4);margin:4px 0 12px}\n.sc-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden;transition:border-color .2s,box-shadow .2s}\n.sc-card.open{border-color:#C8D4EE;box-shadow:0 2px 16px rgba(43,78,174,.07)}\n.sc-head{display:flex;align-items:center;gap:12px;padding:13px 18px;cursor:pointer;user-select:none;transition:background .1s}\n.sc-head:hover{background:var(--surface-2)}\n.sc-id{font-family:\"IBM Plex Mono\",monospace;font-size:10px;font-weight:600;color:var(--ink-4);flex-shrink:0;min-width:72px}\n.sc-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;flex:1}\n.sc-role{padding:2px 9px;border-radius:4px;font-size:9.5px;font-weight:700;letter-spacing:.03em;flex-shrink:0;text-transform:uppercase}\n.sc-ring{flex-shrink:0;width:32px;height:32px}\n.sc-ring circle{fill:none;stroke-width:3}\n.sc-ring .track{stroke:#EEECEA}\n.sc-ring .fill{stroke:var(--pass);stroke-linecap:round;stroke-dasharray:81.7;stroke-dashoffset:81.7;transition:stroke-dashoffset .4s ease,stroke .3s}\n.sc-ring.fail .fill{stroke:var(--fail)}\n.sc-ring.part .fill{stroke:var(--blk)}\n.sc-ring.prog .fill{stroke:var(--acc)}\n.sc-ring-pct{font-size:7.5px;font-weight:800;fill:var(--ink-3)}\n.chevron{font-size:9px;color:var(--ink-4);transition:transform .2s;flex-shrink:0}\n.sc-card.open .chevron{transform:rotate(180deg)}\n.sc-body{display:none;border-top:1px solid var(--border-light)}\n.sc-card.open .sc-body{display:block}\n.steps-tbl{width:100%;border-collapse:collapse}\n.s-row{border-bottom:1px solid var(--border-light);transition:background .15s}\n.s-row:last-child{border-bottom:none}\n.s-row.st-Pass{background:var(--pass-bg)}.s-row.st-Fail{background:var(--fail-bg)}.s-row.st-Blocked{background:var(--blk-bg)}.s-row.st-NA{background:var(--na-bg)}\n.s-num{width:38px;padding:14px 0 14px 18px;vertical-align:top;font-size:10.5px;font-weight:700;color:var(--ink-4);font-family:\"IBM Plex Mono\",monospace;line-height:1}\n.s-dot-c{width:14px;padding:16px 0 14px 2px;vertical-align:top}\n.s-dot{width:6px;height:6px;border-radius:50%}\n.s-content{padding:14px 12px 14px 0;vertical-align:top}\n.s-action{font-size:13px;font-weight:500;color:var(--ink);line-height:1.65;margin-bottom:10px}\n.s-meta{display:flex;gap:20px;flex-wrap:wrap}\n.s-mb{display:flex;flex-direction:column;gap:3px;min-width:110px;max-width:260px}\n.s-ml{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-4)}\n.s-mv{font-size:12px;color:var(--ink-2);line-height:1.55;white-space:pre-wrap}\n.s-rb{display:inline-block;font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.03em;text-transform:uppercase}\n.s-acts{width:164px;padding:14px 18px 14px 6px;vertical-align:top}\n.s-btns{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:8px}\n.s-btn{padding:4px 8px;border-radius:5px;font-family:inherit;font-size:10.5px;font-weight:600;cursor:pointer;border:1px solid transparent;transition:all .1s;white-space:nowrap}\n.s-btn.pass{border-color:var(--pass-bd);background:var(--pass-bg);color:var(--pass)}.s-btn.pass:hover,.s-btn.pass.on{background:var(--pass);color:#fff;border-color:var(--pass)}\n.s-btn.fail{border-color:var(--fail-bd);background:var(--fail-bg);color:var(--fail)}.s-btn.fail:hover,.s-btn.fail.on{background:var(--fail);color:#fff;border-color:var(--fail)}\n.s-btn.blk{border-color:var(--blk-bd);background:var(--blk-bg);color:var(--blk)}.s-btn.blk:hover,.s-btn.blk.on{background:var(--blk);color:#fff;border-color:var(--blk)}\n.s-btn.na{border-color:var(--na-bd);background:var(--na-bg);color:var(--na)}.s-btn.na:hover,.s-btn.na.on{background:var(--na);color:#fff;border-color:var(--na)}\n.s-cmt{width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:5px;font-family:inherit;font-size:11.5px;resize:vertical;min-height:42px;background:#FFFEF9;color:var(--ink);display:none;line-height:1.5}\n.s-cmt:focus{outline:none;border-color:var(--ink-3)}.s-cmt.show{display:block}\n.sc-nav{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-top:1px solid var(--border-light);background:var(--surface-2)}\n.sc-nav-info{font-size:11.5px;color:var(--ink-3);font-weight:500}\n.sc-nav-btns{display:flex;gap:6px}\n.nav-btn{padding:6px 16px;border-radius:7px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--ink-2);transition:all .12s;display:flex;align-items:center;gap:5px}\n.nav-btn:hover{background:var(--canvas);border-color:var(--ink-4)}\n.nav-btn.next{background:var(--ink);color:#fff;border-color:var(--ink)}\n.nav-btn.next:hover{opacity:.88}\n.nav-btn:disabled{opacity:.3;cursor:not-allowed;pointer-events:none}\n.rp-Originator{background:#E8EFFC;color:#1D3B7A}.rp-Recruiter{background:#E5F5ED;color:#19593A}\n.rp-Approver{background:#FBF3E3;color:#7A5000}.rp-HiringManager{background:#F1EAFF;color:#5A1FA8}\n.rp-Candidate{background:#E4F1FB;color:#0C3B6E}.rp-Mixed{background:#EEECEA;color:#4A4744}\n.mo{position:fixed;inset:0;background:rgba(12,10,9,.5);z-index:200;display:none;align-items:center;justify-content:center;backdrop-filter:blur(6px)}\n.mo.show{display:flex}\n.mo-box{background:var(--surface);border-radius:14px;padding:32px 36px;max-width:560px;width:90%;max-height:82vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.18)}\n.mo-hdr{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px}\n.mo-title{font-size:17px;font-weight:700;letter-spacing:-.02em}\n.mo-x{background:none;border:none;cursor:pointer;color:var(--ink-4);font-size:20px;line-height:1;padding:0 2px}.mo-x:hover{color:var(--ink)}\n.ex-sec{margin-bottom:20px}\n.ex-sec-t{font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-4);margin-bottom:10px}\n.ex-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-light);font-size:12.5px;gap:8px}\n.ex-row:last-child{border-bottom:none}\n.ex-st{padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;flex-shrink:0;letter-spacing:.04em;text-transform:uppercase}\n.ex-st.Pass{background:var(--pass-bg);color:var(--pass)}.ex-st.Fail{background:var(--fail-bg);color:var(--fail)}\n.ex-st.Blocked{background:var(--blk-bg);color:var(--blk)}.ex-st.NA{background:var(--na-bg);color:var(--na)}\n.ex-st.Pending{background:var(--acc-bg);color:var(--acc)}\n.mo-close{margin-top:24px;width:100%;padding:11px;background:var(--ink);color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}\n.mo-close:hover{opacity:.88}\n@media print{\n  .topbar,.sidebar,.sc-nav,.tbtn,button,.s-btn,.s-cmt{display:none!important}\n  .layout{display:block;padding-top:0}\n  .main{overflow:visible;padding:0}\n  .sc-card{border:1px solid #ccc;page-break-inside:avoid;margin-bottom:12px;box-shadow:none}\n  .sc-body{display:block!important}\n  .s-row.st-Pass{background:#f0fdf4!important}.s-row.st-Fail{background:#fef2f2!important}\n  .s-row.st-Blocked{background:#fffbeb!important}.s-row.st-NA{background:#f9fafb!important}\n  @page{margin:20mm}\n}\n.ai-float{position:fixed;bottom:24px;right:24px;z-index:500;display:flex;flex-direction:column;align-items:flex-end;gap:10px}\n.ai-fab{width:52px;height:52px;border-radius:14px;background:#2B4EAE;color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:800;letter-spacing:-.01em;box-shadow:0 8px 28px rgba(43,78,174,.38);transition:transform .15s,box-shadow .15s;font-family:inherit}\n.ai-fab:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(43,78,174,.45)}\n.ai-fab.open{background:#18171A;box-shadow:none}\n.ai-panel{width:360px;max-height:min(600px,calc(100vh - 100px));background:#fff;border:1px solid var(--border);border-radius:16px;box-shadow:0 20px 56px rgba(0,0,0,.16);overflow:hidden;display:flex;flex-direction:column;opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .18s,transform .18s}\n.ai-panel.open{opacity:1;transform:translateY(0);pointer-events:auto}\n.ai-ph{padding:13px 16px;background:var(--canvas);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}\n.ai-pt{font-size:13.5px;font-weight:700;letter-spacing:-.01em}\n.ai-px{background:none;border:none;cursor:pointer;color:var(--ink-3);font-size:20px;line-height:1;padding:0 2px}\n.ai-px:hover{color:var(--ink)}\n.ai-body{padding:14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-height:0}\n.ai-resp{font-size:12.5px;color:var(--ink-2);line-height:1.65;padding:12px 14px;border-radius:12px;background:var(--canvas);max-height:260px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}\n.ai-prompt{display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:12px;background:var(--canvas);border:none;color:var(--ink);cursor:pointer;transition:background .12s;text-align:left;font-family:inherit;font-size:12.5px;width:100%}\n.ai-prompt:hover{background:var(--border-light)}\n.ai-pi{width:26px;height:26px;border-radius:8px;background:#fff;display:grid;place-items:center;font-size:12px;font-weight:700;color:var(--ink);flex-shrink:0;border:1px solid var(--border)}\n.ai-field{display:flex;gap:7px;align-items:center}\n.ai-input{flex:1;background:var(--canvas);border:1px solid var(--border);border-radius:10px;padding:9px 11px;font-size:12.5px;color:var(--ink);outline:none;font-family:inherit}\n.ai-input:focus{border-color:var(--ink-3)}\n.ai-send{padding:9px 14px;border:none;border-radius:10px;background:#2B4EAE;color:#fff;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:700;transition:opacity .12s;white-space:nowrap}\n.ai-send:hover{opacity:.88}\n.ai-fu{display:flex;flex-direction:column;gap:5px}\n.ai-fu-lbl{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-4);padding:0 2px}\n.ai-fub{display:block;width:100%;text-align:left;padding:8px 11px;border-radius:10px;background:var(--canvas);border:1px solid var(--border);font-family:inherit;font-size:12px;color:var(--ink-2);cursor:pointer;transition:background .1s}\n.ai-fub:hover{background:var(--border-light)}\n.ai-new-chat{font-size:11px;color:var(--ink-4);background:none;border:none;cursor:pointer;text-decoration:underline;text-underline-offset:2px;padding:0;font-family:inherit}\n.ai-new-chat:hover{color:var(--ink-2)}";
  const _js  = "var SK='rcm_uat_v1';\nvar OPEN_ID=null;\nvar SC_IDS=(function(){var a=[];UAT.sections.forEach(function(s){s.scenarios.forEach(function(sc){a.push(sc.id)})});return a})();\nvar SC_MAP=(function(){var m={};UAT.sections.forEach(function(s){s.scenarios.forEach(function(sc){m[sc.id]=sc})});return m})();\nfunction loadSt(){try{return JSON.parse(localStorage.getItem(SK)||'{}')}catch(e){return {}}}\nfunction saveSt(s){localStorage.setItem(SK,JSON.stringify(s))}\nvar RM={'Originator':'Originator','Recruiter':'Recruiter','Approver':'Approver','Hiring Manager':'HiringManager','Candidate':'Candidate','Mixed':'Mixed'};\nvar RC={'Originator':'#1D3B7A','Recruiter':'#19593A','Approver':'#7A5000','Hiring Manager':'#5A1FA8','Candidate':'#0C3B6E','Mixed':'#4A4744'};\nfunction rp(r){return 'rp-'+(RM[r]||r.replace(/[^a-zA-Z]/g,''))}\nfunction rd(r){return RC[r]||'#9CA3AF'}\nfunction allIds(){var a=[];UAT.sections.forEach(function(s){s.scenarios.forEach(function(sc){sc.steps.forEach(function(st){a.push(st.id)})})});return a}\nfunction scStats(sc,state){var c={Pass:0,Fail:0,Blocked:0,NA:0,Pending:0};sc.steps.forEach(function(st){var s=state[st.id]?state[st.id].status:'Pending';c[s]=(c[s]||0)+1});return c}\nfunction esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}\nfunction ringOffset(pct,circ){return circ-(pct/100*circ)}\nfunction ringClass(s){return s.Fail>0?'fail':s.Blocked>0?'part':s.Pass+s.NA>0?'prog':''}\nfunction bigRingSVG(id,pct,cls){\n  var off=ringOffset(pct,81.7);\n  return '<svg class=\"sc-ring'+(cls?' '+cls:'')+'\" viewBox=\"0 0 36 36\" id=\"rsvg-'+id+'\">'+\n    '<circle class=\"track\" cx=\"18\" cy=\"18\" r=\"13\"/>'+\n    '<circle class=\"fill\" cx=\"18\" cy=\"18\" r=\"13\" transform=\"rotate(-90 18 18)\" id=\"rfill-'+id+'\" style=\"stroke-dashoffset:'+off.toFixed(1)+'\"/>'+\n    '<text class=\"sc-ring-pct\" x=\"18\" y=\"21\" text-anchor=\"middle\" id=\"rpct-'+id+'\">'+pct+'%</text>'+\n    '</svg>';\n}\nfunction smallRingSVG(id,pct,cls){\n  var off=ringOffset(pct,50.3);\n  return '<svg class=\"sb-ring'+(cls?' '+cls:'')+'\" viewBox=\"0 0 20 20\" id=\"srsvg-'+id+'\">'+\n    '<circle class=\"track\" cx=\"10\" cy=\"10\" r=\"8\"/>'+\n    '<circle class=\"fill\" cx=\"10\" cy=\"10\" r=\"8\" transform=\"rotate(-90 10 10)\" id=\"srfill-'+id+'\" style=\"stroke-dashoffset:'+off.toFixed(1)+'\"/>'+\n    '</svg>';\n}\nfunction updateRing(scId,state){\n  var sc=SC_MAP[scId];if(!sc)return;\n  var s=scStats(sc,state),t=sc.steps.length,p=s.Pass+s.NA;\n  var pct=t?Math.round(p/t*100):0;\n  var cls=ringClass(s);\n  // big ring in header\n  var fill=document.getElementById('rfill-'+scId);\n  var ptxt=document.getElementById('rpct-'+scId);\n  var rsvg=document.getElementById('rsvg-'+scId);\n  if(fill){fill.style.strokeDashoffset=ringOffset(pct,81.7).toFixed(1)}\n  if(ptxt){ptxt.textContent=pct+'%'}\n  if(rsvg){rsvg.className.baseVal='sc-ring'+(cls?' '+cls:'')}\n  // small ring in sidebar\n  var sfill=document.getElementById('srfill-'+scId);\n  var srsvg=document.getElementById('srsvg-'+scId);\n  if(sfill){sfill.style.strokeDashoffset=ringOffset(pct,50.3).toFixed(1)}\n  if(srsvg){srsvg.className.baseVal='sb-ring'+(cls?' '+cls:'')}\n}\nfunction updateAll(state){\n  var all=allIds(),done=all.filter(function(id){return state[id]&&state[id].status!=='Pending'}).length;\n  var pct=all.length?Math.round(done/all.length*100):0;\n  var pf=document.getElementById('pf'),pl=document.getElementById('pl');\n  if(pf)pf.style.width=pct+'%';\n  if(pl)pl.textContent=done+' / '+all.length+' steps';\n  var c={Pass:0,Fail:0,Blocked:0,NA:0,Pending:0};\n  all.forEach(function(id){var s=state[id]?state[id].status:'Pending';c[s]=(c[s]||0)+1});\n  var sb=document.getElementById('stats');\n  if(sb)sb.innerHTML=\n    '<div class=\"stat-tile pass\"><div class=\"stat-n\">'+c.Pass+'</div><div class=\"stat-l\">Pass</div></div>'+\n    '<div class=\"stat-tile fail\"><div class=\"stat-n\">'+c.Fail+'</div><div class=\"stat-l\">Fail</div></div>'+\n    '<div class=\"stat-tile blk\"><div class=\"stat-n\">'+c.Blocked+'</div><div class=\"stat-l\">Blocked</div></div>'+\n    '<div class=\"stat-tile na\"><div class=\"stat-n\">'+c.NA+'</div><div class=\"stat-l\">N A</div></div>'+\n    '<div class=\"stat-tile pend\"><div class=\"stat-n\">'+c.Pending+'</div><div class=\"stat-l\">To Test</div></div>';\n  SC_IDS.forEach(function(id){updateRing(id,state)});\n}\nfunction setStep(stepId,status,state){\n  if(!state[stepId])state[stepId]={};\n  state[stepId].status=status;\n  var row=document.getElementById('r-'+stepId);\n  if(row)row.className='s-row st-'+status;\n  document.querySelectorAll('[data-sid=\"'+stepId+'\"]').forEach(function(b){b.classList.toggle('on',b.dataset.sv===status)});\n  var cmt=document.getElementById('cm-'+stepId);\n  if(cmt)cmt.classList.toggle('show',status==='Fail'||status==='Blocked');\n  saveSt(state);updateAll(state);\n}\nfunction openScenario(id){\n  SC_IDS.forEach(function(sid){\n    var card=document.getElementById('c-'+sid);\n    if(!card)return;\n    if(sid===id){card.classList.add('open')}\n    else{card.classList.remove('open')}\n  });\n  OPEN_ID=id;\n  // sync sidebar active\n  document.querySelectorAll('.sb-item').forEach(function(x){x.classList.toggle('active',x.dataset.sc===id)});\n  // scroll card into view\n  var card=document.getElementById('c-'+id);\n  if(card){setTimeout(function(){card.scrollIntoView({behavior:'smooth',block:'start'})},50)}\n}\nfunction navigate(dir){\n  var idx=SC_IDS.indexOf(OPEN_ID);\n  if(idx===-1)return;\n  var next=idx+dir;\n  if(next<0||next>=SC_IDS.length)return;\n  openScenario(SC_IDS[next]);\n}\ndocument.addEventListener('click',function(e){\n  // status buttons\n  var btn=e.target.closest('.s-btn');\n  if(btn){var sid=btn.dataset.sid,sv=btn.dataset.sv;if(!sid||!sv)return;\n    var st=loadSt(),cur=st[sid]?st[sid].status:'Pending';\n    setStep(sid,cur===sv?'Pending':sv,st);return}\n  // scenario header toggle (accordion)\n  var head=e.target.closest('.sc-head');\n  if(head){\n    var card=head.closest('.sc-card');\n    if(!card)return;\n    var id=card.id.replace('c-','');\n    if(OPEN_ID===id){\n      // clicking open header collapses it\n      card.classList.remove('open');OPEN_ID=null;\n      document.querySelectorAll('.sb-item').forEach(function(x){x.classList.remove('active')});\n    } else {openScenario(id)}\n    return}\n  // sidebar item\n  var sbi=e.target.closest('.sb-item');\n  if(sbi){openScenario(sbi.dataset.sc);return}\n  // nav prev/next\n  var nb=e.target.closest('[data-nav]');\n  if(nb){navigate(parseInt(nb.dataset.nav,10));return}\n});\ndocument.addEventListener('input',function(e){\n  if(!e.target.classList.contains('s-cmt'))return;\n  var id=e.target.dataset.cid;if(!id)return;\n  var st=loadSt();if(!st[id])st[id]={status:'Pending'};st[id].comment=e.target.value;saveSt(st);\n});\nfunction resetAll(){if(!confirm('Reset all test results?'))return;localStorage.removeItem(SK);location.reload()}\nfunction printReport(){window.print()}\nfunction showSummary(){\n  var state=loadSt(),html='';\n  UAT.sections.forEach(function(sec){\n    html+='<div class=\"ex-sec\"><div class=\"ex-sec-t\">'+sec.title+'</div>';\n    sec.scenarios.forEach(function(sc){\n      var s=scStats(sc,state),t=sc.steps.length,p=s.Pass+s.NA;\n      var ov=s.Fail>0?'Fail':s.Blocked>0?'Blocked':p===t&&t>0?'Pass':'Pending';\n      html+='<div class=\"ex-row\"><span><strong>'+sc.id+'</strong> '+sc.title+'</span><span class=\"ex-st '+ov+'\">'+ov+'</span></div>';\n    });\n    html+='</div>';\n  });\n  var issues=[];\n  UAT.sections.forEach(function(sec){sec.scenarios.forEach(function(sc){sc.steps.forEach(function(st){\n    if(state[st.id]&&(state[st.id].status==='Fail'||state[st.id].status==='Blocked'))\n      issues.push({sc:sc.id,st:st,status:state[st.id].status,comment:state[st.id].comment||''});\n  })})});\n  if(issues.length){\n    html+='<div class=\"ex-sec\"><div class=\"ex-sec-t\">Issues · '+issues.length+' requiring attention</div>';\n    issues.forEach(function(f){\n      html+='<div class=\"ex-row\" style=\"flex-direction:column;align-items:flex-start;gap:5px\">'+\n        '<div style=\"display:flex;justify-content:space-between;width:100%\"><strong>'+f.sc+' – Step '+f.st.num+'</strong><span class=\"ex-st '+f.status+'\">'+f.status+'</span></div>'+\n        '<div style=\"font-size:11.5px;color:var(--ink-3)\">'+esc(f.st.action)+'</div>'+\n        (f.comment?'<div style=\"font-size:11px;color:var(--blk);background:var(--blk-bg);padding:4px 10px;border-radius:4px;width:100%;border:1px solid var(--blk-bd)\">'+esc(f.comment)+'</div>':'')+\n      '</div>';\n    });\n    html+='</div>';\n  }\n  document.getElementById('mb').innerHTML=html;\n  document.getElementById('mo').classList.add('show');\n}\nfunction closeSummary(){document.getElementById('mo').classList.remove('show')}\nfunction buildSidebar(){\n  var html='';\n  UAT.sections.forEach(function(sec){\n    html+='<div><div class=\"sb-sec\">'+sec.title+'</div>';\n    sec.scenarios.forEach(function(sc){\n      html+='<div class=\"sb-item\" id=\"si-'+sc.id+'\" data-sc=\"'+sc.id+'\">'+\n        '<span class=\"sb-id\">'+sc.id+'</span>'+\n        '<span class=\"sb-title\">'+sc.title+'</span>'+\n        smallRingSVG(sc.id,0,'')+\n        '</div>';\n    });\n    html+='</div>';\n  });\n  document.getElementById('sb').innerHTML=html;\n}\nfunction buildMain(){\n  var state=loadSt();\n  // build page header + stats placeholder\n  var hdr='<div class=\"pg-hdr\"><div class=\"pg-eye\">EX3 Consulting</div><div class=\"pg-title\">SAP SuccessFactors Recruiting</div><div class=\"pg-sub\">End-to-end UAT test script — Recruiter lifecycle</div></div>'+\n    '<div class=\"stats-row\" id=\"stats\"></div>';\n  var cards='';\n  var secIds=[];\n  UAT.sections.forEach(function(sec){\n    cards+='<div class=\"sec-lbl\">'+sec.title+'</div>';\n    sec.scenarios.forEach(function(sc,si){\n      secIds.push(sc.id);\n      var rcls=rp(sc.role);\n      var s=scStats(sc,state),t=sc.steps.length,p=s.Pass+s.NA;\n      var pct=t?Math.round(p/t*100):0;\n      var cls=ringClass(s);\n      var scIdx=SC_IDS.indexOf(sc.id);\n      var prevId=scIdx>0?SC_IDS[scIdx-1]:null;\n      var nextId=scIdx<SC_IDS.length-1?SC_IDS[scIdx+1]:null;\n      cards+='<div class=\"sc-card\" id=\"c-'+sc.id+'\">'+\n        '<div class=\"sc-head\">'+\n          '<span class=\"sc-id\">'+sc.id+'</span>'+\n          '<span class=\"sc-title\">'+sc.title+'</span>'+\n          '<span class=\"sc-role '+rcls+'\">'+sc.role+'</span>'+\n          bigRingSVG(sc.id,pct,cls)+\n          '<span class=\"chevron\">&#9660;</span>'+\n        '</div>'+\n        '<div class=\"sc-body\"><table class=\"steps-tbl\">';\n      sc.steps.forEach(function(st){\n        var ss=state[st.id]||{},status=ss.status||'Pending',comment=ss.comment||'';\n        var cv=status==='Fail'||status==='Blocked'?' show':'';\n        var srcls=rp(st.role);\n        cards+='<tr class=\"s-row st-'+status+'\" id=\"r-'+st.id+'\">'+\n          '<td class=\"s-num\">'+st.num+'</td>'+\n          '<td class=\"s-dot-c\"><div class=\"s-dot\" style=\"background:'+rd(st.role)+'\"></div></td>'+\n          '<td class=\"s-content\">'+\n            '<div class=\"s-action\">'+esc(st.action)+'</div>'+\n            '<div class=\"s-meta\">';\n        if(st.input&&st.input!=='—'){\n          cards+='<div class=\"s-mb\"><div class=\"s-ml\">Input / Test Data</div><div class=\"s-mv\">'+esc(st.input)+'</div></div>';\n        }\n        cards+='<div class=\"s-mb\"><div class=\"s-ml\">Expected Result</div><div class=\"s-mv\">'+esc(st.expected)+'</div></div>'+\n          '<div class=\"s-mb\"><div class=\"s-ml\">Role</div><span class=\"s-rb '+srcls+'\">'+st.role+'</span></div>'+\n          '</div></td>'+\n          '<td class=\"s-acts\">'+\n          '<div class=\"s-btns\">'+\n          '<button class=\"s-btn pass'+(status==='Pass'?' on':'')+'\" data-sid=\"'+st.id+'\" data-sv=\"Pass\">✓ Pass</button>'+\n          '<button class=\"s-btn fail'+(status==='Fail'?' on':'')+'\" data-sid=\"'+st.id+'\" data-sv=\"Fail\">✗ Fail</button>'+\n          '<button class=\"s-btn blk'+(status==='Blocked'?' on':'')+'\" data-sid=\"'+st.id+'\" data-sv=\"Blocked\">⦸ Blk</button>'+\n          '<button class=\"s-btn na'+(status==='NA'?' on':'')+'\" data-sid=\"'+st.id+'\" data-sv=\"NA\">— N/A</button>'+\n          '</div>'+\n          '<textarea class=\"s-cmt'+cv+'\" id=\"cm-'+st.id+'\" data-cid=\"'+st.id+'\" placeholder=\"Comment…\">'+esc(comment)+'</textarea>'+\n          '</td></tr>';\n      });\n      // scenario navigation footer\n      var s_total=sc.steps.length;\n      var s_done=sc.steps.filter(function(st){return state[st.id]&&state[st.id].status!=='Pending'}).length;\n      cards+='</table>'+\n        '<div class=\"sc-nav\">'+\n          '<span class=\"sc-nav-info\">'+s_done+' / '+s_total+' steps tested</span>'+\n          '<div class=\"sc-nav-btns\">'+\n            (prevId?'<button class=\"nav-btn\" data-nav=\"-1\">← Previous</button>':'<button class=\"nav-btn\" disabled>← Previous</button>')+\n            (nextId?'<button class=\"nav-btn next\" data-nav=\"1\">Next →</button>':'<button class=\"nav-btn next\" disabled>Next →</button>')+\n          '</div>'+\n        '</div>'+\n        '</div></div>';\n    });\n  });\n  document.getElementById('main').innerHTML=hdr+cards;\n  updateAll(state);\n  // reopen the previously open scenario if any, else open first\n  var toOpen=OPEN_ID&&SC_IDS.indexOf(OPEN_ID)!==-1?OPEN_ID:SC_IDS[0];\n  if(toOpen){\n    var c=document.getElementById('c-'+toOpen);\n    if(c){c.classList.add('open');OPEN_ID=toOpen;\n      document.querySelectorAll('.sb-item').forEach(function(x){x.classList.toggle('active',x.dataset.sc===toOpen)});\n    }\n  }\n}\nbuildSidebar();\nbuildMain();";
  const H = (s) => s;
  return H('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n'+
    '<title>UAT Test Scripts \u2014 SAP SF Recruiting<\/title>\n'+
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'+
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">\n'+
    '<style>\n') + _css + H('\n<\/style>\n<\/head>\n<body>\n'+
    '<div class="topbar">\n'+
    '  <div class="tb-brand"><div class="tb-mark"><svg viewBox="0 0 12 12"><rect x="1" y="1" width="4" height="4" rx="1"/><rect x="7" y="1" width="4" height="4" rx="1"/><rect x="1" y="7" width="4" height="4" rx="1"/><rect x="7" y="7" width="4" height="4" rx="1"/><\/svg><\/div><div class="tb-label">UAT Test Scripts<\/div><\/div>\n'+
    '  <div class="tb-center"><div class="tb-sep"><\/div><div class="tb-page">SAP SuccessFactors Recruiting<\/div><div class="tb-sep"><\/div><div class="prog-track"><div class="prog-fill" id="pf"><\/div><\/div><div class="prog-lbl" id="pl"><\/div><\/div>\n'+
    '  <div class="tb-right"><button class="tbtn" onclick="printReport()">&#128438; Export PDF<\/button><button class="tbtn" onclick="resetAll()">Reset All<\/button><button class="tbtn primary" onclick="showSummary()">View Summary<\/button><\/div>\n'+
    '<\/div>\n'+
    '<div class="layout">\n'+
    '  <div class="sidebar" id="sb"><\/div>\n'+
    '  <div class="main" id="main"><\/div>\n'+
    '<\/div>\n'+
    '<div class="mo" id="mo" onclick="if(event.target===this)closeSummary()">\n'+
    '  <div class="mo-box"><div class="mo-hdr"><div class="mo-title">Test Run Summary<\/div><button class="mo-x" onclick="closeSummary()">&times;<\/button><\/div><div id="mb"><\/div><button class="mo-close" onclick="closeSummary()">Close<\/button><\/div>\n'+
    '<\/div>\n'+
    '<div class="ai-float" id="aiFloat">'+
    '<button class="ai-fab" id="aiToggle" onclick="toggleAI()" aria-label="Ask EX3">EX3<\/button>'+
    '<div class="ai-panel" id="aiPanel">'+
    '<div class="ai-ph"><span class="ai-pt">Ask EX3<\/span><button class="ai-px" onclick="toggleAI()" aria-label="Close">&times;<\/button><\/div>'+
    '<div class="ai-body">'+
    '<div class="ai-resp" id="aiResp">Ask EX3 anything about SAP SuccessFactors Recruiting.<\/div>'+
    '<div id="aiDyn"><\/div>'+
    '<div id="aiPrompts">'+
    '<button class="ai-prompt" onclick="runAI(\'How do I post a job?\')"><span class="ai-pi">1<\/span>How do I post a job?<\/button>'+
    '<button class="ai-prompt" onclick="runAI(\'How do I move a candidate to the next stage?\')"><span class="ai-pi">2<\/span>Moving candidates through stages<\/button>'+
    '<button class="ai-prompt" onclick="runAI(\'What should I check before go-live?\')"><span class="ai-pi">3<\/span>Go-live checklist<\/button>'+
    '<\/div>'+
    '<div class="ai-field">'+
    '<input class="ai-input" id="aiQuery" placeholder="Ask a question\u2026" onkeydown="if(event.key===\'Enter\'){event.preventDefault();submitAI()}">'+
    '<button class="ai-send" onclick="submitAI()">Ask<\/button>'+
    '<\/div>'+
    '<\/div><\/div><\/div>\n'+
    '<script>\nvar UAT=') + JSON.stringify(_data) + H(';\n') + _js + H('\n' +
'var _aiThread=null;\n' +
'function toggleAI(){document.getElementById("aiPanel").classList.toggle("open");document.getElementById("aiToggle").classList.toggle("open");}\n' +
'function submitAI(){var q=document.getElementById("aiQuery").value.trim();if(!q)return;runAI(q);}\n' +
'function runAI(q){document.getElementById("aiQuery").value=q;askAI(q);}\n' +
'async function askAI(q){\n' +
'  var resp=document.getElementById("aiResp"),dyn=document.getElementById("aiDyn");\n' +
'  resp.innerHTML=\'<em style="opacity:.6">Thinking\u2026</em>\';\n' +
'  dyn.innerHTML="";\n' +
'  document.getElementById("aiPrompts").style.display="none";\n' +
'  try{\n' +
'    var r=await fetch("/api/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:q,threadId:_aiThread})});\n' +
'    if(!r.ok)throw new Error("unavailable");\n' +
'    var data=await r.json();\n' +
'    if(!data.answer)throw new Error("no answer");\n' +
'    _aiThread=data.threadId;\n' +
'    resp.innerHTML=data.answer.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\n/g,"<br>");\n' +
'    var nc=document.createElement("button");nc.className="ai-new-chat";nc.textContent="New conversation";nc.onclick=function(){_aiThread=null;resp.innerHTML="Ask EX3 anything about SAP SuccessFactors Recruiting.";dyn.innerHTML="";document.getElementById("aiQuery").value=""};dyn.appendChild(nc);\n' +
'    if(data.followUps&&data.followUps.length){\n' +
'      var fu=document.createElement("div");fu.className="ai-fu";\n' +
'      fu.innerHTML=\'<div class="ai-fu-lbl">You might also ask</div>\';\n' +
'      data.followUps.forEach(function(fq){var b=document.createElement("button");b.className="ai-fub";b.textContent=fq;b.onclick=function(){document.getElementById("aiQuery").value=fq;askAI(fq)};fu.appendChild(b)});\n' +
'      dyn.appendChild(fu);\n' +
'    }\n' +
'  }catch(e){resp.innerHTML="Sorry, EX3 could not connect. Please try again.";}\n' +
'}\n' +
'\nvar RECORDINGS={\n' +
'"RCM-RC-101":"/tests/recordings/tests-sf-create-position-R-292cb-ition-Copy-from-Louie-Bond-/video.webm"\n' +
'};\n' +
'(function(){\n' +
'  var style=document.createElement("style");\n' +
'  style.textContent=".rec-btn{background:#1A3A7A!important;color:#fff!important;border-color:#1A3A7A!important;}.rec-btn:hover{opacity:.85!important;} #recMo{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;align-items:center;justify-content:center;} #recMo.show{display:flex;} #recMoBox{background:#000;border-radius:12px;overflow:hidden;max-width:90vw;max-height:90vh;position:relative;} #recMoClose{position:absolute;top:10px;right:14px;background:none;border:none;color:#fff;font-size:24px;cursor:pointer;z-index:1;}";\n' +
'  document.head.appendChild(style);\n' +
'  var mo=document.createElement("div");mo.id="recMo";\n' +
'  mo.innerHTML=\'<div id="recMoBox"><button id="recMoClose" onclick="document.getElementById(\\\'recMo\\\').classList.remove(\\\'show\\\');document.getElementById(\\\'recVid\\\').pause();">&times;</button><video id="recVid" controls style="display:block;max-width:90vw;max-height:85vh;"></video></div>\';\n' +
'  mo.onclick=function(e){if(e.target===mo){mo.classList.remove("show");document.getElementById("recVid").pause();}};\n' +
'  document.body.appendChild(mo);\n' +
'  Object.keys(RECORDINGS).forEach(function(scId){\n' +
'    var card=document.getElementById("c-"+scId);\n' +
'    if(!card)return;\n' +
'    var nav=card.querySelector(".sc-nav-btns");\n' +
'    if(!nav)return;\n' +
'    var btn=document.createElement("button");\n' +
'    btn.className="nav-btn rec-btn";\n' +
'    btn.innerHTML="&#9654; Recording";\n' +
'    btn.onclick=function(e){e.stopPropagation();document.getElementById("recVid").src=RECORDINGS[scId];document.getElementById("recMo").classList.add("show");document.getElementById("recVid").play();};\n' +
'    nav.insertBefore(btn,nav.firstChild);\n' +
'  });\n' +
'})();\n' +
'\n<\/script>\n<\/body>\n<\/html>');
}


// Demo presenter mode &mdash; automated split-screen product demo
app.get('/demo', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SAP SuccessFactors Recruiting \u2014 Live Demo</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{font-family:'Sora',sans-serif;background:#060606;color:#fff}

/* â”€â”€â”€â”€â”€â”€ START SCREEN â”€â”€â”€â”€â”€â”€ */
#start-screen{
  position:fixed;inset:0;z-index:300;
  background:#060606;
  display:flex;align-items:center;justify-content:center;flex-direction:column;
  transition:opacity .6s ease;
}
#start-screen.fade{opacity:0;pointer-events:none}
.ss-logo{font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#2a2a2a;margin-bottom:52px}
.ss-logo em{color:#22c55e;font-style:normal}
.ss-head{font-size:clamp(34px,5.5vw,64px);font-weight:800;letter-spacing:-.04em;text-align:center;line-height:1.05;max-width:680px}
.ss-head em{color:#22c55e;font-style:normal;font-weight:800}
.ss-sub{margin-top:22px;font-size:15px;color:#555;text-align:center;max-width:400px;line-height:1.8}
.ss-pills{display:flex;gap:10px;margin-top:36px;flex-wrap:wrap;justify-content:center}
.ss-pill{padding:7px 15px;border:1px solid #1a1a1a;border-radius:100px;font-size:12px;color:#666;background:#0d0d0d;white-space:nowrap}
.ss-btn{
  margin-top:48px;
  padding:17px 56px;background:#22c55e;color:#000;
  font-family:inherit;font-size:15px;font-weight:800;
  border:none;border-radius:14px;cursor:pointer;
  letter-spacing:-.01em;
  display:flex;align-items:center;gap:10px;
  transition:opacity .15s,transform .15s;
}
.ss-btn:hover{opacity:.9;transform:translateY(-2px)}
.ss-note{margin-top:18px;font-size:11px;color:#2a2a2a}
/* Ambient glow */
#start-screen{overflow:hidden}
#start-screen::before{content:'';position:absolute;width:800px;height:800px;background:radial-gradient(circle,rgba(34,197,94,.08) 0%,transparent 65%);animation:ss-glow 5s ease-in-out infinite;pointer-events:none;z-index:0}
@keyframes ss-glow{0%,100%{transform:scale(1) translate(-10%,10%);opacity:.5}50%{transform:scale(1.25) translate(-10%,10%);opacity:1}}
#start-screen>*{position:relative;z-index:1}
/* Stat counters */
.ss-stats{display:flex;gap:52px;margin-top:44px}
.ss-stat{text-align:center}
.ss-stat-n{display:block;font-size:46px;font-weight:800;letter-spacing:-.04em;color:#22c55e;font-variant-numeric:tabular-nums;line-height:1}
.ss-stat-l{display:block;font-size:11px;color:#333;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-top:6px}
/* CTA wrap with pulse rings */
.ss-cta-wrap{position:relative;margin-top:44px;display:inline-block}
.ss-ring{position:absolute;inset:-10px;border-radius:24px;border:1.5px solid rgba(34,197,94,.3);animation:ss-ring-p 2.5s ease-in-out infinite;pointer-events:none}
.ss-ring2{position:absolute;inset:-20px;border-radius:30px;border:1px solid rgba(34,197,94,.12);animation:ss-ring-p 2.5s ease-in-out infinite .7s;pointer-events:none}
@keyframes ss-ring-p{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.9;transform:scale(1.025)}}
.ss-btn{margin:0}
/* Auto-advance ring */
#auto-ring{width:38px;height:38px;flex-shrink:0;cursor:pointer;display:none;position:relative;align-self:center}
#auto-ring.show{display:block}
#auto-ring-n{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#22c55e;font-family:inherit}
/* Frame crossfade */
#frame-fade{position:absolute;inset:0;background:#0a0a0a;z-index:8;opacity:0;pointer-events:none;transition:opacity .22s ease}
#frame-fade.in{opacity:1}

/* â”€â”€â”€â”€â”€â”€ DEMO SHELL â”€â”€â”€â”€â”€â”€ */
#demo{display:flex;flex-direction:column;height:100vh;opacity:0;transition:opacity .5s}
#demo.show{opacity:1}

/* Top bar */
.topbar{
  height:48px;flex-shrink:0;
  display:flex;align-items:center;justify-content:space-between;padding:0 18px;
  background:#0a0a0a;border-bottom:1px solid #111;
}
.tb-logo{font-size:13px;font-weight:700;letter-spacing:.04em}
.tb-logo em{color:#22c55e;font-style:normal}
.tb-step-label{font-size:11px;color:#333;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.tb-ctrl{display:flex;align-items:center;gap:6px}
.cbtn{
  width:30px;height:30px;border-radius:7px;border:1px solid #1e1e1e;background:#111;
  color:#666;font-size:13px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all .15s;font-family:inherit;flex-shrink:0;
}
.cbtn:hover{color:#fff;border-color:#2e2e2e;background:#181818}
.cbtn.on{background:#22c55e;color:#000;border-color:#22c55e}
.cbtn.muted{background:#ef4444;color:#fff;border-color:#ef4444}

/* Progress strip */
.prog-strip{height:2px;flex-shrink:0;background:#0f0f0f}
.prog-fill{height:100%;background:linear-gradient(90deg,#16a34a,#22c55e);transition:width .6s ease;width:0%}

/* Dots */
.dots-row{
  height:34px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;gap:5px;
  background:#080808;border-bottom:1px solid #0f0f0f;
}
.dot{width:6px;height:6px;border-radius:3px;background:#161616;transition:all .4s ease;cursor:pointer}
.dot:hover{background:#2e2e2e}
.dot.done{background:#166534;width:10px;border-radius:4px}
.dot.cur{background:#22c55e;width:22px;border-radius:4px}

/* Frame area */
.frame-area{flex:1;position:relative;overflow:hidden;min-height:0}
iframe{width:100%;height:100%;border:none;display:block;background:#f8f7f4}
.ph{
  position:absolute;inset:0;display:none;
  align-items:center;justify-content:center;flex-direction:column;gap:18px;
  background:#0a0a0a;
}
.ph-icon{font-size:52px}
.ph-title{font-size:22px;font-weight:800;letter-spacing:-.03em}
.ph-body{font-size:13px;color:#555;max-width:380px;text-align:center;line-height:1.8}
.ph-cta{display:inline-block;margin-top:6px;padding:11px 24px;background:#22c55e;color:#000;border-radius:10px;font-weight:700;font-size:13px;text-decoration:none;transition:opacity .15s}
.ph-cta:hover{opacity:.88}

/* Fake WhatsApp demo */
.wa-shell{display:none;width:100%;height:100%;flex-direction:column;background:#e5ddd5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;overflow:hidden}
.wa-shell.active{display:flex}
.wa-header-wa{background:#075e54;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.wa-avatar{width:38px;height:38px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.wa-hname{font-weight:700;font-size:14px;line-height:1.3}
.wa-hsub{font-size:11px;opacity:.75}
.wa-msgs{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:7px;min-height:0}
.wa-bubble{max-width:72%;padding:7px 10px 22px 10px;border-radius:8px;font-size:13px;line-height:1.55;position:relative;word-break:break-word;white-space:pre-line;opacity:0;transform:translateY(8px);transition:opacity .3s,transform .3s}
.wa-bubble.show{opacity:1;transform:translateY(0)}
.wa-bubble.them{background:#fff;align-self:flex-start;border-top-left-radius:0;color:#111}
.wa-bubble.me{background:#dcf8c6;align-self:flex-end;border-top-right-radius:0;color:#111}
.wa-time{position:absolute;bottom:4px;right:8px;font-size:10px;color:#999}
.wa-tick{margin-left:2px;color:#4fc3f7}
.wa-typing-row{padding:4px 10px;flex-shrink:0}
.wa-typing-bubble{display:none;background:#fff;border-radius:8px;border-top-left-radius:0;padding:9px 14px;width:fit-content;align-items:center;gap:4px}
.wa-typing-bubble.show{display:flex}
.wa-dot-t{width:7px;height:7px;border-radius:50%;background:#bbb;animation:wa-bounce .9s infinite ease-in-out}
.wa-dot-t:nth-child(2){animation-delay:.2s}
.wa-dot-t:nth-child(3){animation-delay:.4s}
@keyframes wa-bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}

/* Callout overlay */
#callout-layer{position:absolute;inset:0;pointer-events:none;z-index:10}
.callout-bubble{
  position:absolute;
  background:rgba(10,10,10,.92);
  backdrop-filter:blur(12px);
  border:1px solid rgba(34,197,94,.35);
  border-left:3px solid #22c55e;
  border-radius:10px;
  padding:10px 14px;
  font-size:12px;font-weight:600;color:#d4d4d4;
  line-height:1.5;max-width:220px;
  box-shadow:0 4px 24px rgba(0,0,0,.6),0 0 20px rgba(34,197,94,.1);
  opacity:0;transform:translateY(6px);
  transition:opacity .4s ease,transform .4s ease;
  pointer-events:none;
}
.callout-bubble.show{opacity:1;transform:translateY(0)}
.callout-bubble strong{color:#22c55e;display:block;font-size:11px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
.callout-dot{
  position:absolute;
  width:14px;height:14px;border-radius:50%;
  background:#22c55e;
  box-shadow:0 0 0 0 rgba(34,197,94,.5);
  animation:ring 2s ease-in-out infinite;
  transform:translate(-50%,-50%);
  pointer-events:none;
  opacity:0;transition:opacity .4s;
}
.callout-dot.show{opacity:1}
@keyframes ring{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 14px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}

/* Step title pill (floats over iframe) */
#step-pill{
  position:absolute;top:14px;left:50%;transform:translateX(-50%) translateY(-8px);
  background:rgba(8,8,8,.9);backdrop-filter:blur(10px);
  border:1px solid #1e1e1e;border-radius:100px;
  padding:7px 18px;
  display:flex;align-items:center;gap:8px;
  font-size:12px;font-weight:700;white-space:nowrap;
  z-index:20;pointer-events:none;
  opacity:0;transition:opacity .4s,transform .4s;
}
#step-pill.show{opacity:1;transform:translateX(-50%) translateY(0)}
#pill-icon{font-size:16px}

/* â”€â”€â”€â”€â”€â”€ NARRATOR PANEL â”€â”€â”€â”€â”€â”€ */
.narrator{
  flex-shrink:0;
  background:#0a0a0a;border-top:1px solid #111;
  padding:14px 18px 12px;
}
.nar-inner{display:flex;align-items:flex-start;gap:12px;max-width:1000px;margin:0 auto}
.nar-mic{
  width:34px;height:34px;flex-shrink:0;margin-top:1px;
  border-radius:50%;background:#111;border:1px solid #1e1e1e;
  display:flex;align-items:center;justify-content:center;
}
.bars{display:flex;align-items:center;gap:2.5px;height:16px}
.bar{width:3px;border-radius:2px;background:#333;transition:background .3s,height .15s}
.bar:nth-child(1){height:4px}.bar:nth-child(2){height:10px}.bar:nth-child(3){height:7px}.bar:nth-child(4){height:12px}.bar:nth-child(5){height:5px}.bar:nth-child(6){height:8px}
@keyframes b1{0%,100%{height:4px}50%{height:13px}}
@keyframes b2{0%,100%{height:10px}50%{height:4px}}
@keyframes b3{0%,100%{height:7px}50%{height:15px}}
@keyframes b4{0%,100%{height:12px}50%{height:3px}}
@keyframes b5{0%,100%{height:5px}50%{height:12px}}
@keyframes b6{0%,100%{height:8px}50%{height:4px}}
.speaking .bar{background:#22c55e}
.speaking .bar:nth-child(1){animation:b1 .5s ease-in-out infinite}
.speaking .bar:nth-child(2){animation:b2 .5s ease-in-out infinite .08s}
.speaking .bar:nth-child(3){animation:b3 .5s ease-in-out infinite .16s}
.speaking .bar:nth-child(4){animation:b4 .5s ease-in-out infinite .04s}
.speaking .bar:nth-child(5){animation:b5 .5s ease-in-out infinite .12s}
.speaking .bar:nth-child(6){animation:b6 .5s ease-in-out infinite .2s}
.nar-text{flex:1;min-width:0}
.nar-words{font-size:13.5px;line-height:1.75;color:#444;min-height:46px;padding-right:4px}
.nar-words .w.past{color:#666}
.nar-words .w.now{color:#fff;font-weight:600}
.nar-words .w.future{color:#2a2a2a}
.nar-foot{display:flex;align-items:center;margin-top:8px;gap:10px}
.nar-tag{font-size:10px;font-weight:700;color:#22c55e;letter-spacing:.06em;text-transform:uppercase;flex-shrink:0}
.nar-pb{flex:1;height:2px;background:#141414;border-radius:1px}
.nar-pb-fill{height:100%;background:#22c55e;border-radius:1px;transition:width .3s linear;width:0%}
.nar-controls{display:flex;gap:8px;margin-top:10px}
.nar-btn{padding:9px 12px;border-radius:8px;border:1px solid #222;background:#101010;color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.nar-btn:hover{background:#171717;border-color:#2e2e2e}
.nar-btn.next{background:#22c55e;color:#000;border-color:#22c55e}
.nar-btn.next:hover{opacity:.92}
@keyframes pulse-next{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}50%{box-shadow:0 0 0 8px rgba(34,197,94,0)}}
.nar-btn.next.ready{animation:pulse-next 1.4s ease-in-out infinite;background:#16a34a}

/* Voice note bubble */
.wa-voice-note{display:flex;align-items:center;gap:8px;min-width:170px}
.wa-voice-play{width:34px;height:34px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.wa-waveform{flex:1;display:flex;align-items:center;gap:2px;height:22px}
.wa-wbar{border-radius:2px;background:rgba(0,0,0,.28);width:3px}
.wa-voice-dur{font-size:11px;color:#999;flex-shrink:0;margin-left:4px}

/* Chapter card panel */
.card-panel{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:#060606;overflow:hidden;z-index:5}
.card-panel.active{display:flex}
.card-panel::before{content:'';position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(34,197,94,.06) 0%,transparent 65%);pointer-events:none}
.card-chap{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#22c55e;margin-bottom:18px;opacity:0;transform:translateY(10px);transition:opacity .6s ease .1s,transform .6s ease .1s}
.card-panel.active .card-chap{opacity:1;transform:translateY(0)}
.card-headline{font-size:clamp(34px,5vw,64px);font-weight:800;letter-spacing:-.04em;line-height:1.07;text-align:center;max-width:600px;opacity:0;transform:translateY(20px);transition:opacity .6s ease .28s,transform .6s ease .28s}
.card-panel.active .card-headline{opacity:1;transform:translateY(0)}
.card-headline em{color:#22c55e;font-style:normal}

/* Recording scene */
#wa-recording-scene{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:#080808;z-index:6;transition:opacity .5s ease}
#wa-recording-scene.active{display:flex}
.rec-time{font-size:clamp(52px,9vw,86px);font-weight:800;letter-spacing:-.04em;color:#fff;line-height:1;font-variant-numeric:tabular-nums;opacity:0;transform:translateY(16px);transition:opacity .5s ease .05s,transform .5s ease .05s}
#wa-recording-scene.active .rec-time{opacity:1;transform:translateY(0)}
.rec-info{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#2a2a2a;margin-top:12px;opacity:0;transition:opacity .5s ease .22s}
#wa-recording-scene.active .rec-info{opacity:1}
.rec-row{display:flex;align-items:center;gap:12px;margin-top:30px;opacity:0;transition:opacity .5s ease .38s}
#wa-recording-scene.active .rec-row{opacity:1}
.rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:rec-pulse 1.2s ease-in-out infinite;flex-shrink:0}
@keyframes rec-pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.4)}70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.rec-wave{display:flex;align-items:center;gap:3px;height:30px}
.rec-wbar{width:3.5px;border-radius:2px;background:#22c55e;height:6px}
@keyframes rw1{0%,100%{height:5px}50%{height:22px}}
@keyframes rw2{0%,100%{height:10px}50%{height:26px}}
@keyframes rw3{0%,100%{height:16px}50%{height:7px}}
@keyframes rw4{0%,100%{height:22px}50%{height:5px}}
@keyframes rw5{0%,100%{height:7px}50%{height:24px}}
@keyframes rw6{0%,100%{height:18px}50%{height:6px}}
@keyframes rw7{0%,100%{height:12px}50%{height:28px}}
@keyframes rw8{0%,100%{height:5px}50%{height:18px}}
.rec-wbar:nth-child(1){animation:rw1 .65s ease-in-out infinite}
.rec-wbar:nth-child(2){animation:rw2 .65s ease-in-out infinite .09s}
.rec-wbar:nth-child(3){animation:rw3 .65s ease-in-out infinite .18s}
.rec-wbar:nth-child(4){animation:rw4 .65s ease-in-out infinite .05s}
.rec-wbar:nth-child(5){animation:rw5 .65s ease-in-out infinite .14s}
.rec-wbar:nth-child(6){animation:rw6 .65s ease-in-out infinite .22s}
.rec-wbar:nth-child(7){animation:rw7 .65s ease-in-out infinite .11s}
.rec-wbar:nth-child(8){animation:rw8 .65s ease-in-out infinite .07s}
.rec-label{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#333;margin-top:18px;opacity:0;transition:opacity .5s ease .48s}
#wa-recording-scene.active .rec-label{opacity:1}
#analytics-shell{display:none;width:100%;height:100%;flex-direction:column;background:#0d0f18;color:#e8eaf0;font-family:'Inter',system-ui,sans-serif;padding:20px 22px;box-sizing:border-box;overflow-y:auto;gap:14px}
#analytics-shell.active{display:flex}
.an-header{}
.an-title{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.02em}
.an-period{font-size:11px;color:#6b7280;margin-top:3px}
.an-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.an-kpi{background:#161925;border-radius:10px;padding:14px 14px 12px;border:1px solid #1e2235}
.an-knum{font-size:26px;font-weight:800;color:#818cf8;line-height:1;font-variant-numeric:tabular-nums}
.an-knum-suffix{font-size:16px;font-weight:700}
.an-klabel{font-size:10px;color:#6b7280;margin-top:5px;line-height:1.3}
.an-chart-section{background:#161925;border-radius:10px;padding:16px;border:1px solid #1e2235}
.an-chart-label{font-size:11px;color:#6b7280;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em}
.an-bars{display:flex;gap:6px;align-items:flex-end;height:72px}
.an-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:5px;height:100%}
.an-bar{width:100%;background:linear-gradient(180deg,#818cf8,#6366f1);border-radius:3px 3px 0 0;height:0;transition:height .9s cubic-bezier(.34,1.56,.64,1)}
.an-bar.grow{height:var(--h)}
.an-bday{font-size:9px;color:#4b5563}
.an-top-qs{background:#161925;border-radius:10px;padding:16px;border:1px solid #1e2235;flex:1}
.an-qs-label{font-size:11px;color:#6b7280;margin-bottom:10px;text-transform:uppercase;letter-spacing:.06em}
.an-q-row{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.an-q-fill{height:28px;background:#818cf8;opacity:.13;border-radius:4px;position:absolute;left:0;top:0;width:0;transition:width .7s ease}
.an-q-wrap{position:relative;flex:1;border-radius:4px;overflow:hidden}
.an-q-text{font-size:11px;color:#cbd5e1;padding:7px 8px;position:relative}
.an-q-count{font-size:12px;font-weight:700;color:#818cf8;min-width:26px;text-align:right}
</style>
</head>
<body>

<!-- â”€â”€ Start screen â”€â”€ -->
<div id="start-screen">
  <div class="ss-logo">EX3 <em>SAP SuccessFactors Recruiting</em></div>
  <h1 class="ss-head">Everything your team needs.<br><em>On day one.</em></h1>
  <p class="ss-sub">Training, AI assistant, WhatsApp bot, consultant portal, and SOW builder &mdash; the complete SAP SuccessFactors Recruiting implementation toolkit.</p>
  <div class="ss-stats">
    <div class="ss-stat"><span class="ss-stat-n" id="stat-features">50+</span><span class="ss-stat-l">Features</span></div>
    <div class="ss-stat"><span class="ss-stat-n" id="stat-roles">4</span><span class="ss-stat-l">Roles</span></div>
    <div class="ss-stat"><span class="ss-stat-n" id="stat-time">4</span><span class="ss-stat-l">Minutes</span></div>
  </div>
  <div class="ss-cta-wrap">
    <div class="ss-ring"></div><div class="ss-ring2"></div>
    <button class="ss-btn" onclick="beginDemo()">\u25B6&nbsp;&nbsp;Start Demo</button>
  </div>
  <p class="ss-note">Voice narration &nbsp;&middot;&nbsp; auto-advance &nbsp;&middot;&nbsp; no login required</p>
</div>

<!-- â”€â”€ Demo â”€â”€ -->
<div id="demo">
  <div class="topbar">
    <div class="tb-logo">EX3 <em>SAP SuccessFactors Recruiting</em></div>
    <div class="tb-step-label" id="tb-step">Step 1 of 13</div>
    <div class="tb-ctrl">
      <button class="cbtn" id="mute-btn" onclick="toggleMute()" title="Mute voice" style="font-size:10px;font-weight:800;letter-spacing:.04em">VOL</button>
      <button class="cbtn" id="pause-btn" onclick="togglePause()" title="Pause">\u23F8</button>
      <button class="cbtn" onclick="go(-1)" title="Previous">\u2190</button>
      <button class="cbtn" onclick="go(1)" title="Next">\u2192</button>
      <button class="cbtn" onclick="restartDemo()" title="Restart">\u21BA</button>
    </div>
  </div>
  <div class="prog-strip"><div class="prog-fill" id="prog-fill"></div></div>
  <div class="dots-row" id="dots-row"></div>
  <div class="frame-area" id="frame-area">
    <iframe id="liveFrame" src="/"></iframe>
    <div id="frame-fade"></div>
    <div class="ph" id="ph">
      <div class="ph-icon" id="ph-icon"></div>
      <div class="ph-title" id="ph-title"></div>
      <div class="ph-body" id="ph-body"></div>
      <a class="ph-cta" id="ph-cta" href="#" target="_blank" style="display:none"></a>
      <div class="wa-shell" id="wa-shell">
        <div class="wa-header-wa">
          <div class="wa-avatar" style="font-size:13px;font-weight:800;letter-spacing:-.02em">EX3</div>
          <div><div class="wa-hname">EX3 AI Assistant</div><div class="wa-hsub">WhatsApp Â· usually replies instantly</div></div>
        </div>
        <div class="wa-msgs" id="wa-msgs"></div>
        <div class="wa-typing-row">
          <div class="wa-typing-bubble" id="wa-typing">
            <div class="wa-dot-t"></div><div class="wa-dot-t"></div><div class="wa-dot-t"></div>
          </div>
        </div>
      </div>
    </div>
    <div id="analytics-shell">
      <div class="an-header">
        <div class="an-title">EX3 Analytics</div>
        <div class="an-period">Week 14 &middot; Apr 7&ndash;13 &middot; GlobalFirst Group</div>
      </div>
      <div class="an-kpis">
        <div class="an-kpi"><div class="an-knum" id="an-k1">0</div><div class="an-klabel">AI queries this week</div></div>
        <div class="an-kpi"><div class="an-knum" id="an-k2">0<span class="an-knum-suffix"> hrs</span></div><div class="an-klabel">saved per consultant</div></div>
        <div class="an-kpi"><div class="an-knum" id="an-k3">0<span class="an-knum-suffix">%</span></div><div class="an-klabel">questions answered</div></div>
        <div class="an-kpi"><div class="an-knum" id="an-k4">0</div><div class="an-klabel">active engagements</div></div>
      </div>
      <div class="an-chart-section">
        <div class="an-chart-label">Daily AI queries &mdash; Week 14</div>
        <div class="an-bars" id="an-bars">
          <div class="an-bar-col"><div class="an-bar" style="--h:62%"></div><div class="an-bday">Mon</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:78%"></div><div class="an-bday">Tue</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:55%"></div><div class="an-bday">Wed</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:88%"></div><div class="an-bday">Thu</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:71%"></div><div class="an-bday">Fri</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:23%"></div><div class="an-bday">Sat</div></div>
          <div class="an-bar-col"><div class="an-bar" style="--h:18%"></div><div class="an-bday">Sun</div></div>
        </div>
      </div>
      <div class="an-top-qs">
        <div class="an-qs-label">Top questions this week</div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:92%"></div><div class="an-q-text">How do I set up an offer letter template?</div></div><div class="an-q-count">38</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:74%"></div><div class="an-q-text">Send Offer button not appearing</div></div><div class="an-q-count">29</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:61%"></div><div class="an-q-text">How do I add workflow automation?</div></div><div class="an-q-count">24</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:46%"></div><div class="an-q-text">Candidate screening filter setup</div></div><div class="an-q-count">18</div></div>
        <div class="an-q-row"><div class="an-q-wrap"><div class="an-q-fill" style="--w:33%"></div><div class="an-q-text">GDPR compliance checklist</div></div><div class="an-q-count">13</div></div>
      </div>
    </div>
    <div class="card-panel" id="card-panel">
      <div class="card-chap" id="card-chap"></div>
      <div class="card-headline" id="card-headline"></div>
    </div>
    <div id="wa-recording-scene">
      <div class="rec-time">06:07</div>
      <div class="rec-info">En route to client site</div>
      <div class="rec-row">
        <div class="rec-dot"></div>
        <div class="rec-wave">
          <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
          <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
        </div>
      </div>
      <div class="rec-label">Recording</div>
    </div>
    <div id="callout-layer">
      <div class="callout-bubble" id="cbubble"></div>
      <div class="callout-dot" id="cdot"></div>
    </div>
    <div id="step-pill"><span id="pill-icon"></span><span id="pill-title"></span></div>
  </div>
  <div class="narrator">
    <div class="nar-inner">
      <div class="nar-mic"><div class="bars" id="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div></div>
      <div class="nar-text">
        <div class="nar-words" id="nar-words"></div>
        <div class="nar-foot">
          <span class="nar-tag" id="nar-tag"></span>
          <div class="nar-pb"><div class="nar-pb-fill" id="nar-pb-fill"></div></div>
        </div>
        <div class="nar-controls">
          <button class="nar-btn" onclick="go(-1)">\u2190 Prev Step</button>
          <button class="nar-btn" onclick="replayStep()">\u21BB Replay Step</button>
          <button class="nar-btn" onclick="retryAudio()">Retry Audio</button>
          <button class="nar-btn next" onclick="go(1)">Next Step \u2192</button>
        </div>
      </div>
      <div id="auto-ring" onclick="stopAutoAdvance();go(1)" title="Click to advance now">
        <svg viewBox="0 0 38 38" width="38" height="38">
          <circle cx="19" cy="19" r="16" fill="none" stroke="#1e1e1e" stroke-width="3"/>
          <circle id="auto-ring-fill" cx="19" cy="19" r="16" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-dasharray="100.5" stroke-dashoffset="100.5" transform="rotate(-90 19 19)"/>
        </svg>
        <div id="auto-ring-n"></div>
      </div>
    </div>
  </div>
</div>

<script>
// â”€â”€ Steps â”€â”€
var steps = [
  {
    icon:'', title:'The EX3 Platform', url:'/', auto:[],
    voice:"Meet Sarah. She runs SAP SuccessFactors Recruiting implementations for a Big Four consulting firm. New client just signed &mdash; a global enterprise, twelve thousand employees, going live in sixty days. She has a kickoff call in two hours. This is everything she uses.",
    callout:null
  },
  {
    icon:'', title:'Four Roles, One Platform', url:'/',
    auto:[
      {d:1200,a:{action:'setRole',role:'rec'}},
      {d:4000,a:{action:'setRole',role:'hm'}},
      {d:6500,a:{action:'setRole',role:'cand'}},
      {d:9000,a:{action:'setRole',role:'adm'}}
    ],
    minHold:12000,
    voice:"So before the call, Sarah's getting her team set up. On any SAP SuccessFactors Recruiting project you have four types of people involved &mdash; the recruiter, the hiring manager, the candidate, and the admin. Each one of them logs in and sees a completely different version of this platform. You can watch it switching between them now.",
    callout:{label:'Role-based views',text:'Recruiter \u00b7 Hiring Manager \u00b7 Candidate \u00b7 Admin',dot:{x:50,y:14},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Recruiter View', url:'/',
    auto:[
      {d:800,a:{action:'setRole',role:'rec'}}
    ],
    minHold:7000,
    voice:"She clicks into the recruiter side. What you're looking at is just their stuff &mdash; the tasks that are relevant to them, their process, laid out in a way that makes sense for their role. It's a clean, focused view built around what a recruiter actually does day to day.",
    callout:{label:'Recruiter guide',text:'Job posting \u00b7 Pipelines \u00b7 Offer management',dot:{x:50,y:14},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Schedule Interview &mdash; Step by Step', url:'/',
    auto:[
      {d:800, a:{action:'openTaskDetail',taskId:'sched-interview'}},
      {d:4500,a:{action:'expandTaskSteps',taskId:'sched-interview',indices:[0]}}
    ],
    minHold:10000,
    voice:"She opens Schedule Interview. You can see all the steps here &mdash; who does each one, what's involved, what order they go in. Before the client has even asked her a question about this, she's already got the full picture in front of her.",
    callout:{label:'Process walkthrough',text:'Every step, every owner &mdash; no ambiguity',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Step 2 Has an Issue &mdash; Ask AI', url:'/',
    auto:[
      {d:800, a:{action:'expandTaskSteps',taskId:'sched-interview',indices:[1]}},
      {d:4000,a:{action:'openStuck',taskId:'sched-interview',stepIdx:1}},
      {d:7500,a:{action:'askAIForStuck',taskId:'sched-interview',stepIdx:1}}
    ],
    manual:true,
    manualHint:22000,
    voice:"Step two is where teams keep getting stuck. She flags it. EX3 surfaces the likely causes immediately. One click and that exact step goes to the AI &mdash; everything pre-loaded. Watch it answer. Click next when you are ready.",
    callout:{label:'Built-in troubleshooting',text:'Flag any step \u2014 AI answers with full context',dot:{x:80,y:20},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Follow-Up &mdash; Context Memory', url:'/',
    auto:[
      {d:1000,a:{action:'typeAndAsk',query:'What permission level do I need to schedule on behalf of someone?'}}
    ],
    manual:true,
    manualHint:25000,
    voice:"Now watch the follow-up. She asks a second question &mdash; no re-explaining, no starting over. The AI carries the full conversation. That is context memory. Click next when the answer lands.",
    callout:{label:'Context memory',text:'Follow-up questions \u2014 full conversation carried forward',dot:{x:78,y:36},bubble:{x:2,y:4}}
  },
  {
    type:'card', icon:'', title:'Ask anything.', chap:'Chapter II', headline:'Ask anything.<br><em>Get an answer.</em>', countdown:4, auto:[], callout:null,
    voice:"And that AI you just saw &mdash; you can ask it literally anything. Not just the stuck steps. Any SAP SuccessFactors Recruiting question, any point in the project, any time of day."
  },
  {
    icon:'', title:'Try It &mdash; Ask Anything', url:'/',
    auto:[{d:800,a:{action:'openAI'}}],
    manual:true,
    manualHint:5000,
    voice:"Go ahead &mdash; ask it anything you like. A SAP SuccessFactors Recruiting question, something about the process, whatever comes to mind. Click next whenever you are done.",
    callout:null
  },
  {
    icon:'', title:'Implementation Runbook', url:'/',
    auto:[
      {d:700, a:{action:'closeAI'}},
      {d:1400,a:{action:'openUnifiedFlow'}},
      {d:5500,a:{action:'setFlowProcesses',ids:['post-job','sched-interview','add-workflow','add-assessment'],buildNow:true}}
    ],
    minHold:13000,
    voice:"After the call she builds the implementation runbook. Picks the exact processes the client needs. One click and the full sequence generates &mdash; post job, schedule interview, workflow automation, assessments. The whole delivery plan, structured and ready.",
    callout:{label:'One-go workflow',text:'Full implementation sequence \u2014 generated in seconds',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    type:'card', icon:'', title:'Same AI. On WhatsApp.', chap:'Chapter III', headline:'Same AI.<br><em>On WhatsApp.</em>', auto:[], callout:null,
    voice:"No app. No login. Just WhatsApp.",
    postVoice:"Quick one. I\\'m five minutes from the client site. Their hiring manager just messaged &mdash; the Send Offer button isn\\'t showing up. I need to know what\\'s blocking it before I walk in. Thanks.",
    postVoiceStressed:true
  },
  {
    icon:'', title:'WhatsApp AI Bot',
    url:null,
    ph:{icon:'',title:'',body:'',link:null},
    recordingScene:true,
    calloutDelay:26000,
    minHold:32000,
    waChat:[
      {from:'me', type:'voice', delay:500, ts:'06:07'},
      {from:'them', text:"The Send Offer button only appears once three things are in place:\\n\\n1\ufe0f\u20e3 The candidate is in the *Offer* stage\\n2\ufe0f\u20e3 The job has an active offer letter template\\n3\ufe0f\u20e3 You have the *Offer Manager* permission\\n\\nWhich one would you like to check first?", delay:14000, ts:'06:07'},
      {from:'me', text:"Probably permissions \u2014 how do I check that?", delay:18500, ts:'06:08'},
      {from:'them', text:"Go to *Admin \u2192 User Management*, find your name, and look at your assigned role.\\n\\nYou need either the *Offer Manager* role, or a custom role with the *Create Offer* permission enabled.\\n\\nIf it\\'s missing your SR admin can add it in about 2 minutes.", delay:21000, ts:'06:08'}
    ],
    auto:[],
    voice:"Six oh seven in the morning. Sarah is in the back of a cab, five minutes from the client site. The hiring manager has messaged &mdash; the Send Offer button is gone. She does not type. She records a voice note on WhatsApp, presses send, and watches the answer land before she even gets out of the car. Same AI. No app. No login. Around the clock.",
    callout:{label:'WhatsApp AI bot',text:'Voice notes supported \u2014 no app, no login',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Consultant Portal', url:'/consultant',
    auto:[{d:800,a:{action:'showPhases'}},{d:1700,a:{action:'openPhase',index:0}},{d:3500,a:{action:'openPhase',index:1}},{d:5300,a:{action:'openPhase',index:2}},{d:7100,a:{action:'openPhase',index:3}}],
    minHold:9500,
    voice:"Back at her desk, Sarah is running the engagement through the consultant portal. The EXcelerate methodology &mdash; four phases, each one fully structured. Examine, Adopt, Validate, Launch. Checklists, RACI, deliverables, timelines. Everything her delivery team needs to run a clean deployment.",
    callout:{label:'EXcelerate methodology',text:'Examine \u00b7 Adopt \u00b7 Validate \u00b7 Launch',dot:{x:50,y:42},bubble:{x:2,y:4}}
  },
  {
    type:'card', icon:'', title:'A complete SOW. In 45 seconds.', chap:'Chapter IV', headline:'A complete SOW.<br><em>In 45 seconds.</em>', countdown:4, auto:[], callout:null,
    voice:"The client has asked for a formal Statement of Work before they will sign off. Watch what happens next."
  },
  {
    icon:'', title:'SOW Builder', url:'/consultant/sow-builder', auto:[{d:500,a:{action:'demoWalkSOW'}}], countdown:10,
    voice:"She opens the SOW builder. Nineteen questions &mdash; org size, geography, integrations, approval workflows, compliance, training approach, go-live date. Every single one answered. At the end, a complete Statement of Work structured around every EXcelerate phase.",
    callout:{label:'19-step SOW wizard',text:'Every requirement captured \u2014 EXcelerate format output',dot:{x:50,y:32},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'AI SOW Rewrite', url:'/consultant/sow-builder', auto:[{d:1000,a:{action:'triggerAIRewrite'}}],
    minHold:7000,
    voice:"One click. The AI rewrites the whole thing into polished, client-ready consulting language &mdash; streamed live, word by word. Boardroom-ready. Done before the afternoon stand-up.",
    callout:{label:'AI rewrite',text:'Client-ready language, generated instantly',dot:{x:50,y:54},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Export & Email', url:'/consultant/sow-builder', auto:[{d:800,a:{action:'scrollToExport'}}],
    voice:"She exports it as a structured Word document &mdash; proper headings, phase tables, RACI matrices. Or sends it straight to the client by email. From generation to delivery, without leaving the page.",
    callout:{label:'One-click delivery',text:'Structured Word doc or direct email to client',dot:{x:50,y:78},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:'Analytics & Insights',
    url:null,
    analyticsPanel:true,
    auto:[],
    minHold:13000,
    voice:"Three weeks in. The data tells the story. Two hundred and forty seven AI queries this week. Four point two hours saved per consultant. Twelve active engagements running clean. The platform does not just support the work &mdash; it measures it.",
    callout:{label:'Live analytics',text:'Queries, time saved, engagement health \u2014 all tracked',dot:{x:50,y:50},bubble:{x:2,y:4}}
  },
  {
    icon:'', title:"That\\'s EX3", url:'/', auto:[{d:600,a:{action:'setRole',role:'rec'}}],
    voice:"The kickoff went well. The SOW is signed. The team is live. Sarah has sixty days to deliver &mdash; and everything she needs is right here. Role training for every person. An AI that answers anything. WhatsApp, voice notes, no login. A complete SOW in forty-five seconds. That is EX3.",
    callout:null
  }
];

// â”€â”€ State â”€â”€
var cur = 0, prevCur = -1, paused = false, muted = false;
var autoTimers = [], advTimer = null;
var narrationStepToken = 0;
var currentAudio = null;
var frameInteracted = false;

// â”€â”€ Frame crossfade â”€â”€
function flashFrame(){
  var el=document.getElementById('frame-fade');
  if(!el) return;
  el.classList.add('in');
  setTimeout(function(){ el.classList.remove('in'); },300);
}

// â”€â”€ Auto-advance ring â”€â”€
var autoRingInterval=null;
function startAutoAdvance(secs, onDone){
  stopAutoAdvance();
  var remaining=secs;
  var ring=document.getElementById('auto-ring');
  var fill=document.getElementById('auto-ring-fill');
  var num=document.getElementById('auto-ring-n');
  var circ=100.5;
  if(!ring) return;
  ring.classList.add('show');
  num.textContent=remaining;
  fill.style.strokeDashoffset=circ;
  autoRingInterval=setInterval(function(){
    remaining--;
    num.textContent=remaining;
    fill.style.strokeDashoffset=Math.round(circ - circ*((secs-remaining)/secs));
    if(remaining<=0){ stopAutoAdvance(); onDone(); }
  },1000);
}
function stopAutoAdvance(){
  if(autoRingInterval){ clearInterval(autoRingInterval); autoRingInterval=null; }
  var ring=document.getElementById('auto-ring');
  if(ring) ring.classList.remove('show');
}

function markFrameInteracted(){
  frameInteracted = true;
  clearAuto();
  hideCallout();
}

function stopAudio(){
  if(currentAudio){ currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
}
function pauseAudio(){ if(currentAudio) currentAudio.pause(); }
function resumeAudio(){ if(currentAudio) currentAudio.play().catch(function(){}); }
function unlockSpeech(){}

// â”€â”€ Narration â”€â”€
function buildWords(text){
  return text.split(' ').map(function(w,i){ return {w:w,i:i}; });
}

function renderWords(text, charPos){
  var words = text.split(' ');
  var pos = 0;
  var html = '';
  for(var i=0;i<words.length;i++){
    var start = pos;
    var end = pos + words[i].length;
    var cls;
    if(charPos < 0){ cls = 'w future'; }
    else if(charPos > end){ cls = 'w past'; }
    else if(charPos >= start){ cls = 'w now'; }
    else { cls = 'w future'; }
    html += '<span class="'+cls+'">'+words[i]+' </span>';
    pos = end + 1;
  }
  document.getElementById('nar-words').innerHTML = html;
}

function speak(text, onDone, stepToken){
  stopAudio();
  document.getElementById('bars').classList.remove('speaking');

  if(muted){
    renderWords(text, -1);
    var est = Math.max(7000, text.split(' ').length * 430);
    autoTimers.push(setTimeout(function(){
      if(stepToken !== narrationStepToken) return;
      if(onDone) onDone();
    }, est));
    return;
  }

  renderWords(text, -1);
  document.getElementById('bars').classList.add('speaking');

  var words = text.split(' ');
  var completed = false;
  var wordTimer = null;

  function finish(){
    if(completed) return;
    completed = true;
    if(wordTimer){ clearInterval(wordTimer); wordTimer = null; }
    stopAudio();
    document.getElementById('bars').classList.remove('speaking');
    document.getElementById('nar-pb-fill').style.width = '100%';
    renderWords(text, text.length + 1);
    setTimeout(function(){ if(onDone) onDone(); }, 300);
  }

  var audio = new Audio('/api/tts?text=' + encodeURIComponent(text));
  currentAudio = audio;

  audio.oncanplay = function(){
    if(stepToken !== narrationStepToken){ stopAudio(); return; }
    audio.play().catch(function(){ if(stepToken === narrationStepToken) finish(); });
  };

  audio.onplay = function(){
    // Animate word highlights proportionally to audio duration
    wordTimer = setInterval(function(){
      if(stepToken !== narrationStepToken){ clearInterval(wordTimer); return; }
      if(!audio.duration || audio.paused) return;
      var pct = audio.currentTime / audio.duration;
      var charPos = Math.floor(pct * text.length);
      renderWords(text, charPos);
      document.getElementById('nar-pb-fill').style.width = Math.min(99, Math.round(pct * 100)) + '%';
    }, 150);
  };

  audio.onended = function(){
    if(stepToken !== narrationStepToken) return;
    finish();
  };

  audio.onerror = function(){
    if(stepToken !== narrationStepToken) return;
    finish();
  };
}

// â”€â”€ Callout â”€â”€
function showCallout(c){
  var bub = document.getElementById('cbubble');
  var dot = document.getElementById('cdot');
  bub.classList.remove('show'); dot.classList.remove('show');
  if(!c) return;
  var fa = document.getElementById('frame-area');
  var fw = fa.offsetWidth, fh = fa.offsetHeight;
  dot.style.left = Math.round(fw * c.dot.x / 100) + 'px';
  dot.style.top  = Math.round(fh * c.dot.y / 100) + 'px';
  var bx = Math.round(fw * c.bubble.x / 100);
  var by = Math.round(fh * c.bubble.y / 100);
  bub.style.left = bx + 'px';
  bub.style.top  = by + 'px';
  bub.innerHTML = '<strong>'+c.label+'</strong>'+c.text;
  setTimeout(function(){ bub.classList.add('show'); dot.classList.add('show'); }, 900);
}

function hideCallout(){
  document.getElementById('cbubble').classList.remove('show');
  document.getElementById('cdot').classList.remove('show');
}

// â”€â”€ Dots â”€â”€
function renderDots(){
  document.getElementById('dots-row').innerHTML = steps.map(function(_,i){
    var cls = i<cur?'dot done':i===cur?'dot cur':'dot';
    return '<div class="'+cls+'" onclick="jumpTo('+i+', true)" title="'+steps[i].title+'"></div>';
  }).join('');
  document.getElementById('prog-fill').style.width = Math.round((cur+1)/steps.length*100)+'%';
}

// â”€â”€ Step pill â”€â”€
function showPill(s, idx){
  var el = document.getElementById('step-pill');
  el.classList.remove('show');
  document.getElementById('pill-icon').textContent = s.icon;
  document.getElementById('pill-title').textContent = s.title;
  setTimeout(function(){ el.classList.add('show'); }, 150);
  setTimeout(function(){ el.classList.remove('show'); }, 4500);
}

// â”€â”€ postMessage â”€â”€
function postToFrame(msg){
  try{ document.getElementById('liveFrame').contentWindow.postMessage(Object.assign({type:'EX3_DEMO'},msg),'*'); }catch(e){}
}

function clearAnalytics(){
  var el = document.getElementById('analytics-shell');
  if(el) el.classList.remove('active');
}
function showAnalytics(){
  var el = document.getElementById('analytics-shell');
  if(!el) return;
  el.classList.add('active');
  // Animate counters
  var targets = [{id:'an-k1',val:247,dec:0},{id:'an-k2',val:4.2,dec:1},{id:'an-k3',val:94,dec:0},{id:'an-k4',val:12,dec:0}];
  targets.forEach(function(t){
    var el2 = document.getElementById(t.id);
    if(!el2) return;
    var suffix = el2.querySelector('.an-knum-suffix') ? el2.querySelector('.an-knum-suffix').outerHTML : '';
    var start = Date.now(), dur = 1400;
    function tick(){
      var p = Math.min((Date.now()-start)/dur, 1);
      var ease = 1-Math.pow(1-p,3);
      var v = t.val * ease;
      el2.innerHTML = (t.dec ? v.toFixed(t.dec) : Math.round(v)) + suffix;
      if(p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  // Animate bars
  setTimeout(function(){
    document.querySelectorAll('#analytics-shell .an-bar').forEach(function(b){ b.classList.add('grow'); });
  }, 200);
  // Animate question fills
  setTimeout(function(){
    document.querySelectorAll('#analytics-shell .an-q-fill').forEach(function(f){ f.style.width = f.style.getPropertyValue('--w') || '50%'; });
  }, 600);
}

var waTimers = [], waVoiceAudio = null;
function clearWaChat(){
  waTimers.forEach(clearTimeout); waTimers = [];
  if(waVoiceAudio){ waVoiceAudio.pause(); waVoiceAudio.currentTime = 0; waVoiceAudio = null; }
  var shell = document.getElementById('wa-shell');
  if(shell) shell.classList.remove('active');
  var msgs = document.getElementById('wa-msgs');
  if(msgs) msgs.innerHTML = '';
  var typ = document.getElementById('wa-typing');
  if(typ) typ.classList.remove('show');
  var rec = document.getElementById('wa-recording-scene');
  if(rec){ rec.classList.remove('active'); rec.style.opacity = ''; }
}
function startWaChat(msgs){
  var list = document.getElementById('wa-msgs');
  var typ = document.getElementById('wa-typing');
  if(!list) return;
  var now = new Date();
  var defaultTs = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  msgs.forEach(function(msg){
    var ts = msg.ts || defaultTs;
    if(msg.from === 'them'){
      waTimers.push(setTimeout(function(){
        typ.classList.add('show');
        list.scrollTop = list.scrollHeight;
        waTimers.push(setTimeout(function(){
          typ.classList.remove('show');
          var b = document.createElement('div');
          b.className = 'wa-bubble them';
          b.textContent = msg.text;
          var t = document.createElement('span'); t.className='wa-time'; t.textContent=ts;
          b.appendChild(t);
          list.appendChild(b);
          setTimeout(function(){ b.classList.add('show'); },20);
          list.scrollTop = list.scrollHeight;
        }, 1400));
      }, msg.delay || 0));
    } else {
      waTimers.push(setTimeout(function(){
        var b = document.createElement('div');
        b.className = 'wa-bubble me';
        if(msg.type === 'voice'){
          var bh = [4,6,9,14,18,20,16,10,14,20,12,8,6,14,18,14,10,8,12,16,10,8,6,10,14];
          var barHtml = bh.map(function(h){ return '<div class="wa-wbar" style="height:'+h+'px"></div>'; }).join('');
          var dur = msg.voiceText ? Math.round(msg.voiceText.length / 14) : 8;
          b.innerHTML = '<div class="wa-voice-note"><div class="wa-voice-play"><span style="color:#fff;font-size:11px;margin-left:2px">\u25B6</span></div><div class="wa-waveform">'+barHtml+'</div><span class="wa-voice-dur">0:'+dur.toString().padStart(2,'0')+'</span></div>';
          if(msg.voiceText){
            var vt = encodeURIComponent(msg.voiceText);
            setTimeout(function(){
              if(waVoiceAudio){ waVoiceAudio.pause(); waVoiceAudio = null; }
              waVoiceAudio = new Audio('/api/tts?text='+vt+'&stressed=1');
              waVoiceAudio.play().catch(function(){});
            }, 500);
          }
        } else {
          b.textContent = msg.text;
        }
        var t = document.createElement('span'); t.className='wa-time';
        t.innerHTML = ts + ' <span class="wa-tick">\u2713\u2713</span>';
        b.appendChild(t);
        list.appendChild(b);
        setTimeout(function(){ b.classList.add('show'); },20);
        list.scrollTop = list.scrollHeight;
      }, msg.delay || 0));
    }
  });
}

function clearAuto(){
  autoTimers.forEach(function(t){ clearTimeout(t); }); autoTimers = [];
  if(advTimer){ clearTimeout(advTimer); advTimer = null; }
  stopAutoAdvance();
  var btn = document.querySelector('.nar-btn.next');
  if(btn) btn.classList.remove('ready');
}

function fireAuto(s){
  if(!s.auto) return;
  s.auto.forEach(function(cmd){
    autoTimers.push(setTimeout(function(){
      if(frameInteracted) return;
      postToFrame(cmd.a);
    }, cmd.d));
  });
}

function bindFrameInteractionHandlers(){
  try {
    var frame = document.getElementById('liveFrame');
    var win = frame.contentWindow;
    if(!win || win.__ex3DemoBound) return;
    win.addEventListener('pointerdown', markFrameInteracted, { passive: true });
    win.addEventListener('keydown', markFrameInteracted);
    frame.addEventListener('pointerdown', markFrameInteracted, { passive: true });
    frame.addEventListener('focus', markFrameInteracted);
    win.__ex3DemoBound = true;
  } catch(e) {}
}

window.addEventListener('message', function(e){
  if(!e.data || e.data.type !== 'EX3_DEMO_INTERACTION') return;
  markFrameInteracted();
});

// â”€â”€ Render â”€â”€
function render(){
  if(paused) return;
  var s = steps[cur];
  var stepToken = ++narrationStepToken;
  var stepStartTime = Date.now();
  frameInteracted = false;
  document.getElementById('tb-step').textContent = 'Step '+(cur+1)+' of '+steps.length;
  document.getElementById('nar-tag').textContent = s.title;
  document.getElementById('nar-pb-fill').style.width = '0%';
  renderDots();
  showPill(s, cur);
  clearAuto();
  hideCallout();
  stopAudio();
  document.getElementById('bars').classList.remove('speaking');

  // Frame
  var cardPanel = document.getElementById('card-panel');
  var recScene = document.getElementById('wa-recording-scene');
  if(cardPanel) cardPanel.classList.remove('active');
  if(recScene){ recScene.classList.remove('active'); recScene.style.opacity = ''; }
  clearAnalytics();

  if(s.type === 'card'){
    document.getElementById('liveFrame').style.display = 'none';
    document.getElementById('ph').style.display = 'none';
    if(cardPanel){
      document.getElementById('card-chap').textContent = s.chap || '';
      document.getElementById('card-headline').innerHTML = s.headline || '';
      setTimeout(function(){ cardPanel.classList.add('active'); }, 20);
    }
  } else if(s.url){
    var same = prevCur>=0 && steps[prevCur] && steps[prevCur].url===s.url;
    document.getElementById('ph').style.display = 'none';
    document.getElementById('liveFrame').style.display = 'block';
    if(!same){
      flashFrame();
      document.getElementById('liveFrame').src = s.url;
      document.getElementById('liveFrame').onload = function(){
        bindFrameInteractionHandlers();
        fireAuto(s);
        document.getElementById('liveFrame').onload = null;
      };
    } else {
      bindFrameInteractionHandlers();
      fireAuto(s);
    }
  } else {
    document.getElementById('liveFrame').style.display = 'none';
    clearWaChat();
    if(s.analyticsPanel){
      document.getElementById('ph').style.display = 'none';
      setTimeout(function(){ showAnalytics(); }, 80);
    } else if(s.waChat){
      document.getElementById('ph').style.display = 'flex';
      document.getElementById('ph-icon').textContent = '';
      document.getElementById('ph-title').textContent = '';
      document.getElementById('ph-body').textContent = '';
      document.getElementById('ph-cta').style.display = 'none';
      if(s.recordingScene && recScene){
        recScene.classList.add('active');
        autoTimers.push(setTimeout(function(){
          if(narrationStepToken !== stepToken) return;
          recScene.style.opacity = '0';
          autoTimers.push(setTimeout(function(){
            recScene.classList.remove('active');
            recScene.style.opacity = '';
            document.getElementById('wa-shell').classList.add('active');
            startWaChat(s.waChat);
          }, 500));
        }, 3200));
      } else {
        document.getElementById('wa-shell').classList.add('active');
        startWaChat(s.waChat);
      }
    } else {
      document.getElementById('ph').style.display = 'flex';
      var ph = s.ph || {};
      document.getElementById('ph-icon').textContent = ph.icon || s.icon;
      document.getElementById('ph-title').textContent = ph.title || s.title;
      document.getElementById('ph-body').textContent = ph.body || '';
      var cta = document.getElementById('ph-cta');
      if(ph.link){ cta.style.display='inline-block'; cta.textContent=ph.link.label; cta.href=ph.link.url; }
      else{ cta.style.display='none'; }
    }
  }
  prevCur = cur;

  // Show callout after a short delay
  var calloutTimer = setTimeout(function(){ showCallout(s.callout); }, s.calloutDelay || 1500);
  autoTimers.push(calloutTimer);

  // Speak, then auto-advance (ring only for steps with explicit countdown)
  speak(s.voice, function(){
    if(stepToken !== narrationStepToken) return;
    if(paused) return;
    if(cur >= steps.length-1) return;
    if(s.postVoice){
      var pvDone = false;
      function advAfterPV(){ if(pvDone) return; pvDone=true; if(stepToken!==narrationStepToken||paused) return; go(1); }
      var pvAud = new Audio('/api/tts?text='+encodeURIComponent(s.postVoice)+(s.postVoiceStressed?'&stressed=1':''));
      pvAud.play().catch(function(){});
      pvAud.onended = advAfterPV;
      autoTimers.push(setTimeout(advAfterPV, 18000));
      return;
    }
    if(s.countdown){
      startAutoAdvance(s.countdown, function(){ go(1); });
    } else if(s.manual){
      // Wait for user to click Next Step &mdash; pulse the button after the AI has had time to answer
      var hint = s.manualHint || 18000;
      autoTimers.push(setTimeout(function(){
        if(stepToken !== narrationStepToken) return;
        var btn = document.querySelector('.nar-btn.next');
        if(btn) btn.classList.add('ready');
      }, hint));
    } else {
      var elapsed = Date.now() - stepStartTime;
      var wait = Math.max(1800, (s.minHold || 0) - elapsed);
      autoTimers.push(setTimeout(function(){
        if(stepToken !== narrationStepToken || paused) return;
        go(1);
      }, wait));
    }
  }, stepToken);
}

// â”€â”€ Controls â”€â”€
function togglePause(){
  paused = !paused;
  var btn = document.getElementById('pause-btn');
  if(paused){
    pauseAudio();
    btn.textContent = '\u25B6';
    btn.classList.add('on');
    if(advTimer){ clearTimeout(advTimer); advTimer = null; }
  } else {
    btn.textContent = '\u23F8';
    btn.classList.remove('on');
    if(currentAudio){ resumeAudio(); }
    else {
      var s = steps[cur];
      var stepToken = narrationStepToken;
      speak(s.voice, function(){
        if(stepToken !== narrationStepToken) return;
      }, stepToken);
      showCallout(s.callout);
    }
  }
}

function toggleMute(){
  muted = !muted;
  var btn = document.getElementById('mute-btn');
  btn.textContent = muted ? 'MUTE' : 'VOL';
  btn.classList.toggle('muted', muted);
  if(muted) stopAudio();
}

function restartDemo(){
  clearAuto();
  stopAudio();
  paused = false;
  document.getElementById('pause-btn').textContent = '\u23F8';
  document.getElementById('pause-btn').classList.remove('on');
  cur = 0; prevCur = -1;
  render();
}

function jumpTo(i, isManual){
  clearAuto();
  stopAudio();
  paused = false;
  document.getElementById('pause-btn').textContent = '\u23F8';
  document.getElementById('pause-btn').classList.remove('on');
  if(isManual && i>cur) {} // no chime
  cur = i;
  render();
}

function go(d){
  var n = Math.max(0,Math.min(steps.length-1,cur+d));
  if(n !== cur) jumpTo(n, d>0);
}

function replayStep(){
  jumpTo(cur, true);
}

function retryAudio(){
  stopAudio();
  var step = steps[cur];
  narrationStepToken++;
  if(step.voice){
    speak(step.voice, null, narrationStepToken);
  }
}

document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if(e.key==='ArrowRight'||e.key===' '){ e.preventDefault(); go(1); }
  if(e.key==='ArrowLeft') go(-1);
  if(e.key==='p'||e.key==='P') togglePause();
  if(e.key==='m'||e.key==='M') toggleMute();
  if(e.key==='r'||e.key==='R') restartDemo();
});

// â”€â”€ Begin â”€â”€
function beginDemo(){
  var ss = document.getElementById('start-screen');
  ss.classList.add('fade');
  setTimeout(function(){
    ss.style.display = 'none';
    document.getElementById('demo').classList.add('show');
    render();
  }, 600);
}

// â”€â”€ Count-up stats on load â”€â”€
(function(){
  var targets = [{id:'stat-features',val:50,suffix:'+'},{id:'stat-roles',val:4},{id:'stat-time',val:4}];
  targets.forEach(function(t,idx){
    setTimeout(function(){
      var el = document.getElementById(t.id); if(!el) return;
      var count=0, step=1, dur=700, interval=Math.round(dur/t.val);
      var iv = setInterval(function(){
        count += step;
        el.textContent = count + (t.suffix||'');
        if(count >= t.val){ el.textContent = t.val + (t.suffix||''); clearInterval(iv); }
      }, interval);
    }, idx*120);
  });
})();
</script>
</body>
</html>`);
});


// Conversation history page
app.all('/conversations', requirePassword);
app.get('/conversations', (req, res) => {
  const allLogs = readWebLogs();
  const whatsappLogs = readLogs();

  // Group web logs by threadId
  const webThreads = {};
  for (const log of allLogs) {
    const id = log.threadId || 'unknown';
    if (!webThreads[id]) webThreads[id] = [];
    webThreads[id].push(log);
  }

  // Group whatsapp logs by phone
  const waThreads = {};
  for (const log of whatsappLogs) {
    const id = log.phone || 'unknown';
    if (!waThreads[id]) waThreads[id] = [];
    waThreads[id].push(log);
  }

  // Build thread list sorted by most recent message
  const webList = Object.entries(webThreads).map(([id, msgs]) => {
    const sorted = msgs.slice().sort((a, b) => a.ts.localeCompare(b.ts));
    return { id, source: 'web', msgs: sorted, last: sorted[sorted.length - 1].ts, first: sorted[0] };
  }).sort((a, b) => b.last.localeCompare(a.last));

  const waList = Object.entries(waThreads).map(([id, msgs]) => {
    const sorted = msgs.slice().sort((a, b) => a.ts.localeCompare(b.ts));
    return { id, source: 'whatsapp', msgs: sorted, last: sorted[sorted.length - 1].ts, first: sorted[0] };
  }).sort((a, b) => b.last.localeCompare(a.last));

  const allThreads = [...webList, ...waList].sort((a, b) => b.last.localeCompare(a.last));

  const threadsJson = JSON.stringify(allThreads).replace(/</g, '\\u003c');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation History &mdash; EX3</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Sora',sans-serif; background:#f8f7f4; color:#0f0f0e; height:100vh; display:flex; flex-direction:column; }
  .topbar { display:flex; align-items:center; justify-content:space-between; padding:14px 24px; background:#fff; border-bottom:1px solid #e4e2dc; flex-shrink:0; }
  .topbar-title { font-size:16px; font-weight:700; }
  .topbar-nav { display:flex; gap:16px; font-size:13px; }
  .topbar-nav a { color:#4a90e2; text-decoration:none; font-weight:600; }
  .layout { display:flex; flex:1; overflow:hidden; }

  /* Thread list sidebar */
  .thread-sidebar { width:300px; background:#fff; border-right:1px solid #e4e2dc; display:flex; flex-direction:column; flex-shrink:0; }
  .thread-search { padding:12px 16px; border-bottom:1px solid #f0ede8; }
  .thread-search input { width:100%; padding:8px 12px; border:1.5px solid #e4e2dc; border-radius:8px; font-family:inherit; font-size:13px; outline:none; background:#f8f7f4; }
  .thread-search input:focus { border-color:#0f0f0f; }
  .thread-list { flex:1; overflow-y:auto; }
  .thread-item { padding:14px 16px; border-bottom:1px solid #f0ede8; cursor:pointer; transition:background 0.1s; }
  .thread-item:hover { background:#faf9f7; }
  .thread-item.active { background:#f0ede8; }
  .thread-meta { display:flex; align-items:center; justify-content:space-between; margin-bottom:5px; }
  .thread-source { font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:2px 7px; border-radius:4px; }
  .thread-source.web { background:#dbeafe; color:#1d4ed8; }
  .thread-source.whatsapp { background:#dcfce7; color:#166534; }
  .thread-date { font-size:11px; color:#aaa; }
  .thread-preview { font-size:12.5px; color:#555; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:4px; }
  .thread-count { font-size:11px; color:#aaa; }
  .thread-empty { padding:32px 16px; text-align:center; color:#bbb; font-size:13px; }

  /* Chat panel */
  .chat-panel { flex:1; display:flex; flex-direction:column; overflow:hidden; }
  .chat-header { padding:16px 24px; background:#fff; border-bottom:1px solid #e4e2dc; flex-shrink:0; }
  .chat-header-title { font-size:14px; font-weight:700; margin-bottom:2px; }
  .chat-header-sub { font-size:12px; color:#aaa; }
  .chat-messages { flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:20px; }
  .chat-empty { display:flex; align-items:center; justify-content:center; height:100%; color:#ccc; font-size:14px; text-align:center; }

  /* Message bubbles */
  .msg { display:flex; flex-direction:column; max-width:72%; }
  .msg.user { align-self:flex-end; align-items:flex-end; }
  .msg.ai { align-self:flex-start; align-items:flex-start; }
  .msg-label { font-size:10.5px; font-weight:600; color:#aaa; margin-bottom:5px; letter-spacing:0.5px; }
  .msg.user .msg-label { color:#6b7280; }
  .bubble { padding:12px 16px; border-radius:14px; font-size:13.5px; line-height:1.65; white-space:pre-wrap; word-break:break-word; }
  .msg.user .bubble { background:#0f0f0f; color:#fff; border-bottom-right-radius:4px; }
  .msg.ai .bubble { background:#fff; border:1px solid #e4e2dc; color:#0f0f0e; border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,.04); }
  .msg.ai .bubble.uncertain { border-color:#fde68a; background:#fffbeb; }
  .msg-time { font-size:10.5px; color:#ccc; margin-top:5px; }
  .uncertain-badge { font-size:10px; font-weight:700; color:#92400e; background:#fef3c7; padding:2px 8px; border-radius:4px; margin-top:4px; display:inline-block; }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-title">Conversation History</div>
  <div class="topbar-nav">
    <a href="/analytics">WhatsApp Analytics</a>
    <a href="/analytics/web">Web Analytics</a>
    <a href="/analytics/feedback">AI Feedback</a>
  </div>
</div>
<div class="layout">
  <div class="thread-sidebar">
    <div class="thread-search">
      <input type="text" id="search" placeholder="Search conversations..." oninput="filterThreads(this.value)">
    </div>
    <div class="thread-list" id="thread-list"></div>
  </div>
  <div class="chat-panel">
    <div class="chat-header" id="chat-header" style="display:none">
      <div class="chat-header-title" id="chat-header-title"></div>
      <div class="chat-header-sub" id="chat-header-sub"></div>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="chat-empty">Select a conversation on the left to read it</div>
    </div>
  </div>
</div>
<script>
const threads = ${threadsJson};
let active = null;

function relativeDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  return d.toLocaleDateString([], {day:'numeric', month:'short'});
}

function renderThreadList(list) {
  const el = document.getElementById('thread-list');
  if (!list.length) { el.innerHTML = '<div class="thread-empty">No conversations yet</div>'; return; }
  el.innerHTML = list.map((t, i) => {
    const src = t.source === 'whatsapp' ? 'WhatsApp' : 'Web';
    const srcCls = t.source;
    const preview = t.first.question || t.first.body || '';
    const cls = active === t.id ? ' active' : '';
    return '<div class="thread-item' + cls + '" onclick="openThread(' + i + ')">' +
      '<div class="thread-meta">' +
        '<span class="thread-source ' + srcCls + '">' + src + '</span>' +
        '<span class="thread-date">' + relativeDate(t.last) + '</span>' +
      '</div>' +
      '<div class="thread-preview">' + esc(preview.slice(0, 80)) + '</div>' +
      '<div class="thread-count">' + t.msgs.length + ' message' + (t.msgs.length !== 1 ? 's' : '') + '</div>' +
    '</div>';
  }).join('');
}

function openThread(idx) {
  const t = filteredThreads[idx];
  active = t.id;
  renderThreadList(filteredThreads);

  const label = t.source === 'whatsapp' ? 'WhatsApp &mdash; ' + t.id : 'Web Chat &mdash; ' + t.id.slice(-12);
  document.getElementById('chat-header').style.display = 'block';
  document.getElementById('chat-header-title').textContent = label;
  document.getElementById('chat-header-sub').textContent =
    t.msgs.length + ' messages Â· Started ' + new Date(t.msgs[0].ts).toLocaleString();

  const el = document.getElementById('chat-messages');
  el.innerHTML = t.msgs.map(m => {
    const q = m.question || m.body || '';
    const a = m.answer || m.response || '';
    const ts = new Date(m.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const uncertainBadge = m.uncertain ? '<span class="uncertain-badge">âš  Uncertain answer</span>' : '';
    let html = '';
    if (q) {
      html += '<div class="msg user">' +
        '<div class="msg-label">You</div>' +
        '<div class="bubble">' + esc(q) + '</div>' +
        '<div class="msg-time">' + ts + '</div>' +
      '</div>';
    }
    if (a) {
      html += '<div class="msg ai">' +
        '<div class="msg-label">EX3 AI</div>' +
        '<div class="bubble' + (m.uncertain ? ' uncertain' : '') + '">' + esc(a) + '</div>' +
        uncertainBadge +
        '<div class="msg-time">' + ts + ' Â· ' + (m.ms ? (m.ms/1000).toFixed(1) + 's' : '') + '</div>' +
      '</div>';
    }
    return html;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let filteredThreads = threads;

function filterThreads(q) {
  q = q.toLowerCase();
  filteredThreads = q ? threads.filter(t =>
    t.msgs.some(m => (m.question||'').toLowerCase().includes(q) || (m.answer||'').toLowerCase().includes(q) || (m.body||'').toLowerCase().includes(q))
  ) : threads;
  renderThreadList(filteredThreads);
}

filteredThreads = threads;
renderThreadList(filteredThreads);
</script>
</body>
</html>`);
});

// â”€â”€ Demo2: Cinematic product experience â”€â”€
app.get('/demo2', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SAP SuccessFactors Recruiting &mdash; Experience</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#060606;color:#fff;font-family:'Sora',sans-serif;cursor:none}
*{cursor:none!important}

/* Custom cursor */
#cursor{position:fixed;width:10px;height:10px;border-radius:50%;background:#22c55e;pointer-events:none;z-index:9999;transform:translate(-50%,-50%);transition:transform .08s ease,width .2s ease,height .2s ease,opacity .2s ease;mix-blend-mode:normal}
#cursor-ring{position:fixed;width:38px;height:38px;border-radius:50%;border:1.5px solid rgba(34,197,94,.4);pointer-events:none;z-index:9998;transform:translate(-50%,-50%);transition:transform .18s ease,width .2s ease,height .2s ease,opacity .3s ease}
#cursor.clicked{transform:translate(-50%,-50%) scale(.6)}
#cursor-ring.clicked{width:52px;height:52px;opacity:.2}

/* Scene system */
.scene{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .55s cubic-bezier(.4,0,.2,1)}
.scene.active{opacity:1;pointer-events:all}

/* Flash overlay */
#ovl{position:fixed;inset:0;background:#000;z-index:1000;opacity:0;pointer-events:none;transition:opacity .28s ease}
#ovl.on{opacity:1}

/* Progress line */
#adv{position:fixed;bottom:0;left:0;height:2px;background:linear-gradient(90deg,#16a34a,#22c55e);z-index:500;width:0}

/* Nav dots */
#nav{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:600}
.ndot{width:5px;height:5px;border-radius:3px;background:#1c1c1c;transition:all .4s ease;cursor:pointer!important}
.ndot:hover{background:#333}
.ndot.cur{background:#22c55e;width:20px}
.ndot.done{background:#166534;width:8px}

/* Click hint */
#hint{position:fixed;bottom:52px;right:28px;font-size:9px;color:#1e1e1e;font-weight:800;letter-spacing:.14em;text-transform:uppercase;z-index:600;transition:opacity .6s;display:flex;align-items:center;gap:8px}
#hint::before{content:'';width:18px;height:1px;background:#1e1e1e}

/* Shared ambient glow */
.glow{position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(34,197,94,.07) 0%,transparent 60%);pointer-events:none;animation:gp 6s ease-in-out infinite}
@keyframes gp{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}

/* Appear helpers */
.ap{opacity:0;transform:translateY(22px);transition:opacity .55s ease,transform .55s ease}
.ap.go{opacity:1;transform:translateY(0)}
.ap2{opacity:0;transition:opacity .55s ease}
.ap2.go{opacity:1}
.aps{opacity:0;transform:scale(.92);transition:opacity .65s ease,transform .65s ease}
.aps.go{opacity:1;transform:scale(1)}

/* â”€â”€ SCENE 0: SPLASH â”€â”€ */
#s0{background:#060606;flex-direction:column;text-align:center;overflow:hidden}
.splash-logo{font-size:clamp(90px,16vw,200px);font-weight:900;letter-spacing:-.06em;color:#22c55e;line-height:1}
.splash-brand{font-size:clamp(11px,1.4vw,16px);font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#1c1c1c;margin-top:16px}
.splash-tag{font-size:clamp(15px,2vw,24px);color:#2a2a2a;margin-top:28px;font-weight:600;line-height:1.6;max-width:480px}
.splash-tag em{color:#22c55e;font-style:normal}

/* â”€â”€ SCENE 1: STORY â”€â”€ */
#s1{background:#060606;flex-direction:column;align-items:flex-start;padding:0 10vw}
.sline{font-size:clamp(30px,5.5vw,76px);font-weight:900;letter-spacing:-.05em;line-height:1.08;margin-bottom:8px;color:#fff}
.sline em{color:#22c55e;font-style:normal}
.sline.grey{color:#111}

/* â”€â”€ SCENE 2 & 3: SPLIT LAYOUT â”€â”€ */
.split{width:100%;height:100%;display:flex;align-items:center;gap:5vw;padding:0 6vw}
.sl{flex:0 0 36%;display:flex;flex-direction:column;gap:14px}
.sr{flex:1;min-width:0}
.sc-label{font-size:9px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22c55e}
.sc-h{font-size:clamp(24px,3.8vw,52px);font-weight:900;letter-spacing:-.05em;line-height:1.08}
.sc-h em{color:#22c55e;font-style:normal}
.sc-sub{font-size:clamp(12px,1.3vw,15px);color:#444;line-height:1.85}
.role-tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:6px}
.rtag{padding:5px 13px;border-radius:100px;border:1px solid #1a1a1a;font-size:10px;color:#2a2a2a;font-weight:700;transition:all .35s ease}
.rtag.on{border-color:#22c55e;color:#22c55e;background:rgba(34,197,94,.06)}

/* Device frame */
.dev{border-radius:10px;overflow:hidden;box-shadow:0 24px 72px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.04);background:#0e0e0e}
.dev-bar{height:26px;background:#141414;display:flex;align-items:center;padding:0 11px;gap:5px;border-bottom:1px solid #0a0a0a}
.dd{width:8px;height:8px;border-radius:50%}
.dev-frame{height:360px;overflow:hidden}
.dev-frame iframe{width:150%;height:150%;border:none;transform:scale(.667);transform-origin:top left;pointer-events:none}

/* â”€â”€ SCENE 4: AI â”€â”€ */
#s4{flex-direction:column;gap:24px;padding:0 8vw;text-align:center}
.ai-shell{background:#0a0a0a;border:1px solid #141414;border-radius:14px;max-width:620px;width:100%;margin:0 auto;overflow:hidden;text-align:left}
.ai-topbar{height:34px;background:#0e0e0e;display:flex;align-items:center;padding:0 13px;gap:7px;border-bottom:1px solid #111}
.ai-topbar-label{flex:1;text-align:center;font-size:9px;color:#2a2a2a;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.ai-body{padding:16px 18px;min-height:200px;display:flex;flex-direction:column;gap:12px}
.ai-row{opacity:0;transform:translateY(8px);transition:opacity .4s ease,transform .4s ease}
.ai-row.show{opacity:1;transform:translateY(0)}
.ai-who{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:4px}
.ai-who.you{color:#22c55e}
.ai-who.bot{color:#818cf8}
.ai-txt{font-size:13px;line-height:1.72;color:#999;white-space:pre-wrap}
.ai-txt.you-txt{color:#555;font-size:12px}
.ai-cur{display:inline-block;width:2px;height:13px;background:#22c55e;margin-left:2px;vertical-align:middle;animation:blink .85s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

/* â”€â”€ SCENE 5: WHATSAPP â”€â”€ */
#s5{padding:0 6vw}
.wa-phone{width:300px;flex-shrink:0;border-radius:18px;overflow:hidden;box-shadow:0 24px 72px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.04);background:#e5ddd5;font-family:-apple-system,Helvetica,sans-serif}
.wa-hdr{background:#075e54;padding:12px 14px;display:flex;align-items:center;gap:10px}
.wa-av{width:36px;height:36px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;flex-shrink:0}
.wa-nm{font-size:13px;font-weight:700;color:#fff}
.wa-st{font-size:10px;color:rgba(255,255,255,.65)}
.wa-msgs{padding:10px;display:flex;flex-direction:column;gap:7px;min-height:280px;max-height:340px;overflow-y:auto}
.wa-b{padding:7px 10px 18px;border-radius:8px;font-size:12px;line-height:1.55;position:relative;opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s;max-width:88%;word-break:break-word;white-space:pre-line}
.wa-b.show{opacity:1;transform:translateY(0)}
.wa-b.me{background:#dcf8c6;align-self:flex-end;border-top-right-radius:0;color:#111}
.wa-b.them{background:#fff;align-self:flex-start;border-top-left-radius:0;color:#111}
.wa-ts{position:absolute;bottom:3px;right:8px;font-size:9px;color:#999}
.wa-typ{display:none;background:#fff;border-radius:8px;border-top-left-radius:0;padding:8px 12px;width:fit-content;align-items:center;gap:3px;margin:0 10px 6px}
.wa-typ.show{display:flex}
.wa-td{width:6px;height:6px;border-radius:50%;background:#bbb;animation:wab .9s infinite ease-in-out}
.wa-td:nth-child(2){animation-delay:.2s}.wa-td:nth-child(3){animation-delay:.4s}
@keyframes wab{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
.wa-vnote{display:flex;align-items:center;gap:8px;min-width:155px}
.wa-vplay{width:28px;height:28px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;flex-shrink:0}
.wa-wf{flex:1;display:flex;align-items:center;gap:2px;height:18px}
.wa-wb{border-radius:2px;background:rgba(0,0,0,.22);width:3px}
.wa-vd{font-size:10px;color:#999;margin-left:2px}

/* â”€â”€ SCENE 6: SOW â”€â”€ */
#s6{flex-direction:column;text-align:center;gap:14px}
.sow-n{font-size:clamp(100px,18vw,240px);font-weight:900;letter-spacing:-.07em;color:#22c55e;line-height:1}
.sow-w{font-size:clamp(22px,4.5vw,62px);font-weight:900;letter-spacing:-.05em;color:#fff}
.sow-d{font-size:clamp(12px,1.4vw,17px);color:#2a2a2a;line-height:1.8;max-width:400px}

/* â”€â”€ SCENE 7: NUMBERS â”€â”€ */
#s7{flex-direction:column;gap:16px}
.stats-head{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22c55e;text-align:center}
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;max-width:660px;width:100%}
.stat-cell{background:#090909;padding:36px 30px;display:flex;flex-direction:column;gap:8px;border:1px solid #0e0e0e}
.stat-cell:first-child{border-radius:14px 0 0 0}
.stat-cell:nth-child(2){border-radius:0 14px 0 0}
.stat-cell:nth-child(3){border-radius:0 0 0 14px}
.stat-cell:last-child{border-radius:0 0 14px 0}
.stat-n{font-size:clamp(46px,8vw,88px);font-weight:900;letter-spacing:-.05em;color:#22c55e;line-height:1;font-variant-numeric:tabular-nums}
.stat-l{font-size:11px;color:#2a2a2a;font-weight:700;letter-spacing:.06em;text-transform:uppercase}

/* â”€â”€ SCENE 8: CTA â”€â”€ */
#s8{flex-direction:column;text-align:center;gap:22px}
.cta-h{font-size:clamp(32px,6.5vw,96px);font-weight:900;letter-spacing:-.06em;line-height:1.04}
.cta-h em{color:#22c55e;font-style:normal}
.cta-s{font-size:clamp(13px,1.5vw,18px);color:#2a2a2a;line-height:1.85;max-width:460px}
.cta-b{padding:18px 56px;background:#22c55e;color:#000;font-family:inherit;font-size:15px;font-weight:900;border:none;border-radius:14px;cursor:pointer!important;letter-spacing:-.01em;position:relative}
.cta-b::before,.cta-b::after{content:'';position:absolute;inset:-10px;border-radius:22px;border:1.5px solid rgba(34,197,94,.25);animation:cta-pulse 2.4s ease-in-out infinite;pointer-events:none}
.cta-b::after{inset:-20px;border-radius:30px;border-color:rgba(34,197,94,.1);animation-delay:.8s}
@keyframes cta-pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.02)}}
.cta-b:hover{background:#16a34a}
.cta-note{font-size:9px;color:#1a1a1a;letter-spacing:.12em;text-transform:uppercase}
</style>
</head>
<body>

<div id="cursor"></div>
<div id="cursor-ring"></div>
<div id="ovl"></div>
<div id="adv"></div>
<div id="nav"></div>
<div id="hint">Click to continue</div>

<!-- â”€â”€ S0: SPLASH â”€â”€ -->
<div class="scene" id="s0">
  <div class="glow" style="top:-100px;left:-100px"></div>
  <div class="glow" style="bottom:-100px;right:-100px;animation-delay:3s"></div>
  <div style="position:relative;text-align:center;display:flex;flex-direction:column;align-items:center">
    <div class="splash-logo aps" id="s0a">EX3</div>
    <div class="splash-brand ap2" id="s0b">SAP SuccessFactors Recruiting</div>
    <div class="splash-tag ap" id="s0c">Everything your team needs.<br><em>On day one.</em></div>
  </div>
</div>

<!-- â”€â”€ S1: STORY â”€â”€ -->
<div class="scene" id="s1">
  <div style="padding:0 10vw;width:100%">
    <div class="sline ap" id="sl0">New client.</div>
    <div class="sline ap" id="sl1">Twelve thousand employees.</div>
    <div class="sline ap" id="sl2">Sixty days to go-live.</div>
    <div class="sline grey ap" id="sl3" style="margin-top:28px">One consultant.</div>
    <div class="sline grey ap" id="sl4"><em>This is what she uses.</em></div>
  </div>
</div>

<!-- â”€â”€ S2: PLATFORM â”€â”€ -->
<div class="scene" id="s2">
  <div class="split">
    <div class="sl">
      <div class="sc-label ap2" id="s2a">The platform guide</div>
      <div class="sc-h ap" id="s2b">Four roles.<br><em>One platform.</em></div>
      <div class="sc-sub ap" id="s2c">Every person on the project sees exactly what they need &mdash; and nothing they don't.</div>
      <div class="role-tags ap2" id="s2d">
        <div class="rtag" id="rt-rec">Recruiter</div>
        <div class="rtag" id="rt-hm">Hiring Manager</div>
        <div class="rtag" id="rt-cand">Candidate</div>
        <div class="rtag" id="rt-adm">Admin</div>
      </div>
    </div>
    <div class="sr">
      <div class="dev ap" id="s2e">
        <div class="dev-bar"><div class="dd" style="background:#ff5f56"></div><div class="dd" style="background:#ffbd2e"></div><div class="dd" style="background:#27c93f"></div></div>
        <div class="dev-frame"><iframe id="s2if" src="/"></iframe></div>
      </div>
    </div>
  </div>
</div>

<!-- â”€â”€ S3: STEP BY STEP â”€â”€ -->
<div class="scene" id="s3">
  <div class="split">
    <div class="sl">
      <div class="sc-label ap2" id="s3a">Step-by-step guide</div>
      <div class="sc-h ap" id="s3b">Every step.<br><em>No ambiguity.</em></div>
      <div class="sc-sub ap" id="s3c">Every process broken down to the individual action. Who does what, in what order. Before the client even asks the question.</div>
    </div>
    <div class="sr">
      <div class="dev ap" id="s3e">
        <div class="dev-bar"><div class="dd" style="background:#ff5f56"></div><div class="dd" style="background:#ffbd2e"></div><div class="dd" style="background:#27c93f"></div></div>
        <div class="dev-frame"><iframe id="s3if" src="/"></iframe></div>
      </div>
    </div>
  </div>
</div>

<!-- â”€â”€ S4: AI â”€â”€ -->
<div class="scene" id="s4">
  <div style="width:100%;max-width:640px;display:flex;flex-direction:column;gap:24px;padding:0 5vw">
    <div style="text-align:center">
      <div class="sc-label ap2" id="s4a" style="margin-bottom:10px">AI assistant</div>
      <div class="sc-h ap" id="s4b" style="font-size:clamp(26px,4.5vw,60px);text-align:center">Ask anything.<br><em>Get an answer.</em></div>
    </div>
    <div class="ai-shell ap" id="s4c">
      <div class="ai-topbar">
        <div class="dd" style="background:#ff5f56"></div><div class="dd" style="background:#ffbd2e"></div><div class="dd" style="background:#27c93f"></div>
        <div class="ai-topbar-label">EX3 AI Assistant</div>
      </div>
      <div class="ai-body" id="s4body"></div>
    </div>
  </div>
</div>

<!-- â”€â”€ S5: WHATSAPP â”€â”€ -->
<div class="scene" id="s5">
  <div class="split">
    <div class="sl">
      <div class="sc-label ap2" id="s5a">WhatsApp AI bot</div>
      <div class="sc-h ap" id="s5b" style="font-size:clamp(26px,4.5vw,58px)"><em>6:07am.</em><br>Back of a cab.</div>
      <div class="sc-sub ap" id="s5c">She records a voice note on WhatsApp. The answer lands before she gets out of the car.<br><br>No app. No login. Around the clock.</div>
    </div>
    <div style="flex-shrink:0">
      <div class="wa-phone ap" id="s5d">
        <div class="wa-hdr">
          <div class="wa-av">EX3</div>
          <div><div class="wa-nm">EX3 AI Assistant</div><div class="wa-st">WhatsApp Â· usually replies instantly</div></div>
        </div>
        <div class="wa-msgs" id="s5msgs"></div>
        <div class="wa-typ" id="s5typ"><div class="wa-td"></div><div class="wa-td"></div><div class="wa-td"></div></div>
      </div>
    </div>
  </div>
</div>

<!-- â”€â”€ S6: SOW â”€â”€ -->
<div class="scene" id="s6">
  <div class="glow"></div>
  <div style="position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px">
    <div class="sc-label ap2" id="s6a" style="margin-bottom:6px">SOW builder</div>
    <div class="sow-n aps" id="s6b">45</div>
    <div class="sow-w ap" id="s6c">seconds.</div>
    <div class="sow-d ap" id="s6d">A complete Statement of Work &mdash; structured, professional, client-ready. Generated and delivered without leaving the page.</div>
  </div>
</div>

<!-- â”€â”€ S7: NUMBERS â”€â”€ -->
<div class="scene" id="s7">
  <div style="display:flex;flex-direction:column;gap:18px;align-items:center">
    <div class="stats-head ap2" id="s7a">Three weeks in</div>
    <div class="stats-grid ap" id="s7b">
      <div class="stat-cell"><div class="stat-n" id="sn0">0</div><div class="stat-l">AI queries this week</div></div>
      <div class="stat-cell"><div class="stat-n" id="sn1">0<span style="font-size:.42em">hrs</span></div><div class="stat-l">saved per consultant</div></div>
      <div class="stat-cell"><div class="stat-n" id="sn2">0<span style="font-size:.42em">%</span></div><div class="stat-l">questions answered</div></div>
      <div class="stat-cell"><div class="stat-n" id="sn3">0</div><div class="stat-l">active engagements</div></div>
    </div>
  </div>
</div>

<!-- â”€â”€ S8: CTA â”€â”€ -->
<div class="scene" id="s8">
  <div class="glow" style="top:-100px;left:-100px"></div>
  <div class="glow" style="bottom:-100px;right:-100px;animation-delay:3s"></div>
  <div style="position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;gap:20px">
    <div class="cta-h ap" id="s8a">Everything your team needs.<br><em>On day one.</em></div>
    <div class="cta-s ap" id="s8b">Training guide, AI assistant, WhatsApp bot, consultant portal, and SOW builder &mdash; the complete SAP SuccessFactors Recruiting implementation toolkit.</div>
    <div style="position:relative;margin-top:8px" class="ap" id="s8c">
      <button class="cta-b" onclick="window.location.href='mailto:hello@ex3.io'">Book a demo call</button>
    </div>
    <div class="cta-note ap2" id="s8d">No login required &nbsp;Â·&nbsp; Works on day one &nbsp;Â·&nbsp; Built for SAP SuccessFactors Recruiting</div>
  </div>
</div>

<script>
// â”€â”€ Cursor â”€â”€
var cur$ = document.getElementById('cursor'), ring$ = document.getElementById('cursor-ring');
document.addEventListener('mousemove', function(e){
  cur$.style.left = e.clientX + 'px'; cur$.style.top = e.clientY + 'px';
  ring$.style.left = e.clientX + 'px'; ring$.style.top = e.clientY + 'px';
});
document.addEventListener('mousedown', function(){ cur$.classList.add('clicked'); ring$.classList.add('clicked'); });
document.addEventListener('mouseup', function(){ cur$.classList.remove('clicked'); ring$.classList.remove('clicked'); });

// â”€â”€ Scene config â”€â”€
var SCENES = [
  {id:'s0', dur:4800},
  {id:'s1', dur:7000},
  {id:'s2', dur:13000},
  {id:'s3', dur:10000},
  {id:'s4', dur:14000},
  {id:'s5', dur:18000},
  {id:'s6', dur:7000},
  {id:'s7', dur:10000},
  {id:'s8', dur:0}
];

var curIdx = 0, advTimer = null;
var s2t = [], s5t = [], s4t = [];

// â”€â”€ Nav â”€â”€
function renderNav(){
  document.getElementById('nav').innerHTML = SCENES.map(function(s,i){
    var c = i < curIdx ? 'ndot done' : i === curIdx ? 'ndot cur' : 'ndot';
    return '<div class="' + c + '" onclick="jumpTo(' + i + ')"></div>';
  }).join('');
}

// â”€â”€ Advance bar â”€â”€
function startBar(ms){
  var b = document.getElementById('adv');
  b.style.transition = 'none'; b.style.width = '0';
  b.offsetWidth; // reflow
  b.style.transition = 'width ' + ms + 'ms linear';
  b.style.width = '100%';
}
function stopBar(){
  var b = document.getElementById('adv');
  b.style.transition = 'none'; b.style.width = '0';
}

// â”€â”€ Goto â”€â”€
function killTimers(){
  clearTimeout(advTimer); advTimer = null;
  stopBar();
  s2t.forEach(clearTimeout); s2t = [];
  s4t.forEach(clearTimeout); s4t = [];
  s5t.forEach(clearTimeout); s5t = [];
}

function jumpTo(idx){
  killTimers();
  document.getElementById(SCENES[curIdx].id).classList.remove('active');
  curIdx = idx;
  activateScene(curIdx);
}

function next(){
  if(curIdx >= SCENES.length - 1) return;
  var ovl = document.getElementById('ovl');
  ovl.classList.add('on');
  setTimeout(function(){
    document.getElementById(SCENES[curIdx].id).classList.remove('active');
    killTimers();
    curIdx++;
    activateScene(curIdx);
    setTimeout(function(){ ovl.classList.remove('on'); }, 60);
  }, 260);
}

function activateScene(idx){
  renderNav();
  var s = SCENES[idx];
  var el = document.getElementById(s.id);
  el.classList.add('active');
  var fn = window['enter_' + s.id];
  if(fn) setTimeout(fn, 80);
  if(s.dur > 0){
    startBar(s.dur);
    advTimer = setTimeout(next, s.dur);
  }
}

// â”€â”€ Click / keyboard â”€â”€
document.addEventListener('click', function(e){
  if(e.target.classList.contains('cta-b')) return;
  if(e.target.classList.contains('ndot')) return;
  next();
});
document.addEventListener('keydown', function(e){
  if(e.key === 'ArrowRight' || e.key === ' ') next();
  if(e.key === 'ArrowLeft' && curIdx > 0) jumpTo(curIdx - 1);
});

// â”€â”€ Helper â”€â”€
function go(id){ var e = document.getElementById(id); if(e){ e.classList.add('go'); } }
function t(ms, fn, arr){ var id = setTimeout(fn, ms); if(arr) arr.push(id); return id; }

// â”€â”€ Scene enters â”€â”€

window.enter_s0 = function(){
  t(100, function(){ go('s0a'); });
  t(500, function(){ go('s0b'); });
  t(1100, function(){ go('s0c'); });
};

window.enter_s1 = function(){
  ['sl0','sl1','sl2','sl3','sl4'].forEach(function(id, i){
    t(150 + i * 750, function(){ go(id); });
  });
};

window.enter_s2 = function(){
  t(80,  function(){ go('s2a'); });
  t(160, function(){ go('s2b'); });
  t(340, function(){ go('s2c'); });
  t(520, function(){ go('s2d'); go('s2e'); });

  var roles = ['rec','hm','cand','adm'];
  var roleMap = {rec:'rt-rec',hm:'rt-hm',cand:'rt-cand',adm:'rt-adm'};
  function setRole(r){
    roles.forEach(function(x){ document.getElementById(roleMap[x]).classList.remove('on'); });
    document.getElementById(roleMap[r]).classList.add('on');
    try { document.getElementById('s2if').contentWindow.postMessage({action:'setRole',role:r},'*'); } catch(e){}
  }
  roles.forEach(function(r, i){
    t(1200 + i * 2800, function(){ setRole(r); }, s2t);
  });
};

window.enter_s3 = function(){
  t(80,  function(){ go('s3a'); });
  t(160, function(){ go('s3b'); });
  t(340, function(){ go('s3c'); });
  t(520, function(){ go('s3e'); });
  t(900, function(){
    try { document.getElementById('s3if').contentWindow.postMessage({action:'setRole',role:'rec'},'*'); } catch(e){}
  });
  t(2200, function(){
    try { document.getElementById('s3if').contentWindow.postMessage({action:'openTaskDetail',taskId:'post-job'},'*'); } catch(e){}
  });
};

var AI_Q = 'How do I set up an offer letter template?';
var AI_A = 'Go to Admin \u2192 Offer Management \u2192 Templates and click \u201cNew Template\u201d.\\n\\nUse merge tags like {candidate_name} and {job_title} for dynamic fields, then set your approval chain \u2014 who needs to approve before the offer is sent.\\n\\nOnce active, recruiters see a \u201cSend Offer\u201d button as soon as a candidate reaches the Offer stage.';

window.enter_s4 = function(){
  t(80, function(){ go('s4a'); });
  t(160, function(){ go('s4b'); });
  t(420, function(){ go('s4c'); });

  var body = document.getElementById('s4body');
  body.innerHTML = '';

  var qRow = document.createElement('div');
  qRow.className = 'ai-row';
  qRow.innerHTML = '<div class="ai-who you">You</div><div class="ai-txt you-txt" id="qtxt"></div>';
  body.appendChild(qRow);

  t(700, function(){
    qRow.classList.add('show');
    var qtxt = document.getElementById('qtxt');
    var i = 0;
    var iv = setInterval(function(){
      qtxt.textContent = AI_Q.slice(0, ++i);
      if(i >= AI_Q.length) clearInterval(iv);
    }, 38);
    s4t.push(iv);
  }, s4t);

  t(700 + AI_Q.length * 38 + 800, function(){
    var aRow = document.createElement('div');
    aRow.className = 'ai-row';
    aRow.innerHTML = '<div class="ai-who bot">EX3 AI</div><div class="ai-txt" id="atxt"><span class="ai-cur"></span></div>';
    body.appendChild(aRow);
    aRow.classList.add('show');

    t(1000, function(){
      var atxt = document.getElementById('atxt');
      atxt.innerHTML = '';
      var j = 0;
      var iv2 = setInterval(function(){
        j += 4;
        atxt.textContent = AI_A.slice(0, j);
        body.scrollTop = body.scrollHeight;
        if(j >= AI_A.length){ atxt.textContent = AI_A; clearInterval(iv2); }
      }, 22);
      s4t.push(iv2);
    }, s4t);
  }, s4t);
};

var WA_CHAT = [
  {from:'me', voice:true, ts:'06:07', delay:500},
  {from:'them', text:"The Send Offer button only appears once three things are in place:\\n\\n1\ufe0f\u20e3 Candidate is in the *Offer* stage\\n2\ufe0f\u20e3 Job has an active offer letter template\\n3\ufe0f\u20e3 You have the *Offer Manager* permission\\n\\nWhich would you like to check first?", ts:'06:07', delay:9000},
  {from:'me', text:'Probably permissions \u2014 how do I check?', ts:'06:08', delay:14000},
  {from:'them', text:"Go to *Admin \u2192 User Management*, find your name, check your assigned role.\\n\\nYou need either the *Offer Manager* role or a custom role with *Create Offer* permission.\\n\\nYour SR admin can add it in about 2 minutes.", ts:'06:08', delay:18500}
];
var WH = [8,14,6,18,10,22,7,16,12,20,8,14,6,18,10,22,7,16,12,20,8,14,6,18,10];

window.enter_s5 = function(){
  t(80,  function(){ go('s5a'); });
  t(160, function(){ go('s5b'); });
  t(340, function(){ go('s5c'); });
  t(480, function(){ go('s5d'); });

  var msgs = document.getElementById('s5msgs');
  msgs.innerHTML = '';
  var typ = document.getElementById('s5typ');
  typ.classList.remove('show');

  WA_CHAT.forEach(function(m, i){
    t(m.delay, function(){
      if(m.voice){
        var b = document.createElement('div');
        b.className = 'wa-b me';
        b.innerHTML = '<div class="wa-vnote"><div class="wa-vplay">\u25b6</div><div class="wa-wf">' +
          WH.map(function(h){ return '<div class="wa-wb" style="height:' + h + 'px"></div>'; }).join('') +
          '</div><span class="wa-vd">0:12</span></div><div class="wa-ts">' + m.ts + '</div>';
        msgs.appendChild(b);
        t(40, function(){ b.classList.add('show'); });
        t(600, function(){ typ.classList.add('show'); });
      } else {
        typ.classList.remove('show');
        t(200, function(){
          var b = document.createElement('div');
          b.className = 'wa-b ' + m.from;
          var html = m.text.replace(/\*(.*?)\*/g, '<strong>$1</strong>');
          b.innerHTML = html + '<div class="wa-ts">' + m.ts + '</div>';
          msgs.appendChild(b);
          msgs.scrollTop = msgs.scrollHeight;
          t(40, function(){ b.classList.add('show'); });
          if(i < WA_CHAT.length - 1 && WA_CHAT[i+1].from === 'them'){
            t(500, function(){ typ.classList.add('show'); });
          }
        });
      }
    }, s5t);
  });
};

window.enter_s6 = function(){
  t(80,  function(){ go('s6a'); });
  t(200, function(){ go('s6b'); });
  t(700, function(){ go('s6c'); });
  t(1100,function(){ go('s6d'); });
};

window.enter_s7 = function(){
  t(80, function(){ go('s7a'); });
  t(250, function(){
    go('s7b');
    var targets = [247, 4.2, 94, 12];
    var suffixes = ['','hrs','%',''];
    targets.forEach(function(tgt, i){
      var start = Date.now(), dur = 2200;
      var el = document.getElementById('sn' + i);
      var iv = setInterval(function(){
        var p = Math.min(1, (Date.now()-start)/dur);
        var ease = 1 - Math.pow(1-p, 3);
        var v = tgt * ease;
        var disp = tgt % 1 !== 0 ? v.toFixed(1) : Math.round(v);
        el.innerHTML = disp + (suffixes[i] ? '<span style="font-size:.42em">' + suffixes[i] + '</span>' : '');
        if(p >= 1) clearInterval(iv);
      }, 28);
    });
  });
};

window.enter_s8 = function(){
  t(100, function(){ go('s8a'); });
  t(350, function(){ go('s8b'); });
  t(600, function(){ go('s8c'); });
  t(850, function(){ go('s8d'); });
};

// â”€â”€ Start â”€â”€
activateScene(0);
</script>
</body>
</html>`);
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// /demo3  &mdash; Advanced guided product tour with cursor, zoom, spotlight & voice
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/demo3', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SAP SuccessFactors Recruiting &mdash; Platform Tour</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#050505;color:#fff;font-family:\'Sora\',sans-serif}

/* â”€â”€ Layout â”€â”€ */
#layout{display:flex;height:100vh;overflow:hidden}

/* â”€â”€ Chapter nav â”€â”€ */
#chnav{width:220px;flex-shrink:0;background:#050505;border-right:1px solid #0d0d0d;display:flex;flex-direction:column;padding:24px 0;z-index:100;position:relative}
#chnav-logo{padding:0 22px 28px;font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#22c55e}
#chnav-logo span{color:#333}
.chap{padding:11px 22px;cursor:pointer;transition:background .2s;border-left:2px solid transparent}
.chap:hover{background:rgba(255,255,255,.02)}
.chap.active{border-left-color:#22c55e;background:rgba(34,197,94,.04)}
.chap-num{font-size:8px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#1c1c1c;margin-bottom:3px;transition:color .3s}
.chap.active .chap-num{color:#166534}
.chap-title{font-size:12px;font-weight:700;color:#1c1c1c;transition:color .3s;line-height:1.3}
.chap.active .chap-title{color:#e5e5e5}
.chap-steps{display:flex;gap:4px;margin-top:7px}
.cs{width:14px;height:2px;border-radius:2px;background:#111;transition:all .3s}
.cs.done{background:#166534}
.cs.cur{background:#22c55e;width:22px}

#chnav-bottom{margin-top:auto;padding:0 22px 8px}
.vol-btn{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;background:transparent;border:1px solid #111;color:#2a2a2a;font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:all .2s;width:100%}
.vol-btn:hover{border-color:#1a1a1a;color:#333}
.vol-btn.muted{border-color:#1f2d1f;color:#22c55e}

/* â”€â”€ Main area â”€â”€ */
#main{flex:1;min-width:0;display:flex;flex-direction:column;background:#050505;position:relative}

/* â”€â”€ Browser chrome â”€â”€ */
#browser-outer{flex:1;min-height:0;padding:14px 14px 0;display:flex;flex-direction:column}
#browser{flex:1;min-height:0;border-radius:10px 10px 0 0;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.05);position:relative}
#bbar{height:36px;flex-shrink:0;background:#111;display:flex;align-items:center;padding:0 14px;gap:10px;border-bottom:1px solid #0a0a0a}
.bdd{width:9px;height:9px;border-radius:50%}
#burl{flex:1;margin:0 12px;height:20px;background:#0a0a0a;border-radius:5px;display:flex;align-items:center;padding:0 10px;font-size:10px;color:#2a2a2a;font-weight:600;letter-spacing:.02em;overflow:hidden;white-space:nowrap}
#burl-ico{width:8px;height:8px;border-radius:50%;background:#166534;margin-right:6px;flex-shrink:0}

/* â”€â”€ Frame area â”€â”€ */
#frame-area{flex:1;min-height:0;position:relative;overflow:hidden;background:#fff}
#live-frame{position:absolute;inset:0;width:100%;height:100%;border:none;transition:transform .9s cubic-bezier(.4,0,.2,1)}

/* â”€â”€ Spotlight overlay (above iframe, below cursor) â”€â”€ */
#spotlight{position:absolute;inset:0;pointer-events:none;z-index:20;opacity:0;transition:opacity .6s ease}

/* â”€â”€ Fake cursor â”€â”€ */
#fc-wrap{position:absolute;inset:0;pointer-events:none;z-index:30;overflow:hidden}
#fc{position:absolute;width:0;height:0;transition:left .7s cubic-bezier(.4,0,.2,1),top .7s cubic-bezier(.4,0,.2,1)}
#fc-arrow{position:absolute;top:0;left:0;pointer-events:none}
#fc-ring{position:absolute;width:32px;height:32px;border-radius:50%;border:1.5px solid rgba(34,197,94,.5);top:-16px;left:-16px;pointer-events:none;transform:scale(1);transition:transform .2s ease,opacity .2s ease}
#fc.click-anim #fc-ring{transform:scale(1.8);opacity:0}
#fc-click-ripple{position:absolute;width:20px;height:20px;border-radius:50%;background:rgba(34,197,94,.25);top:-10px;left:-10px;pointer-events:none;transform:scale(0);opacity:0}
#fc.click-anim #fc-click-ripple{animation:ripple-out .4s ease-out forwards}
@keyframes ripple-out{0%{transform:scale(0);opacity:.8}100%{transform:scale(2.5);opacity:0}}

/* â”€â”€ Card scenes (fullscreen takeovers) â”€â”€ */
#card-overlay{position:fixed;inset:0;background:#050505;z-index:500;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .5s ease}
#card-overlay.active{opacity:1;pointer-events:all}
#card-inner{text-align:center;position:relative}
.card-chap{font-size:9px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22c55e;margin-bottom:20px;opacity:0;transform:translateY(12px);transition:all .5s .1s ease}
.card-hl{font-size:clamp(40px,7vw,96px);font-weight:900;letter-spacing:-.06em;line-height:1.04;opacity:0;transform:translateY(22px);transition:all .6s .25s ease}
.card-hl em{color:#22c55e;font-style:normal}
.card-sub{font-size:clamp(13px,1.5vw,18px);color:#2a2a2a;line-height:1.8;max-width:480px;margin:20px auto 0;opacity:0;transition:all .5s .55s ease}
#card-overlay.go .card-chap,.card-overlay.go .card-hl,.card-overlay.go .card-sub{opacity:1;transform:translateY(0)}
#card-overlay.go .card-hl{opacity:1;transform:translateY(0)}
#card-overlay.go .card-chap{opacity:1;transform:translateY(0)}
#card-overlay.go .card-sub{opacity:1}
.card-glow{position:absolute;width:600px;height:600px;background:radial-gradient(circle,rgba(34,197,94,.06) 0%,transparent 65%);pointer-events:none;animation:gp 5s ease-in-out infinite}
@keyframes gp{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.1)}}
#card-progress{position:absolute;bottom:0;left:0;height:2px;background:linear-gradient(90deg,#16a34a,#22c55e);transition:width 0s linear}

/* â”€â”€ Narration bar â”€â”€ */
#nar{position:absolute;bottom:0;left:220px;right:0;z-index:400;pointer-events:none}
#nar-inner{background:linear-gradient(to top,rgba(5,5,5,.98) 0%,rgba(5,5,5,.85) 60%,transparent 100%);padding:18px 24px 16px;display:flex;flex-direction:column;gap:8px}
#nar-words{font-size:13px;line-height:1.75;color:#3a3a3a;min-height:46px;max-width:860px}
#nar-words .w{transition:color .15s,opacity .15s}
#nar-words .w.lit{color:#c4c4c4}
#nar-words .w.done{color:#444}
#nar-controls{display:flex;align-items:center;gap:12px;pointer-events:all}
#nar-pb{flex:1;height:2px;background:#111;border-radius:2px;overflow:hidden}
#nar-pb-fill{height:100%;background:linear-gradient(90deg,#166534,#22c55e);width:0;transition:width .15s linear;border-radius:2px}
.nar-btn{background:transparent;border:1px solid #151515;color:#2a2a2a;font-family:inherit;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:6px 14px;border-radius:6px;cursor:pointer;transition:all .2s}
.nar-btn:hover{border-color:#222;color:#444}
.nar-btn.next-ready{border-color:#22c55e;color:#22c55e;animation:pulse-next 1.8s ease-in-out infinite}
@keyframes pulse-next{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.4)}50%{box-shadow:0 0 0 6px rgba(34,197,94,0)}}
#bars{display:flex;align-items:center;gap:2px;height:16px;flex-shrink:0}
#bars .b{width:2px;border-radius:2px;background:#1a1a1a;height:100%;transition:height .2s}
#bars.speaking .b:nth-child(1){animation:bh 1.1s .0s ease-in-out infinite}
#bars.speaking .b:nth-child(2){animation:bh 1.1s .15s ease-in-out infinite}
#bars.speaking .b:nth-child(3){animation:bh 1.1s .3s ease-in-out infinite}
#bars.speaking .b:nth-child(4){animation:bh 1.1s .45s ease-in-out infinite}
@keyframes bh{0%,100%{height:3px;background:#1a1a1a}50%{height:14px;background:#22c55e}}

/* â”€â”€ Start screen â”€â”€ */
#start-screen{position:fixed;inset:0;z-index:999;background:#050505;display:flex;align-items:center;justify-content:center;flex-direction:column;cursor:pointer;transition:opacity .6s ease;overflow:hidden}
#start-screen.fade{opacity:0;pointer-events:none}
#start-screen::before{content:\'\';position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(34,197,94,.07) 0%,transparent 65%);animation:ss-glow 5s ease-in-out infinite;pointer-events:none}
@keyframes ss-glow{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.2);opacity:1}}
.ss-eye{font-size:10px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22c55e;margin-bottom:36px;position:relative}
.ss-h{font-size:clamp(38px,5.5vw,72px);font-weight:900;letter-spacing:-.05em;text-align:center;line-height:1.04;max-width:700px;position:relative}
.ss-h em{color:#22c55e;font-style:normal}
.ss-sub{margin-top:20px;font-size:14px;color:#444;text-align:center;max-width:440px;line-height:1.8;position:relative}
.ss-cta{margin-top:44px;padding:16px 52px;background:#22c55e;color:#000;font-family:inherit;font-size:13px;font-weight:900;letter-spacing:.01em;border:none;border-radius:12px;cursor:pointer;position:relative;transition:transform .15s,opacity .15s}
.ss-cta:hover{transform:translateY(-2px);opacity:.92}
.ss-note{margin-top:14px;font-size:10px;color:#1c1c1c;position:relative}

/* â”€â”€ Flash â”€â”€ */
#flash{position:fixed;inset:0;background:#000;z-index:1000;opacity:0;pointer-events:none;transition:opacity .25s ease}
#flash.on{opacity:1}

/* â”€â”€ WhatsApp panel (replaces iframe) â”€â”€ */
#wa-panel{position:absolute;inset:0;background:#e5ddd5;display:none;flex-direction:column;z-index:10}
#wa-panel.show{display:flex}
.wa-hdr{background:#075e54;padding:13px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.wa-av{width:38px;height:38px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;flex-shrink:0}
.wa-nm{font-size:14px;font-weight:700;color:#fff}
.wa-st{font-size:10px;color:rgba(255,255,255,.65)}
.wa-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-family:-apple-system,Helvetica,sans-serif}
.wa-b{padding:8px 11px 20px;border-radius:8px;font-size:13px;line-height:1.55;position:relative;opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s;max-width:82%;word-break:break-word;white-space:pre-line}
.wa-b.show{opacity:1;transform:translateY(0)}
.wa-b.me{background:#dcf8c6;align-self:flex-end;border-top-right-radius:0;color:#111}
.wa-b.them{background:#fff;align-self:flex-start;border-top-left-radius:0;color:#111}
.wa-ts{position:absolute;bottom:4px;right:9px;font-size:9px;color:#999;font-family:-apple-system,Helvetica,sans-serif}
.wa-typ{display:none;background:#fff;border-radius:8px;border-top-left-radius:0;padding:9px 13px;width:fit-content;align-items:center;gap:4px;margin:0 12px 6px}
.wa-typ.show{display:flex}
.wa-td{width:6px;height:6px;border-radius:50%;background:#bbb;animation:wab .9s infinite ease-in-out}
.wa-td:nth-child(2){animation-delay:.2s}.wa-td:nth-child(3){animation-delay:.4s}
@keyframes wab{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
/* â”€â”€ Recording scene â”€â”€ */
#wa-rec-scene{position:absolute;inset:0;background:#0a0a0a;display:none;flex-direction:column;align-items:center;justify-content:center;z-index:20;transition:opacity .5s ease}
#wa-rec-scene.show{display:flex}
.rec-time{font-size:56px;font-weight:900;color:#fff;letter-spacing:-.04em;font-family:\'Sora\',sans-serif}
.rec-info{font-size:12px;color:#444;margin-top:6px;letter-spacing:.04em}
.rec-row{display:flex;align-items:center;gap:14px;margin-top:28px}
.rec-dot{width:11px;height:11px;border-radius:50%;background:#ef4444;animation:rdot 1s ease-in-out infinite}
@keyframes rdot{0%,100%{opacity:1}50%{opacity:.25}}
.rec-wave{display:flex;align-items:center;gap:3px}
.rec-wbar{width:3px;background:#22c55e;border-radius:2px;animation:rwh .85s ease-in-out infinite}
.rec-wbar:nth-child(1){height:5px;animation-delay:.0s}
.rec-wbar:nth-child(2){height:14px;animation-delay:.1s}
.rec-wbar:nth-child(3){height:8px;animation-delay:.2s}
.rec-wbar:nth-child(4){height:20px;animation-delay:.3s}
.rec-wbar:nth-child(5){height:10px;animation-delay:.4s}
.rec-wbar:nth-child(6){height:16px;animation-delay:.5s}
.rec-wbar:nth-child(7){height:6px;animation-delay:.6s}
.rec-wbar:nth-child(8){height:18px;animation-delay:.7s}
@keyframes rwh{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
.rec-label{font-size:10px;color:#ef4444;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-top:20px}
.wa-vnote{display:flex;align-items:center;gap:8px;min-width:160px}
.wa-vplay{width:28px;height:28px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;flex-shrink:0}
.wa-wf{flex:1;display:flex;align-items:center;gap:2px;height:18px}
.wa-wb{border-radius:2px;background:rgba(0,0,0,.2);width:3px}
.wa-vd{font-size:10px;color:#999;margin-left:2px;font-family:-apple-system,Helvetica,sans-serif}

/* â”€â”€ Analytics panel (replaces iframe) â”€â”€ */
#an-panel{position:absolute;inset:0;background:#080808;display:none;flex-direction:column;z-index:10;padding:28px}
#an-panel.show{display:flex}
.an-hd{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22c55e;margin-bottom:20px}
.an-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.an-kpi{background:#0d0d0d;border:1px solid #111;border-radius:10px;padding:20px 18px}
.an-kn{font-size:clamp(32px,4vw,52px);font-weight:900;letter-spacing:-.04em;color:#22c55e;font-variant-numeric:tabular-nums}
.an-kl{font-size:10px;color:#2a2a2a;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-top:6px}
.an-chart-row{display:flex;gap:12px;flex:1;min-height:0}
.an-bar-chart{flex:1;background:#0d0d0d;border:1px solid #111;border-radius:10px;padding:20px;display:flex;flex-direction:column}
.an-chart-title{font-size:9px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#2a2a2a;margin-bottom:16px}
.an-bars{flex:1;display:flex;align-items:flex-end;gap:8px}
.an-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px}
.an-bar-fill{width:100%;border-radius:4px 4px 0 0;background:linear-gradient(to top,#166534,#22c55e);transition:height 1.2s cubic-bezier(.4,0,.2,1);height:0}
.an-bar-lbl{font-size:8px;color:#222;font-weight:700}
.an-top{width:280px;background:#0d0d0d;border:1px solid #111;border-radius:10px;padding:20px}
.an-top-title{font-size:9px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#2a2a2a;margin-bottom:14px}
.an-q-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #0d0d0d;opacity:0;transform:translateX(-8px);transition:all .4s ease}
.an-q-row.show{opacity:1;transform:translateX(0)}
.an-q-txt{flex:1;font-size:11px;color:#333;line-height:1.4}
.an-q-pct{font-size:11px;font-weight:800;color:#22c55e;flex-shrink:0}
</style>
</head>
<body>

<div id="start-screen" onclick="beginDemo()">
  <div class="ss-eye">EX3 SAP SuccessFactors Recruiting</div>
  <h1 class="ss-h">The platform your team<br><em>actually uses.</em></h1>
  <p class="ss-sub">Training guide Â· AI assistant Â· WhatsApp bot Â· Consultant portal Â· Analytics</p>
  <button class="ss-cta">Start Tour</button>
  <div class="ss-note">Voice narration &middot; 4 chapters &middot; ~3 minutes</div>
</div>

<div id="flash"></div>

<!-- â”€â”€ Card overlay for chapter transitions â”€â”€ -->
<div id="card-overlay">
  <div class="card-glow" style="top:-80px;left:-80px"></div>
  <div class="card-glow" style="bottom:-80px;right:-80px;animation-delay:2.5s"></div>
  <div id="card-inner">
    <div class="card-chap" id="card-chap"></div>
    <div class="card-hl" id="card-hl"></div>
    <div class="card-sub" id="card-sub"></div>
  </div>
  <div id="card-progress"></div>
</div>

<div id="layout">

  <!-- â”€â”€ Chapter nav â”€â”€ -->
  <div id="chnav">
    <div id="chnav-logo">EX3 <span>/ SR Guide</span></div>
    <div id="chap-list"></div>
    <div id="chnav-bottom">
      <button class="vol-btn" id="vol-btn" onclick="toggleMute()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
        <span id="vol-txt">Voice On</span>
      </button>
    </div>
  </div>

  <!-- â”€â”€ Main â”€â”€ -->
  <div id="main">
    <div id="browser-outer">
      <div id="browser">
        <div id="bbar">
          <div class="bdd" style="background:#ff5f56"></div>
          <div class="bdd" style="background:#ffbd2e"></div>
          <div class="bdd" style="background:#27c93f"></div>
          <div id="burl"><div id="burl-ico"></div><span id="burl-txt">ex3-guide.railway.app</span></div>
        </div>
        <div id="frame-area">
          <iframe id="live-frame" src="/"></iframe>

          <!-- WhatsApp panel -->
          <div id="wa-panel">
            <div class="wa-hdr">
              <div class="wa-av">EX3</div>
              <div><div class="wa-nm">EX3 AI Assistant</div><div class="wa-st">WhatsApp Â· usually replies instantly</div></div>
            </div>
            <div class="wa-msgs" id="wa-msgs"></div>
            <div class="wa-typ" id="wa-typ"><div class="wa-td"></div><div class="wa-td"></div><div class="wa-td"></div></div>
            <div id="wa-rec-scene">
              <div class="rec-time">06:07</div>
              <div class="rec-info">En route to client site</div>
              <div class="rec-row">
                <div class="rec-dot"></div>
                <div class="rec-wave">
                  <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
                  <div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div><div class="rec-wbar"></div>
                </div>
              </div>
              <div class="rec-label">Recording</div>
            </div>
          </div>

          <!-- Analytics panel -->
          <div id="an-panel">
            <div class="an-hd">Analytics &amp; Insights</div>
            <div class="an-kpis">
              <div class="an-kpi"><div class="an-kn" id="an-k1">0</div><div class="an-kl">AI queries this week</div></div>
              <div class="an-kpi"><div class="an-kn" id="an-k2">0<span style="font-size:.45em">hrs</span></div><div class="an-kl">saved per consultant</div></div>
              <div class="an-kpi"><div class="an-kn" id="an-k3">0<span style="font-size:.45em">%</span></div><div class="an-kl">questions answered</div></div>
              <div class="an-kpi"><div class="an-kn" id="an-k4">0</div><div class="an-kl">active engagements</div></div>
            </div>
            <div class="an-chart-row">
              <div class="an-bar-chart">
                <div class="an-chart-title">Queries by day</div>
                <div class="an-bars" id="an-bars"></div>
              </div>
              <div class="an-top">
                <div class="an-top-title">Top questions</div>
                <div id="an-qs"></div>
              </div>
            </div>
          </div>

          <!-- Spotlight overlay -->
          <div id="spotlight"></div>

          <!-- Fake cursor -->
          <div id="fc-wrap">
            <div id="fc">
              <div id="fc-ring"></div>
              <div id="fc-click-ripple"></div>
              <svg id="fc-arrow" width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M4 2L18 10.5L11.5 12L8.5 19L4 2Z" fill="white" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>

        </div><!-- /frame-area -->
      </div><!-- /browser -->
    </div><!-- /browser-outer -->

    <!-- â”€â”€ Narration bar â”€â”€ -->
    <div id="nar">
      <div id="nar-inner">
        <div id="nar-words"></div>
        <div id="nar-controls">
          <div id="bars"><div class="b"></div><div class="b"></div><div class="b"></div><div class="b"></div></div>
          <div id="nar-pb"><div id="nar-pb-fill"></div></div>
          <button class="nar-btn" onclick="prevStep()">&#8592; Prev</button>
          <button class="nar-btn" onclick="replayAudio()">&#8635; Replay</button>
          <button class="nar-btn" id="next-btn" onclick="nextStep()">Next &#8594;</button>
        </div>
      </div>
    </div>

  </div><!-- /main -->
</div><!-- /layout -->

<script>
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STEPS DATA
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
var CHAPTERS = [
  {label:\'Chapter I\',   title:\'The Platform\',    steps:[0,1,2,3]},
  {label:\'Chapter II\',  title:\'AI Assistant\',    steps:[4,5,6,7,8]},
  {label:\'Chapter III\', title:\'On WhatsApp\',     steps:[9,10,11]},
  {label:\'Chapter IV\',  title:\'SOW & Results\',   steps:[12,13,14,15,16,17]}
];

var STEPS = [
  // â”€â”€ 0: CARD &ndash; intro â”€â”€
  {
    type:\'card\',
    chap:\'EX3 SAP SuccessFactors Recruiting\',
    hl:\'The platform<br>your team <em>actually uses.</em>\',
    sub:\'Training guide Â· AI assistant Â· WhatsApp bot Â· Consultant portal\',
    dur:4200
  },
  // â”€â”€ 1: Four roles cycling â”€â”€
  {
    url:\'/\',
    auto:[
      {d:300,  a:{action:\'setRole\',role:\'rec\'}},
      {d:3000, a:{action:\'setRole\',role:\'hm\'}},
      {d:5800, a:{action:\'setRole\',role:\'cand\'}},
      {d:8400, a:{action:\'setRole\',role:\'adm\'}}
    ],
    voice:\'Every person on a SAP SuccessFactors Recruiting project sees a completely different platform. Recruiter, hiring manager, candidate, admin &mdash; each with their own tasks, their own view, nothing extra. Watch it switch between all four.\',
    minHold:11000
  },
  // â”€â”€ 2: Recruiter view â”€â”€
  {
    url:\'/\',
    role:\'rec\',
    voice:\"Take the recruiter. Every task they'll ever perform is here &mdash; post jobs, manage the pipeline, schedule interviews, send offers. Searchable, step by step, before the client even needs to ask.\",
    cursor:[
      {x:7,y:38,d:1200},
      {x:7,y:46,d:2600},
      {x:7,y:54,d:4000},
      {x:7,y:62,d:5400},
      {x:30,y:52,d:7000}
    ],
    minHold:1000
  },
  // â”€â”€ 3: Schedule interview steps â”€â”€
  {
    url:\'/\',
    role:\'rec\',
    voice:\'Click any task and it opens to individual steps. Who does what, in what sequence, exactly how to do it. Every interview, every offer, every system action &mdash; documented before the client goes live.\',
    auto:[
      {d:800, a:{action:\'openTaskDetail\',taskId:\'sched-interview\'}},
      {d:2500,a:{action:\'expandTaskSteps\',taskId:\'sched-interview\',indices:[0,1,2]}}
    ],
    cursor:[
      {x:7, y:47,d:600, click:true},
      {x:35,y:40,d:2000},
      {x:35,y:52,d:4000},
      {x:35,y:62,d:6500}
    ],
    minHold:1000
  },
  // â”€â”€ 4: CARD &ndash; AI â”€â”€
  {
    type:\'card\',
    chap:\'Chapter II\',
    hl:\"Stuck?<br><em>There's an answer.</em>\",
    sub:\'Every step. Every question. Answered instantly.\',
    dur:3800
  },
  // â”€â”€ 5: Stuck + AI (manual) â”€â”€
  {
    url:\'/\',
    role:\'rec\',
    voice:\"Every step has a help button. When someone gets stuck &mdash; mid-interview, mid-approval, mid-offer &mdash; they tap it. The AI has full context. It knows the step, the task, the role. Watch it answer. Click next when ready.\",
    auto:[
      {d:800, a:{action:\'openTaskDetail\',taskId:\'sched-interview\'}},
      {d:2000,a:{action:\'openStuck\',taskId:\'sched-interview\',stepIdx:1}},
      {d:3500,a:{action:\'askAIForStuck\',taskId:\'sched-interview\',stepIdx:1}}
    ],
    cursor:[
      {x:7, y:47,d:600, click:true},
      {x:50,y:52,d:1800},
      {x:55,y:62,d:3200,click:true},
      {x:60,y:72,d:6000}
    ],
    manual:true,
    manualHint:18000
  },
  // â”€â”€ 6: Follow-up &ndash; context memory (manual) â”€â”€
  {
    url:\'/\',
    voice:\'Now the follow-up. She asks a second question &mdash; no re-explaining, no starting over. The AI carries the full conversation. That is context memory. Click next when the answer lands.\',
    auto:[
      {d:800,a:{action:\'typeAndAsk\',query:\'What permission level do I need to schedule on behalf of someone?\'}}
    ],
    manual:true,
    manualHint:22000
  },
  // â”€â”€ 7: Try it &mdash; ask anything (manual) â”€â”€
  {
    url:\'/\',
    voice:\'You can ask it anything. Not just stuck steps &mdash; any SAP SuccessFactors Recruiting question, any point in the project, any time of day. Go ahead, give it a go. Click next when you are done.\',
    auto:[{d:600,a:{action:\'openAI\'}}],
    manual:true,
    manualHint:5000
  },
  // â”€â”€ 8: Implementation runbook â”€â”€
  {
    url:\'/\',
    voice:\'After the call she builds the implementation runbook. Picks the processes the client needs. One click and the full delivery sequence generates &mdash; post job, schedule interview, workflow automation, assessments. The whole plan, structured and ready.\',
    auto:[
      {d:700, a:{action:\'closeAI\'}},
      {d:1400,a:{action:\'openUnifiedFlow\'}},
      {d:5000,a:{action:\'setFlowProcesses\',ids:[\'post-job\',\'sched-interview\',\'add-workflow\',\'add-assessment\'],buildNow:true}}
    ],
    minHold:13000
  },
  // â”€â”€ 9: CARD &ndash; WhatsApp â”€â”€
  {
    type:\'card\',
    chap:\'Chapter III\',
    hl:\'Same AI.<br><em>On WhatsApp.</em>\',
    sub:\'No app. No login. Around the clock.\',
    voice:\'No app. No login. Just WhatsApp.\',
    postVoice:\'Quick one. I\\\'m five minutes from the client site. Their hiring manager just messaged &mdash; the Send Offer button isn\\\'t showing up. I need to know what\\\'s blocking it before I walk in. Thanks.\',
    postVoiceStressed:true,
    dur:3500
  },
  // â”€â”€ 10: WhatsApp â”€â”€
  {
    waChat:true,
    recordingScene:true,
    voice:\'Six oh seven in the morning. Sarah is in the back of a cab, five minutes from the client site. The hiring manager has messaged &mdash; the Send Offer button is gone. She records a voice note on WhatsApp. The answer lands before she gets out of the car. No app, no login, around the clock.\',
    waMessages:[
      {from:\'me\',voice:true,ts:\'06:07\',d:6000},
      {from:\'them\',text:\"The Send Offer button appears when three conditions are met:\\n\\n1\\u20e3 Candidate is in the *Offer* stage\\n2\\u20e3 Job has an active offer template\\n3\\u20e3 You have the *Offer Manager* permission\\n\\nWhich would you like me to check first?\",ts:\'06:07\',d:13000},
      {from:\'me\',text:\'Probably permissions &mdash; how do I check?\',ts:\'06:08\',d:19500},
      {from:\'them\',text:\"Go to *Admin > User Management*, find your name, and check your assigned role.\\n\\nYou need the *Offer Manager* role or a custom role with *Create Offer* permission.\\n\\nYour SR admin can add it in about two minutes.\",ts:\'06:08\',d:24500}
    ],
    minHold:12000
  },
  // â”€â”€ 11: Consultant portal â”€â”€
  {
    url:\'/consultant\',
    voice:\"For the consultants running the engagement, there's a dedicated portal. EXcelerate methodology &mdash; four phases, each fully structured. Examine, Adopt, Validate, Launch. Checklists, deliverables, timelines. Everything the delivery team needs.\",
    auto:[
      {d:1200,a:{action:\'openPhase\',index:0}},
      {d:3000,a:{action:\'openPhase\',index:1}},
      {d:4800,a:{action:\'openPhase\',index:2}},
      {d:6600,a:{action:\'openPhase\',index:3}}
    ],
    cursor:[
      {x:20,y:35,d:1000},
      {x:20,y:48,d:2800},
      {x:20,y:62,d:5500}
    ],
    minHold:2000
  },
  // â”€â”€ 12: CARD &ndash; SOW â”€â”€
  {
    type:\'card\',
    chap:\'Chapter IV\',
    hl:\'A complete SOW.<br><em>In 45 seconds.</em>\',
    sub:\'The client has asked for a formal Statement of Work before they will sign.\',
    dur:4000
  },
  // â”€â”€ 13: SOW Builder â”€â”€
  {
    url:\'/consultant/sow-builder\',
    voice:\'She opens the SOW builder. Nineteen questions &mdash; org size, geography, integrations, approval workflows, compliance, training, go-live date. Every one answered. At the end, a complete Statement of Work structured around every EXcelerate phase.\',
    auto:[{d:500,a:{action:\'demoWalkSOW\'}}],
    minHold:12000
  },
  // â”€â”€ 14: AI SOW Rewrite â”€â”€
  {
    url:\'/consultant/sow-builder\',
    voice:\'One click. The AI rewrites the whole thing into polished, client-ready consulting language &mdash; streamed live, word by word. Boardroom-ready. Done before the afternoon stand-up.\',
    auto:[{d:1000,a:{action:\'triggerAIRewrite\'}}],
    minHold:7000
  },
  // â”€â”€ 15: Export & Email â”€â”€
  {
    url:\'/consultant/sow-builder\',
    voice:\'She exports it as a structured Word document &mdash; proper headings, phase tables, RACI matrices. Or sends it straight to the client by email. From generation to delivery, without leaving the page.\',
    auto:[{d:800,a:{action:\'scrollToExport\'}}],
    minHold:5000
  },
  // â”€â”€ 16: Analytics â”€â”€
  {
    analytics:true,
    voice:\'Three weeks in. The data tells the story. Two hundred and forty seven AI queries this week. Four point two hours saved per consultant. Twelve active engagements running clean. The platform does not just support the work &mdash; it measures it.\',
    minHold:3000
  },
  // â”€â”€ 17: CARD &ndash; CTA â”€â”€
  {
    type:\'card\',
    chap:\'That\\\'s EX3\',
    hl:\'Everything your team needs.<br><em>On day one.</em>\',
    sub:\'Training guide Â· AI assistant Â· WhatsApp bot Â· SOW builder Â· Analytics\',
    cta:true,
    dur:0
  }
];

// WhatsApp waveform heights
var WH = [8,14,6,18,10,22,7,16,12,20,8,14,6,18,10,22,7,16,12,20,8,14,6,18,10];

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STATE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
var cur = 0;
var stepToken = 0;
var muted = false;
var autoTimers = [];
var currentAudio = null;
var waTimers = [];
var fc = document.getElementById(\'fc\');
var fcVisible = false;
var cursorX = 50, cursorY = 50;
var cursorMoveRaf = null;

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHAPTER NAV
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function renderChapNav(){
  var html = \'\';
  CHAPTERS.forEach(function(ch, ci){
    var isActive = ch.steps.indexOf(cur) !== -1;
    html += \'<div class="chap\' + (isActive ? \' active\' : \'\') + \'"\'
          + \' onclick="jumpToChap(\' + ci + \')">\';
    html += \'<div class="chap-num">\'+ ch.label +\'</div>\';
    html += \'<div class="chap-title">\'+ ch.title +\'</div>\';
    html += \'<div class="chap-steps">\';
    ch.steps.forEach(function(si){
      var cls = si < cur ? \'cs done\' : si === cur ? \'cs cur\' : \'cs\';
      html += \'<div class="\' + cls + \'"></div>\';
    });
    html += \'</div></div>\';
  });
  document.getElementById(\'chap-list\').innerHTML = html;
}

function jumpToChap(ci){
  var firstStep = CHAPTERS[ci].steps[0];
  goToStep(firstStep);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CURSOR
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function showCursor(){
  if(!fcVisible){ fc.style.opacity=\'1\'; fcVisible=true; }
}
function hideCursor(){
  fc.style.opacity=\'0\'; fcVisible=false;
}
function setCursorPos(x,y){
  fc.style.left = x + \'%\';
  fc.style.top  = y + \'%\';
  cursorX = x; cursorY = y;
}
function easeInOut(t){ return t<.5 ? 2*t*t : -1+(4-2*t)*t; }

function animateCursorTo(tx,ty,dur,onDone,token){
  if(cursorMoveRaf){ cancelAnimationFrame(cursorMoveRaf); cursorMoveRaf=null; }
  var fx=cursorX, fy=cursorY, start=null;
  // Disable CSS transition during JS animation
  fc.style.transition=\'none\';
  function tick(ts){
    if(stepToken!==token) return;
    if(!start) start=ts;
    var p=Math.min((ts-start)/dur,1);
    var e=easeInOut(p);
    setCursorPos(fx+(tx-fx)*e, fy+(ty-fy)*e);
    if(p<1){ cursorMoveRaf=requestAnimationFrame(tick); }
    else {
      if(onDone) onDone();
    }
  }
  cursorMoveRaf=requestAnimationFrame(tick);
}

function clickCursor(){
  fc.classList.remove(\'click-anim\');
  void fc.offsetWidth;
  fc.classList.add(\'click-anim\');
  setTimeout(function(){ fc.classList.remove(\'click-anim\'); },420);
}

function runCursorPath(path, token){
  if(!path||!path.length) return;
  showCursor();
  var prev = {x:50,y:50};
  path.forEach(function(pt){
    var delay = pt.d || 0;
    var dur = Math.max(400, delay - (prev.d||0) - 50);
    autoTimers.push(setTimeout(function(){
      if(stepToken!==token) return;
      animateCursorTo(pt.x, pt.y, Math.max(350, dur), function(){
        if(pt.click && stepToken===token) clickCursor();
      }, token);
    }, delay));
    prev = pt;
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ZOOM
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
var lf = document.getElementById(\'live-frame\');
function zoomFrame(x,y,scale,delayMs,token){
  autoTimers.push(setTimeout(function(){
    if(stepToken!==token) return;
    lf.style.transition=\'transform .85s cubic-bezier(.4,0,.2,1)\';
    lf.style.transformOrigin = x+\'% \'+y+\'%\';
    lf.style.transform=\'scale(\'+scale+\')\';
  },delayMs||0));
}
function resetZoom(token){
  autoTimers.push(setTimeout(function(){
    if(stepToken!==token) return;
    lf.style.transition=\'transform .7s cubic-bezier(.4,0,.2,1)\';
    lf.style.transform=\'scale(1)\';
    lf.style.transformOrigin=\'50% 50%\';
  },0));
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SPOTLIGHT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
var spl = document.getElementById(\'spotlight\');
function setSpotlight(x,y,r,token,delay){
  autoTimers.push(setTimeout(function(){
    if(stepToken!==token) return;
    spl.style.background=\'radial-gradient(circle \'+r+\'px at \'+x+\'% \'+y+\'%, transparent \'+Math.max(0,r-20)+\'px, rgba(0,0,0,.6) \'+r+\'px)\';
    spl.style.opacity=\'1\';
  },delay||0));
}
function clearSpotlight(){
  spl.style.opacity=\'0\';
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NARRATION WORDS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function renderWords(text, charPos){
  var words = text.split(\' \');
  var html=\'\', pos=0;
  words.forEach(function(w,i){
    var cls = pos+w.length < charPos ? \'w done\' : pos <= charPos ? \'w lit\' : \'w\';
    html += \'<span class="\'+cls+\'">\'+w+\'</span> \';
    pos += w.length+1;
  });
  document.getElementById(\'nar-words\').innerHTML=html;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TTS / SPEAK  (Web Audio API &mdash; bypasses HTMLAudioElement quirks)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
var _actx=null;
var _sourceNode=null;
var _wordTimer=null;

function _getActx(){
  if(!_actx) _actx=new(window.AudioContext||window.webkitAudioContext)();
  return _actx;
}

function stopAudio(){
  if(_sourceNode){ try{ _sourceNode.stop(); }catch(e){} _sourceNode=null; }
  if(_wordTimer){ clearInterval(_wordTimer); _wordTimer=null; }
  currentAudio=null;
  document.getElementById(\'bars\').classList.remove(\'speaking\');
  document.getElementById(\'nar-pb-fill\').style.width=\'0\';
}

function speak(text, onDone, token){
  stopAudio();
  renderWords(text,-1);
  document.getElementById(\'nar-pb-fill\').style.width=\'0\';

  if(muted){
    var est=Math.max(6000,text.split(\' \').length*420);
    autoTimers.push(setTimeout(function(){
      if(token!==stepToken) return;
      renderWords(text,text.length+1);
      if(onDone) onDone();
    },est));
    return;
  }

  document.getElementById(\'bars\').classList.add(\'speaking\');
  var completed=false;

  function finish(){
    if(completed) return;
    completed=true;
    stopAudio();
    renderWords(text,text.length+1);
    document.getElementById(\'nar-pb-fill\').style.width=\'100%\';
    setTimeout(function(){ if(token===stepToken && onDone) onDone(); },300);
  }

  var ctx=_getActx();
  // Resume AudioContext if suspended (requires prior user gesture)
  (ctx.state===\'suspended\' ? ctx.resume() : Promise.resolve())
    .then(function(){
      return fetch(\'/api/tts?text=\'+encodeURIComponent(text));
    })
    .then(function(r){ return r.arrayBuffer(); })
    .then(function(buf){ return ctx.decodeAudioData(buf); })
    .then(function(decoded){
      if(token!==stepToken) return;
      var src=ctx.createBufferSource();
      src.buffer=decoded;
      src.connect(ctx.destination);
      _sourceNode=src;
      currentAudio={paused:false}; // sentinel for stopAudio check
      var startAt=ctx.currentTime;
      var dur=decoded.duration;
      _wordTimer=setInterval(function(){
        if(token!==stepToken){ clearInterval(_wordTimer); _wordTimer=null; return; }
        var pct=Math.min(1,(ctx.currentTime-startAt)/dur);
        renderWords(text,Math.floor(pct*text.length));
        document.getElementById(\'nar-pb-fill\').style.width=Math.min(99,Math.round(pct*100))+\'%\';
      },120);
      src.onended=function(){ if(token===stepToken) finish(); };
      src.start(0);
    })
    .catch(function(){ if(token===stepToken) finish(); });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// postMessage to iframe
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function postToFrame(msg){
  try{ document.getElementById(\'live-frame\').contentWindow.postMessage(Object.assign({type:\'EX3_DEMO\'},msg),\'*\'); }catch(e){}
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// WHATSAPP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function clearWaTimers(){ waTimers.forEach(clearTimeout); waTimers=[]; }
function showWa(messages, token){
  document.getElementById(\'wa-panel\').classList.add(\'show\');
  document.getElementById(\'live-frame\').style.display=\'none\';
  var msgs=document.getElementById(\'wa-msgs\');
  var typ=document.getElementById(\'wa-typ\');
  msgs.innerHTML=\'\'; typ.classList.remove(\'show\');

  messages.forEach(function(m){
    waTimers.push(setTimeout(function(){
      if(stepToken!==token) return;
      if(m.voice){
        var b=document.createElement(\'div\');
        b.className=\'wa-b me\';
        b.innerHTML=\'<div class="wa-vnote"><div class="wa-vplay">&#9654;</div><div class="wa-wf">\'+
          WH.map(function(h){ return \'<div class="wa-wb" style="height:\'+h+\'px"></div>\'; }).join(\'\') +
          \'</div><span class="wa-vd">0:12</span></div><div class="wa-ts">\'+m.ts+\'</div>\';
        msgs.appendChild(b);
        setTimeout(function(){ b.classList.add(\'show\'); },40);
        setTimeout(function(){ typ.classList.add(\'show\'); },600);
      } else {
        typ.classList.remove(\'show\');
        setTimeout(function(){
          var b=document.createElement(\'div\');
          b.className=\'wa-b \'+m.from;
          var html=m.text.replace(/\\\\*(.*?)\\\\*/g,\'<strong>$1</strong>\');
          b.innerHTML=html+\'<div class="wa-ts">\'+m.ts+\'</div>\';
          msgs.appendChild(b);
          msgs.scrollTop=msgs.scrollHeight;
          setTimeout(function(){ b.classList.add(\'show\'); },40);
        },200);
      }
    },m.d||0));
  });
}
function hideWa(){
  document.getElementById(\'wa-panel\').classList.remove(\'show\');
  document.getElementById(\'live-frame\').style.display=\'\';
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ANALYTICS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
var anInited=false;
function showAnalytics(token){
  document.getElementById(\'an-panel\').classList.add(\'show\');
  document.getElementById(\'live-frame\').style.display=\'none\';
  if(anInited) return;
  anInited=true;

  // KPI counters
  var targets=[{id:\'an-k1\',val:247,dec:0},{id:\'an-k2\',val:4.2,dec:1,suf:\'hrs\'},{id:\'an-k3\',val:94,dec:0,suf:\'%\'},{id:\'an-k4\',val:12,dec:0}];
  targets.forEach(function(t){
    var el=document.getElementById(t.id);
    var start=Date.now(),dur=1800;
    var iv=setInterval(function(){
      var p=Math.min(1,(Date.now()-start)/dur);
      var e=1-Math.pow(1-p,3);
      var v=t.val*e;
      var disp=t.dec>0?v.toFixed(t.dec):Math.round(v);
      el.innerHTML=disp+(t.suf?\'<span style="font-size:.45em">\'+t.suf+\'</span>\':
      \'\');
      if(p>=1) clearInterval(iv);
    },28);
  });

  // Bar chart
  var days=[\'Mon\',\'Tue\',\'Wed\',\'Thu\',\'Fri\',\'Sat\',\'Sun\'];
  var vals=[31,44,38,52,61,18,23];
  var max=Math.max.apply(null,vals);
  var bc=document.getElementById(\'an-bars\');
  bc.innerHTML=days.map(function(d,i){
    return \'<div class="an-bar-col"><div class="an-bar-fill" id="ab\'+i+\'"></div><div class="an-bar-lbl">\'+d+\'</div></div>\';
  }).join(\'\');
  setTimeout(function(){
    vals.forEach(function(v,i){
      var el=document.getElementById(\'ab\'+i);
      if(el) el.style.height=Math.round(v/max*100)+\'%\';
    });
  },200);

  // Top questions
  var qs=[
    [\'How do I move a candidate?\',\'18%\'],
    [\'How do I send an offer?\',\'14%\'],
    [\'How do I set up approval?\',\'11%\'],
    [\'Can candidates self-schedule?\',\'9%\'],
    [\'How do I post to LinkedIn?\',\'8%\']
  ];
  var qc=document.getElementById(\'an-qs\');
  qc.innerHTML=qs.map(function(q){
    return \'<div class="an-q-row"><div class="an-q-txt">\'+q[0]+\'</div><div class="an-q-pct">\'+q[1]+\'</div></div>\';
  }).join(\'\');
  setTimeout(function(){
    qc.querySelectorAll(\'.an-q-row\').forEach(function(r,i){
      setTimeout(function(){ r.classList.add(\'show\'); },i*180+400);
    });
  },500);
}
function hideAnalytics(){
  document.getElementById(\'an-panel\').classList.remove(\'show\');
  document.getElementById(\'live-frame\').style.display=\'\';
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CARD OVERLAY
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function showCard(step, onDone, token){
  var el=document.getElementById(\'card-overlay\');
  document.getElementById(\'card-chap\').innerHTML=step.chap||\'\';
  document.getElementById(\'card-hl\').innerHTML=step.hl||\'\';
  document.getElementById(\'card-sub\').innerHTML=step.sub||\'\';

  el.classList.remove(\'active\',\'go\');
  var prog=document.getElementById(\'card-progress\');
  prog.style.transition=\'none\'; prog.style.width=\'0\';
  el.classList.add(\'active\');
  void el.offsetWidth;
  el.classList.add(\'go\');

  // CTA button
  if(step.cta){
    if(!document.getElementById(\'cta-btn\')){
      var btn=document.createElement(\'button\');
      btn.id=\'cta-btn\';
      btn.textContent=\'Book a demo call\';
      btn.style.cssText=\'margin-top:28px;padding:16px 48px;background:#22c55e;color:#000;font-family:inherit;font-size:14px;font-weight:900;border:none;border-radius:12px;cursor:pointer;letter-spacing:-.01em\';
      btn.onclick=function(){ window.open(\'mailto:hello@ex3.io\',\'_blank\'); };
      document.getElementById(\'card-inner\').appendChild(btn);
    }
    document.getElementById(\'next-btn\').classList.add(\'next-ready\');
    return;
  }

  function afterNarration(){
    if(token!==stepToken) return;
    if(step.postVoice){
      // Play Sarah stressed voice then advance
      var url=\'/api/tts?text=\'+encodeURIComponent(step.postVoice)+(step.postVoiceStressed?\'&stressed=1\':\'\');
      var ctx=_getActx();
      fetch(url).then(function(r){return r.arrayBuffer();})
        .then(function(buf){return ctx.decodeAudioData(buf);})
        .then(function(decoded){
          if(token!==stepToken) return;
          var src=ctx.createBufferSource();
          src.buffer=decoded; src.connect(ctx.destination);
          src.onended=function(){
            setTimeout(function(){
              if(token!==stepToken) return;
              el.classList.remove(\'active\',\'go\');
              if(onDone) onDone();
            },800);
          };
          src.start(0);
        }).catch(function(){
          if(token!==stepToken) return;
          el.classList.remove(\'active\',\'go\');
          if(onDone) onDone();
        });
    } else if(step.dur>0){
      prog.style.transition=\'none\'; prog.style.width=\'0\';
      setTimeout(function(){
        prog.style.transition=\'width \'+step.dur+\'ms linear\';
        prog.style.width=\'100%\';
      },60);
      autoTimers.push(setTimeout(function(){
        if(token!==stepToken) return;
        el.classList.remove(\'active\',\'go\');
        if(onDone) onDone();
      },step.dur));
    } else {
      document.getElementById(\'next-btn\').classList.add(\'next-ready\');
    }
  }

  if(step.voice){
    speak(step.voice, afterNarration, token);
  } else {
    afterNarration();
  }
}
function hideCard(){
  var el=document.getElementById(\'card-overlay\');
  el.classList.remove(\'active\',\'go\');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CLEANUP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function cleanupStep(){
  autoTimers.forEach(clearTimeout); autoTimers=[];
  clearWaTimers();
  stopAudio();
  clearSpotlight();
  resetZoom(stepToken+1);
  hideCursor();
  hideWa();
  hideAnalytics();
  var rec=document.getElementById(\'wa-rec-scene\');
  if(rec){ rec.classList.remove(\'show\'); rec.style.opacity=\'\'; }
  document.getElementById(\'next-btn\').classList.remove(\'next-ready\');
  if(cursorMoveRaf){ cancelAnimationFrame(cursorMoveRaf); cursorMoveRaf=null; }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// RENDER STEP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function goToStep(idx){
  cleanupStep();
  stepToken = ++stepToken;
  var token = stepToken;
  cur = Math.max(0, Math.min(idx, STEPS.length-1));
  renderChapNav();

  var s = STEPS[cur];

  // Flash transition (not on cards auto-advancing)
  var fl=document.getElementById(\'flash\');
  fl.classList.add(\'on\');
  setTimeout(function(){
    fl.classList.remove(\'on\');
  },260);

  setTimeout(function(){
    if(token!==stepToken) return;
    _renderStep(s, token);
  },130);
}

function _renderStep(s, token){
  // â”€â”€ Card step â”€â”€
  if(s.type===\'card\'){
    hideCard();
    showCard(s, function(){
      if(token!==stepToken) return;
      goToStep(cur+1);
    }, token);
    return;
  }

  // â”€â”€ Live step â”€â”€
  hideCard();

  // Handle iframe URL
  if(s.url){
    var lf=document.getElementById(\'live-frame\');
    if(lf.src.replace(location.origin,\'\')!==s.url){
      lf.src=s.url;
    }
    lf.style.display=\'\';
  }

  // Set role if specified
  if(s.role){
    setTimeout(function(){
      if(token!==stepToken) return;
      postToFrame({action:\'setRole\',role:s.role});
    },600);
  }

  // WhatsApp
  if(s.waChat){
    showWa(s.waMessages||[], token);
  }

  // Analytics
  if(s.analytics){
    showAnalytics(token);
  }

  // Update URL bar
  if(s.url){
    document.getElementById(\'burl-txt\').textContent = \'ex3-guide.railway.app\' + (s.url===\'/?\' ? \'\' : s.url);
  }

  // postMessage auto actions
  if(s.auto){
    s.auto.forEach(function(a){
      autoTimers.push(setTimeout(function(){
        if(token!==stepToken) return;
        postToFrame(a.a);
      },a.d));
    });
  }

  // Cursor path
  if(s.cursor){
    autoTimers.push(setTimeout(function(){
      if(token!==stepToken) return;
      runCursorPath(s.cursor, token);
    },400));
  }

  // Zoom
  if(s.zoom){
    resetZoom(token);
    zoomFrame(s.zoom.x, s.zoom.y, s.zoom.scale, s.zoom.d||2000, token);
  }

  // Recording scene (show before WA messages start)
  if(s.recordingScene){
    var rec=document.getElementById(\'wa-rec-scene\');
    if(rec){
      rec.style.opacity=\'1\'; rec.classList.add(\'show\');
      autoTimers.push(setTimeout(function(){
        if(token!==stepToken) return;
        rec.style.opacity=\'0\';
        setTimeout(function(){ rec.classList.remove(\'show\'); rec.style.opacity=\'\'; },500);
      },5200));
    }
  }

  // Voice narration
  if(s.voice){
    speak(s.voice, function(){
      if(token!==stepToken) return;
      var hold = s.minHold||0;
      if(s.manual){
        document.getElementById(\'next-btn\').classList.add(\'next-ready\');
      } else {
        autoTimers.push(setTimeout(function(){
          if(token!==stepToken) return;
          goToStep(cur+1);
        },hold));
      }
    }, token);
  } else {
    document.getElementById(\'next-btn\').classList.add(\'next-ready\');
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NAVIGATION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function nextStep(){ goToStep(cur+1); }
function prevStep(){ goToStep(Math.max(0,cur-1)); }
function replayAudio(){
  var s=STEPS[cur];
  if(s.voice) speak(s.voice,null,stepToken);
}
function toggleMute(){
  muted=!muted;
  var btn=document.getElementById(\'vol-btn\');
  var txt=document.getElementById(\'vol-txt\');
  btn.classList.toggle(\'muted\',muted);
  txt.textContent=muted?\'Voice Off\':\'Voice On\';
  if(muted) stopAudio();
}

document.addEventListener(\'keydown\',function(e){
  if(e.key===\'ArrowRight\'||e.key===\' \') nextStep();
  if(e.key===\'ArrowLeft\') prevStep();
  if(e.key===\'m\'||e.key===\'M\') toggleMute();
  if(e.key===\'r\'||e.key===\'R\') replayAudio();
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// WHATSAPP STEP: fix advance timing
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Override _renderStep WA advance &mdash; WA messages end around 21s, hold 3s more
var _origRender = _renderStep;
// The WA step auto-advance is handled inline above with 24000ms

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BOOT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function beginDemo(){
  _getActx().resume(); // unlock AudioContext during user gesture
  var ss=document.getElementById(\'start-screen\');
  ss.classList.add(\'fade\');
  setTimeout(function(){ ss.style.display=\'none\'; goToStep(0); },600);
}
// Preload iframe silently so it\'s warm when demo starts
document.getElementById(\'live-frame\').src=\'/\';
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  if (!process.env.ASSISTANT_ID) {
    console.warn('âš   ASSISTANT_ID not set &mdash; run "node setup.js" first to upload your documents.');
  }
  console.log(`EX3 Guide running at http://localhost:${PORT}`);
});



