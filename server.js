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

function getUserThread(phone) {
  if (!fs.existsSync(THREADS_FILE)) return null;
  const threads = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
  return threads[phone] || null;
}

function saveUserThread(phone, threadId) {
  const threads = fs.existsSync(THREADS_FILE)
    ? JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'))
    : {};
  threads[phone] = threadId;
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
}

function readWebLogs() {
  if (!fs.existsSync(WEB_LOG_FILE)) return [];
  return fs.readFileSync(WEB_LOG_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const app = express();
const PORT = process.env.PORT || 3000;
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
  <title>Analytics — Login</title>
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
  if (!text) return res.status(400).end();
  try {
    if (!ttsCache[text]) {
      const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice: 'nova', input: text, speed: 0.92 });
      ttsCache[text] = Buffer.from(await mp3.arrayBuffer());
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(ttsCache[text]);
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

(After your answer, on a new line write exactly: FOLLOWUPS: [question 1] | [question 2] | [question 3] — 3 short follow-up questions the user might ask next.)`;

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
      throw new Error(`Unexpected run status: ${run.status}${run.last_error ? ' — ' + run.last_error.message : ''}`);
    }

    // Get the assistant's reply
    const messages = await openai.beta.threads.messages.list(thread.id);
    const raw = messages.data[0]?.content[0]?.text?.value || '';

    // Strip citation markers like 【4:0†source】
    const cleaned = raw.replace(/【[^】]*】/g, '').trim();

    if (!cleaned) throw new Error('No answer returned.');

    // Parse follow-up questions out of the response
    const followupMatch = cleaned.match(/FOLLOWUPS:\s*(.+)$/m);
    let followUps = [];
    let answer = cleaned;
    if (followupMatch) {
      followUps = followupMatch[1]
        .split('|')
        .map(q => q.replace(/^\[|\]$/g, '').trim())
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

// WhatsApp webhook — Twilio sends POST with body.Body = user message
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
      answer = answer.replace(/【[^】]*】/g, '').replace(/FOLLOWUPS:.*$/ms, '').trim();
      if (answer.length > 1580) answer = answer.slice(0, 1577) + '…';

      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: `🎤 _"${transcribed}"_\n\n${answer}`,
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

  const isGreeting = /^(hi|hey|hello|hiya|howdy|good (morning|afternoon|evening)|sup|yo|helo|hii+)[\s!?.]*$/i.test(userMsg);

  if (!userMsg || isGreeting) {
    twiml.message('Hi! 👋 Ask me anything about EX3 and SmartRecruiters — I\'m here to help.');
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
    if (!process.env.ASSISTANT_ID) throw new Error('Assistant not configured.');

    const existingThreadId = getUserThread(from);
    const thread = existingThreadId
      ? { id: existingThreadId }
      : await openai.beta.threads.create();
    saveUserThread(from, thread.id);

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMsg,
    });

    let run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    while (run.status === 'in_progress' || run.status === 'queued') {
      if (Date.now() - start > 55000) throw new Error('Timed out.');
      await new Promise(r => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    if (run.status !== 'completed') throw new Error(`Run status: ${run.status}`);

    const messages = await openai.beta.threads.messages.list(thread.id);
    answer = messages.data[0]?.content[0]?.text?.value || '';
    answer = answer.replace(/【[^】]*】/g, '').replace(/FOLLOWUPS:.*$/ms, '').trim();

    if (answer.length > 1580) answer = answer.slice(0, 1577) + '…';

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
    const status = !l.success ? '❌ Error' : l.uncertain ? '⚠️ Uncertain' : '✅';
    const num = l.from.replace('whatsapp:', '');
    return `
    <tr>
      <td>${l.ts.replace('T', ' ').slice(0, 19)}</td>
      <td><a href="/analytics?q=${encodeURIComponent(num)}" style="color:#4a90e2;text-decoration:none">${num}</a></td>
      <td>${escHtml(l.question)}</td>
      <td class="preview" onclick="showAnswer(this)" data-full="${escHtml(l.answer || '—')}">${escHtml(l.answer || '—').slice(0, 120)}${(l.answer || '').length > 120 ? '… <span style="color:#4a90e2;font-size:.8rem">(click to expand)</span>' : ''}</td>
      <td>${status}</td>
      <td>${(l.ms / 1000).toFixed(1)}s</td>
    </tr>`;
  }).join('');

  const dayRows = Object.entries(byDay).sort().reverse().map(([d, c]) =>
    `<tr><td>${d}</td><td>${c}</td></tr>`).join('');

  const numberOptions = uniqueNumbers.map(n =>
    `<option value="${escHtml(n)}" ${search && n.includes(search) ? 'selected' : ''}>${escHtml(n)}</option>`
  ).join('');

  const searchLabel = search ? `— filtered to <strong>${logs[0]?.from.replace('whatsapp:','') || search}</strong> <a href="/analytics" style="font-size:.85rem;color:#4a90e2">clear</a>` : '';

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
      <option value="">— or pick a number —</option>
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

// Consultant Portal
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
    .checklist li::before{content:'☐';font-size:15px;flex-shrink:0;margin-top:1px;color:#888}
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
    <a href="/consultant/sow-builder" style="display:block;padding:9px 20px;font-size:13px;color:#aaa;transition:all .15s;border-left:2px solid transparent;background:#1a3a1a;border-left-color:#4ade80;color:#4ade80;font-weight:600">✨ SOW Builder</a>
  </nav>

  <!-- Main -->
  <main class="main">

    <!-- OVERVIEW -->
    <div class="page active" id="page-overview">
      <div class="hero">
        <span class="badge badge-gray">Consultant Portal</span>
        <h1>SmartRecruiters Implementation Guide</h1>
        <p>Everything you need to deliver a successful SmartRecruiters implementation — from kickoff to go-live.</p>
      </div>
      <div class="cards">
        <div class="card"><div class="num">8–12</div><h3>Typical Weeks</h3><p>For a standard mid-size organisation</p></div>
        <div class="card"><div class="num">6</div><h3>Phases</h3><p>Discovery, Config, Build, UAT, Training, Go-Live</p></div>
        <div class="card"><div class="num">4</div><h3>Key Stakeholders</h3><p>HR, IT, Recruiters, Hiring Managers</p></div>
        <div class="card"><div class="num">3</div><h3>Training Sessions</h3><p>Admin, Recruiter, Hiring Manager</p></div>
      </div>
      <div class="tip"><strong>First time?</strong> Start with the Phase Guide — it walks you through exactly what to do and when. The SOW Template has pre-written scope wording you can use directly with clients.</div>
      <h2 class="section-title">Typical Implementation Timeline</h2>
      <p class="section-sub">Use this as a guide — timelines vary based on client complexity, integrations, and decision speed.</p>
      <table>
        <tr><th>Phase</th><th>Weeks</th><th>Key Output</th></tr>
        <tr><td>1. Discovery & Kickoff</td><td>1–2</td><td>Project plan, stakeholder map, requirements doc</td></tr>
        <tr><td>2. System Configuration</td><td>2–4</td><td>Platform configured, users set up, hiring processes built</td></tr>
        <tr><td>3. Build & Integrate</td><td>3–5</td><td>Integrations live, job boards connected, career page branded</td></tr>
        <tr><td>4. UAT (Testing)</td><td>5–7</td><td>Client signed off, bugs resolved</td></tr>
        <tr><td>5. Training</td><td>6–8</td><td>All users trained, materials delivered</td></tr>
        <tr><td>6. Go-Live & Hypercare</td><td>8–12</td><td>Live in production, 2–4 week support window</td></tr>
      </table>
    </div>

    <!-- PHASES -->
    <div class="page" id="page-phases">
      <div class="hero">
        <span class="badge badge-blue">Phase Guide</span>
        <h1>Implementation Phases</h1>
        <p>A detailed breakdown of every phase — what to do, who's involved, and what to deliver.</p>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">1</div>
          <div class="phase-title">Discovery & Kickoff</div>
          <div class="phase-weeks">Weeks 1–2</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">The goal of discovery is to understand the client's current recruitment process, pain points, and what they need SmartRecruiters to do. Never skip this — it prevents costly rework later.</p>
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
          <div class="phase-weeks">Weeks 2–4</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">This is where you build the platform. Work from the inside out — company settings first, then users, then hiring processes, then templates.</p>
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
          <div class="phase-weeks">Weeks 3–5</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Connect SmartRecruiters to the client's existing systems. Involve the client's IT team here — you'll need their credentials and access.</p>
          <ul class="checklist">
            <li>Brand and configure the careers page</li>
            <li>Connect job boards (Indeed, LinkedIn, Glassdoor, etc.)</li>
            <li>Set up HRIS integration if required (Workday, SAP, BambooHR)</li>
            <li>Configure background screening integration if required</li>
            <li>Set up SSO (Single Sign-On) if required — needs IT</li>
            <li>Test all integrations end-to-end</li>
            <li>Configure job posting approval workflows</li>
            <li>Set up Winston AI features if in scope</li>
          </ul>
        </div>
      </div>

      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-num">4</div>
          <div class="phase-title">UAT — User Acceptance Testing</div>
          <div class="phase-weeks">Weeks 5–7</div>
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
          <div class="phase-weeks">Weeks 6–8</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Run separate training sessions per role — don't mix admins and hiring managers in the same session. Keep it practical, hands-on, and recorded where possible.</p>
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
          <div class="phase-weeks">Weeks 8–12</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body">
          <p style="font-size:13px;color:#555;margin-top:12px">Go-live day is just the beginning. The hypercare period (2–4 weeks of close support) is where most issues surface. Be proactive — check in daily in the first week.</p>
          <ul class="checklist">
            <li>Confirm go-live date with client at least 2 weeks in advance</li>
            <li>Complete final production environment check</li>
            <li>Migrate any agreed historical data</li>
            <li>Send go-live communication to all users</li>
            <li>Be on standby on go-live day</li>
            <li>Daily check-in calls for first week post go-live</li>
            <li>Weekly check-ins for weeks 2–4</li>
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
        <p>Pre-written scope wording for a standard SmartRecruiters implementation. Edit the highlighted fields for each client.</p>
      </div>
      <div class="tip"><strong>How to use:</strong> Copy the relevant sections below into your SOW document. Replace anything in [brackets] with client-specific details. Always get this reviewed before sending.</div>

      <div class="sow-box">
        <h2>1. Project Overview</h2>
        <div class="sub">Introductory paragraph for the SOW</div>
        <div class="sow-section">
          <p>This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SmartRecruiters for [Client Name]. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SmartRecruiters platform in accordance with [Client Name]'s requirements as agreed during the discovery phase.</p>
        </div>
        <button class="copy-btn" onclick="copyText(this, 'This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SmartRecruiters for [Client Name]. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SmartRecruiters platform in accordance with [Client Name]\\'s requirements as agreed during the discovery phase.')">Copy</button>
      </div>

      <div class="sow-box">
        <h2>2. In Scope</h2>
        <div class="sub">What EX3 will deliver — use this as your standard scope</div>
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
            <li>Configuration and branding of the SmartRecruiters careers page</li>
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
            <li>Access to the EX3 SmartRecruiters Enablement Guide for all users</li>
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
            <li>SmartRecruiters platform licensing costs (to be contracted directly)</li>
            <li>Ongoing managed services or system administration after the hypercare period</li>
            <li>Training beyond the sessions defined above</li>
            <li>Changes to scope agreed after project kick-off (subject to change request process)</li>
          </ul>
        </div>
      </div>

      <div class="sow-box">
        <h2>4. Client Responsibilities</h2>
        <div class="sub">What the client must provide — critical to include</div>
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
        <div class="sub">Protect yourself — state what you're assuming to be true</div>
        <div class="sow-section">
          <ul>
            <li>The client holds a valid SmartRecruiters licence for the duration of the project</li>
            <li>A named internal project owner will be available throughout the engagement</li>
            <li>Client feedback and approvals will be provided within 3 business days of request</li>
            <li>All integrations use standard SmartRecruiters connectors — no custom development required</li>
            <li>The number of users, templates, and workflows does not exceed the quantities stated above</li>
            <li>Go-live will occur within [X] weeks of project start — delays caused by the client may impact timelines and costs</li>
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
          <tr><td>Lead discovery sessions and gather requirements</td><td>Week 1–2</td></tr>
          <tr><td>Own and maintain the project plan</td><td>Throughout</td></tr>
          <tr><td>Configure the SmartRecruiters platform</td><td>Week 2–4</td></tr>
          <tr><td>Set up and test all integrations</td><td>Week 3–5</td></tr>
          <tr><td>Facilitate UAT and manage issue log</td><td>Week 5–7</td></tr>
          <tr><td>Deliver training sessions</td><td>Week 6–8</td></tr>
          <tr><td>Support go-live and hypercare period</td><td>Week 8–12</td></tr>
          <tr><td>Produce handover documentation</td><td>End of project</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-hr">
        <h2 class="section-title">HR Director / Project Owner</h2>
        <p class="section-sub">The most important person on the client side. They make decisions and unblock things.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Sign off project scope and SOW</td><td>Before kickoff</td></tr>
          <tr><td>Attend kickoff and key milestone sessions</td><td>Week 1, 7, go-live</td></tr>
          <tr><td>Make decisions on hiring process design</td><td>Week 1–3</td></tr>
          <tr><td>Approve offer templates and approval chains</td><td>Week 3–4</td></tr>
          <tr><td>Provide UAT sign-off</td><td>Week 5–7</td></tr>
          <tr><td>Champion the system internally</td><td>Throughout</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-it">
        <h2 class="section-title">IT / System Administrator</h2>
        <p class="section-sub">Needed mainly for integrations and SSO. Engage them early — they're often the bottleneck.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Provide HRIS credentials and integration access</td><td>Week 3</td></tr>
          <tr><td>Configure SSO (if required)</td><td>Week 3–4</td></tr>
          <tr><td>Whitelist SmartRecruiters domains on firewall</td><td>Week 2</td></tr>
          <tr><td>Support data migration (if applicable)</td><td>Week 7–8</td></tr>
          <tr><td>Attend integration testing sessions</td><td>Week 4–5</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-recruiter">
        <h2 class="section-title">Lead Recruiter</h2>
        <p class="section-sub">Your day-to-day contact. They know the current process better than anyone.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Map current recruitment process during discovery</td><td>Week 1–2</td></tr>
          <tr><td>Review and approve hiring process configuration</td><td>Week 3–4</td></tr>
          <tr><td>Lead UAT testing for recruiter workflows</td><td>Week 5–6</td></tr>
          <tr><td>Attend recruiter training session</td><td>Week 6–8</td></tr>
          <tr><td>Become internal super-user post go-live</td><td>Week 8+</td></tr>
        </table>
      </div>

      <div class="role-content" id="role-hm">
        <h2 class="section-title">Hiring Manager</h2>
        <p class="section-sub">Often the hardest to engage. Keep their involvement minimal and targeted.</p>
        <table><tr><th>Responsibility</th><th>When</th></tr>
          <tr><td>Attend hiring manager training session</td><td>Week 6–8</td></tr>
          <tr><td>Complete UAT for hiring manager workflows</td><td>Week 5–7</td></tr>
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
          <div class="phase-title">How long should a SmartRecruiters implementation take?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">For a standard mid-size company (50–500 employees, no complex integrations), expect 8–10 weeks. Larger organisations or those requiring HRIS integrations, SSO, or data migration should plan for 10–16 weeks. The biggest variable is client responsiveness — decisions that take a week instead of a day add up fast.</p></div>
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
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">The scope should cover: platform configuration, user setup, integrations (list each one explicitly), career page setup, UAT facilitation, training sessions (specify how many and which roles), go-live support, and hypercare duration. Always include an Out of Scope section — data migration, custom development, and additional training are common areas where clients assume it's included when it isn't.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">What integrations does SmartRecruiters support out of the box?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">SmartRecruiters has a large marketplace of native integrations including: Indeed, LinkedIn, Glassdoor (job boards), Workday, SAP SuccessFactors, BambooHR (HRIS), Sterling, Checkr (background screening), Okta, Azure AD (SSO), DocuSign, and many more. Always check the SmartRecruiters Marketplace for the latest list. Custom integrations via API are out of scope for a standard implementation.</p></div>
      </div>
      <div class="phase">
        <div class="phase-header" onclick="togglePhase(this)">
          <div class="phase-title">Client wants to change scope mid-project — what do I do?</div>
          <svg class="phase-chevron" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="phase-body"><p style="font-size:13px;padding-top:12px">Raise a Change Request. Never agree to scope changes verbally. Document what's being added, the impact on timeline and cost, and get it signed off before doing the work. If the change is minor (e.g. one extra email template), use your judgement — but anything that adds meaningful effort should go through a formal change request.</p></div>
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
      li.childNodes[0] && (li.childNodes[0].textContent = '☐');
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
    subtitle: 'Everything an EX3 consultant needs to run a flawless implementation — in one place.',
    points: [
      'Covers every phase of a SmartRecruiters implementation end to end',
      'Built from real EX3 project experience — not generic advice',
      'Role matrix, UAT checklist, and FAQ all in one place',
      'Accessible anywhere — consultants use this live on client calls',
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
      'Agreeing scope here prevents scope creep later — this phase is critical',
    ],
    note: 'Click into the Discovery phase card. Walk through the key activities listed.',
  },
  {
    tag: 'Configuration Phase',
    title: 'Phase 2: Configuration',
    subtitle: 'This is where SmartRecruiters is built out to match what was agreed in discovery.',
    points: [
      'Users, roles, and permissions set up first — everything else depends on this',
      'Hiring workflows built to match each job type the client uses',
      'Email templates, offer letters, and job templates configured to their brand',
      'Every config decision is documented for the handover pack',
    ],
    note: 'Show the configuration checklist. Each item maps to a deliverable in the SOW.',
  },
  {
    tag: 'Integrations Phase',
    title: 'Phase 3: Integrations',
    subtitle: 'Connecting SmartRecruiters to the rest of the client tech stack.',
    points: [
      'HRIS, SSO, background screening, DocuSign — all require IT involvement from the client',
      'Engage the client IT team at kickoff — do not wait until integration phase starts',
      'Each integration is tested end-to-end before UAT begins',
      'Standard marketplace connectors only — custom dev is out of scope unless agreed',
    ],
    note: 'Show the integrations section. Highlight the note about engaging IT early.',
  },
  {
    tag: 'UAT Phase',
    title: 'Phase 4: User Acceptance Testing',
    subtitle: 'The client signs off before we go anywhere near go-live.',
    points: [
      'UAT is run by the client, supported by EX3 — not the other way around',
      'Test scripts provided covering every hiring workflow and user role',
      'Critical issues must be resolved before go-live — no exceptions',
      'Written sign-off obtained from the project owner before the go-live date is confirmed',
    ],
    note: 'Click on the UAT checklist. Show how each item is tracked.',
  },
  {
    tag: 'Training Phase',
    title: 'Phase 5: Training',
    subtitle: 'Separate sessions per role — never mix admins and hiring managers in the same room.',
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
    subtitle: "The moment the client goes live — and when the real work begins.",
    points: [
      'Go-live readiness review with the client project owner the day before',
      'EX3 consultant on call on go-live day — available for any critical issues',
      'Hypercare period: daily check-ins week one, weekly thereafter',
      'Formal handover pack and close-out documentation delivered at end of hypercare',
    ],
    note: 'End on this slide. The hypercare point is a differentiator — competitors often disappear post go-live.',
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
  document.getElementById('demoFab').textContent = dpOpen ? '✕ Exit Demo' : '▶ Start Demo';
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
  document.getElementById('dp-next').textContent = dpCur === dpSteps.length - 1 ? 'Finish ✓' : 'Next →';
  document.getElementById('dp-body').innerHTML =
    '<div class="dp-tag">' + String(dpCur+1).padStart(2,'0') + ' / ' + String(dpSteps.length).padStart(2,'0') + ' — ' + s.tag + '</div>' +
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

  const prompt = `You are a senior implementation consultant writing a formal Statement of Work for a SmartRecruiters ATS implementation. Write a complete, professional SOW based on these project details:

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

Use formal, specific, commercial language. Be concrete — include the exact numbers, integrations, and timelines provided. Make it ready to send directly to the client. Do not use placeholder text.`;

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
  const { content, clientName } = req.body;
  if (!content) return res.status(400).json({ error: 'No content' });

  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

  const lines = content.split('\n');
  const children = [];

  for (const line of lines) {
    if (line.startsWith('STATEMENT OF WORK')) {
      children.push(new Paragraph({ text: line, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
    } else if (/^\d+\.\s+[A-Z]/.test(line)) {
      children.push(new Paragraph({ text: line, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 100 } }));
    } else if (line.startsWith('━')) {
      // skip dividers
    } else if (line.startsWith('  •')) {
      children.push(new Paragraph({ text: line.replace('  •', '').trim(), bullet: { level: 0 }, spacing: { after: 60 } }));
    } else if (line.trim()) {
      children.push(new Paragraph({ children: [new TextRun({ text: line, size: 24 })], spacing: { after: 120 } }));
    } else {
      children.push(new Paragraph({ text: '' }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = 'SOW_' + (clientName || 'Client').replace(/[^a-z0-9]/gi, '_') + '.docx';
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
        subject: 'Statement of Work — SmartRecruiters Implementation — ' + (clientName || 'Client'),
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
app.get('/consultant/sow-builder', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SOW Builder — EX3</title>
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
    <a href="/consultant">← Back to Consultant Portal</a>
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
          <button class="btn btn-primary" onclick="copySow()">📋 Copy</button>
          <button class="btn btn-primary" style="background:#0d7c4c" onclick="exportWord()">⬇️ Export Word</button>
          <button class="btn btn-primary" style="background:#6b21a8" onclick="generateWithAI()">✨ Rewrite with AI</button>
          <button class="btn btn-secondary" onclick="showEmailForm()">📧 Email to client</button>
          <button class="btn btn-secondary" onclick="restartWizard()">↩ Start Again</button>
        </div>
        <div id="email-form" style="display:none;background:#f8f7f4;border:1px solid #e4e2dc;border-radius:10px;padding:20px;margin-bottom:16px">
          <p style="font-size:13px;font-weight:600;margin-bottom:12px">Send SOW by email</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <input id="email-to" type="email" placeholder="Client email address" style="flex:1;min-width:200px;padding:10px 14px;border:1.5px solid #e4e2dc;border-radius:8px;font-family:inherit;font-size:13px;outline:none">
            <button class="btn btn-primary" onclick="sendEmail()">Send</button>
          </div>
          <p id="email-status" style="font-size:12px;margin-top:8px;color:#888"></p>
        </div>
        <div id="ai-status" style="display:none;padding:12px 16px;background:#faf5ff;border:1px solid #ddd6fe;border-radius:8px;margin-bottom:16px;font-size:13px;color:#6b21a8">✨ AI is rewriting your SOW in professional language...</div>
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
            <div class="opt" onclick="selectOpt(this,'orgSize','Small (under 100 employees)')"><span class="opt-icon">🏢</span>Small — under 100 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Mid-size (100–500 employees)')"><span class="opt-icon">🏬</span>Mid-size — 100 to 500 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Large (500–2,000 employees)')"><span class="opt-icon">🏭</span>Large — 500 to 2,000 employees</div>
            <div class="opt" onclick="selectOpt(this,'orgSize','Enterprise (2,000+ employees)')"><span class="opt-icon">🌐</span>Enterprise — 2,000+ employees</div>
          </div>
        </div>

        <!-- Step 3: Number of users -->
        <div class="step" id="step-3">
          <div class="step-num">Step 3 of 19</div>
          <h2>How many users will need access?</h2>
          <p>Include all recruiters, hiring managers, and admins.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'numUsers','up to 25 users')"><span class="opt-icon">👤</span>Up to 25 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','25–50 users')"><span class="opt-icon">👥</span>25 to 50 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','50–100 users')"><span class="opt-icon">👨‍👩‍👧‍👦</span>50 to 100 users</div>
            <div class="opt" onclick="selectOpt(this,'numUsers','over 100 users')"><span class="opt-icon">🏟️</span>Over 100 users</div>
            <div class="opt" onclick="selectCustom(this,'numUsers-custom')"><span class="opt-icon">✏️</span>Custom number</div>
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
            <div class="opt" onclick="selectOpt(this,'numProcesses','1–2 hiring process workflows')"><span class="opt-icon">1️⃣</span>1 to 2 workflows</div>
            <div class="opt" onclick="selectOpt(this,'numProcesses','3–5 hiring process workflows')"><span class="opt-icon">3️⃣</span>3 to 5 workflows</div>
            <div class="opt" onclick="selectOpt(this,'numProcesses','6–10 hiring process workflows')"><span class="opt-icon">🔢</span>6 to 10 workflows</div>
            <div class="opt" onclick="selectCustom(this,'numProcesses-custom')"><span class="opt-icon">✏️</span>Custom number</div>
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
            <div class="opt" onclick="selectOpt(this,'numTemplates','up to 5 job templates')"><span class="opt-icon">📄</span>Up to 5 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','5–10 job templates')"><span class="opt-icon">📋</span>5 to 10 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','10–20 job templates')"><span class="opt-icon">📚</span>10 to 20 templates</div>
            <div class="opt" onclick="selectOpt(this,'numTemplates','no job templates required at this stage')"><span class="opt-icon">❌</span>None required</div>
            <div class="opt" onclick="selectCustom(this,'numTemplates-custom')"><span class="opt-icon">✏️</span>Custom number</div>
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
            <div class="opt" onclick="toggleMulti(this,'integrations','HRIS integration (e.g. Workday, SAP, BambooHR)')">🗄️ HRIS System</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','Single Sign-On (SSO)')">🔐 SSO</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','background screening integration')">🔍 Background Screening</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','DocuSign / e-signature integration')">✍️ DocuSign</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','video interviewing platform integration')">🎥 Video Interviews</div>
            <div class="opt" onclick="toggleMulti(this,'integrations','payroll system integration')">💰 Payroll</div>
          </div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="opt" onclick="selectOpt(this,'integrations','no third-party integrations required')">❌ No integrations needed</div>
            <div class="opt" onclick="toggleCustomMulti(this,'integrations','integrations-other-input')">✏️ Other / not listed</div>
          </div>
          <div class="custom-input" id="integrations-other-input">
            <input type="text" placeholder="e.g. Greenhouse, Workable, Microsoft Teams…" oninput="setCustomMulti('integrations','integrations-other-val',this.value)">
          </div>
        </div>

        <!-- Step 7: Job Boards -->
        <div class="step" id="step-7">
          <div class="step-num">Step 7 of 19</div>
          <h2>Which job boards need connecting?</h2>
          <p>Select all that apply. Job board credentials will need to be provided by the client.</p>
          <div class="options opt-multi" id="jobboards-options">
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Indeed')">Indeed</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','LinkedIn')">LinkedIn</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Glassdoor')">Glassdoor</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Reed')">Reed</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','CV-Library')">CV-Library</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Totaljobs')">Totaljobs</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Adzuna')">Adzuna</div>
            <div class="opt" onclick="toggleMulti(this,'jobBoards','Guardian Jobs')">Guardian Jobs</div>
          </div>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="opt" onclick="selectOpt(this,'jobBoards','no job board connections required at this stage')">❌ None at this stage</div>
            <div class="opt" onclick="toggleCustomMulti(this,'jobBoards','jobboards-other-input')">✏️ Other / not listed</div>
          </div>
          <div class="custom-input" id="jobboards-other-input">
            <input type="text" placeholder="e.g. Monster, S1 Jobs, Nijobs…" oninput="setCustomMulti('jobBoards','jobboards-other-val',this.value)">
          </div>
        </div>

        <!-- Step 8: Career Page -->
        <div class="step" id="step-8">
          <div class="step-num">Step 8 of 19</div>
          <h2>Is career page branding in scope?</h2>
          <p>This covers setting up the SmartRecruiters hosted careers page with the client's logo, colours, and imagery.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'careerPage','Configuration and branding of the SmartRecruiters careers page is included in scope. The client will provide brand assets (logo, colour palette, imagery) prior to configuration.')">✅ Yes — brand and configure the careers page</div>
            <div class="opt" onclick="selectOpt(this,'careerPage','Career page setup is not in scope for this engagement.')">❌ No — out of scope</div>
            <div class="opt" onclick="selectOpt(this,'careerPage','Basic career page configuration is included (logo and colour only). Full creative design is out of scope.')">🎨 Basic only — logo and colours only</div>
          </div>
        </div>

        <!-- Step 9: Data Migration -->
        <div class="step" id="step-9">
          <div class="step-num">Step 9 of 19</div>
          <h2>Is data migration required?</h2>
          <p>Moving historical jobs, candidates, or offer data from an existing system into SmartRecruiters.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'dataMigration','Data migration is not in scope for this engagement. Historical data will remain in the client\\'s existing system.')">❌ No migration needed</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of active job requisitions into SmartRecruiters is included in scope.')">📋 Active jobs only</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of candidate records is included in scope, subject to a data mapping exercise to be completed during discovery.')">👤 Candidate records</div>
            <div class="opt" onclick="selectOpt(this,'dataMigration','Migration of both active job requisitions and candidate records is included in scope, subject to a data mapping exercise to be completed during discovery.')">📦 Both jobs and candidates</div>
          </div>
        </div>

        <!-- Step 10: Training -->
        <div class="step" id="step-10">
          <div class="step-num">Step 10 of 19</div>
          <h2>Which training sessions are required?</h2>
          <p>Select all that apply. Each session is role-specific and delivered separately.</p>
          <div class="options opt-multi">
            <div class="opt" onclick="toggleMulti(this,'training','One Administrator training session (up to 90 minutes, covering system configuration, user management, and reporting)')">🔧 Administrator (90 mins)</div>
            <div class="opt" onclick="toggleMulti(this,'training','One Recruiter training session (up to 60 minutes, covering end-to-end hiring workflow, candidate management, and communication tools)')">📞 Recruiter (60 mins)</div>
            <div class="opt" onclick="toggleMulti(this,'training','One Hiring Manager training session (up to 45 minutes, covering job approval, candidate review, and interview scheduling)')">👔 Hiring Manager (45 mins)</div>
          </div>
        </div>

        <!-- Step 11: Hypercare -->
        <div class="step" id="step-11">
          <div class="step-num">Step 11 of 19</div>
          <h2>How long is the hypercare period?</h2>
          <p>Hypercare is the close-support window immediately after go-live where your team is on hand to resolve issues quickly.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'hypercare','2 weeks')">⚡ 2 weeks — standard</div>
            <div class="opt" onclick="selectOpt(this,'hypercare','4 weeks')">🛡️ 4 weeks — recommended for larger orgs</div>
            <div class="opt" onclick="selectOpt(this,'hypercare','6 weeks')">🔒 6 weeks — enterprise / complex implementations</div>
            <div class="opt" onclick="selectCustom(this,'hypercare-custom')">✏️ Custom</div>
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
            <div class="opt" onclick="selectOpt(this,'timeline','8 weeks')">🚀 8 weeks — small / simple implementation</div>
            <div class="opt" onclick="selectOpt(this,'timeline','10 weeks')">📅 10 weeks — standard implementation</div>
            <div class="opt" onclick="selectOpt(this,'timeline','12 weeks')">🗓️ 12 weeks — larger or more complex</div>
            <div class="opt" onclick="selectOpt(this,'timeline','16 weeks')">📆 16 weeks — enterprise / heavily integrated</div>
            <div class="opt" onclick="selectCustom(this,'timeline-custom')">✏️ Custom</div>
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
            <div class="opt" onclick="selectOpt(this,'reqApproval','No approval workflow required — recruiters can post jobs directly without sign-off.')"><span class="opt-icon">⚡</span>No approval — post directly</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','A single-level approval workflow is required (e.g. line manager or HR Director approves each requisition before posting).')"><span class="opt-icon">1️⃣</span>Single approver (e.g. HR Director)</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','A multi-level approval workflow is required (e.g. Line Manager → HR → Finance). The exact approval chain will be confirmed during discovery.')"><span class="opt-icon">🔗</span>Multi-level (e.g. Manager → HR → Finance)</div>
            <div class="opt" onclick="selectOpt(this,'reqApproval','Approval workflows vary by role type or department. Configuration of multiple approval chains is in scope, subject to discovery.')"><span class="opt-icon">🗂️</span>Different chains per department/role type</div>
          </div>
        </div>

        <!-- Step 14: Offer Management -->
        <div class="step" id="step-14">
          <div class="step-num">Step 14 of 19</div>
          <h2>Is offer management in scope?</h2>
          <p>SmartRecruiters can manage the full offer lifecycle — templates, approval, e-signature, and candidate acceptance — all in-platform.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Offer management is not in scope for this engagement. Offers will be managed outside of SmartRecruiters.')"><span class="opt-icon">❌</span>Not in scope — offers managed externally</div>
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Configuration of offer letter templates is included in scope. Approval and e-signature are not required.')"><span class="opt-icon">📄</span>Offer templates only</div>
            <div class="opt" onclick="selectOpt(this,'offerMgmt','Full offer management is in scope: offer letter templates, an offer approval workflow, and integration with e-signature (DocuSign or equivalent).')"><span class="opt-icon">✅</span>Full — templates + approval + e-signature</div>
            <div class="opt" onclick="selectCustom(this,'offerMgmt-custom')"><span class="opt-icon">✏️</span>Custom — describe below</div>
          </div>
          <div class="custom-input" id="offerMgmt-custom">
            <textarea placeholder="Describe the offer management requirements…" rows="3" oninput="answers.offerMgmt=this.value"></textarea>
          </div>
        </div>

        <!-- Step 15: Pre-screening questions -->
        <div class="step" id="step-15">
          <div class="step-num">Step 15 of 19</div>
          <h2>Are pre-screening or knockout questions required?</h2>
          <p>These are questions candidates must answer when applying — wrong answers can auto-reject them before a recruiter reviews.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'screening','No pre-screening or knockout questions are required at this stage.')"><span class="opt-icon">❌</span>Not required</div>
            <div class="opt" onclick="selectOpt(this,'screening','Basic knockout questions are required (e.g. right to work, minimum qualifications). Configuration of up to 5 standard screening questions per workflow is in scope.')"><span class="opt-icon">✅</span>Basic knockout questions (right to work, qualifications)</div>
            <div class="opt" onclick="selectOpt(this,'screening','Role-specific pre-screening question sets are required for each hiring workflow. The exact questions will be agreed during discovery. Configuration of all question sets is in scope.')"><span class="opt-icon">🎯</span>Role-specific screeners per workflow</div>
            <div class="opt" onclick="selectOpt(this,'screening','A full application form with multi-section screening questions and automatic scoring is required. This will be scoped in detail during the discovery phase.')"><span class="opt-icon">📝</span>Full scored application form</div>
          </div>
        </div>

        <!-- Step 16: Reporting & Analytics -->
        <div class="step" id="step-16">
          <div class="step-num">Step 16 of 19</div>
          <h2>What level of reporting is required?</h2>
          <p>From standard dashboards to fully custom exec-level analytics.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'reporting','Standard SmartRecruiters dashboards and out-of-the-box reports will be used. No custom report configuration is required.')"><span class="opt-icon">📊</span>Standard dashboards only</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Configuration of custom reports is in scope. Up to 5 custom report templates will be created based on requirements agreed during discovery.')"><span class="opt-icon">📈</span>Custom reports (up to 5 agreed templates)</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Executive-level dashboards and custom KPI reports are required. Reporting requirements will be captured during discovery and agreed prior to build.')"><span class="opt-icon">🏆</span>Exec dashboards and custom KPIs</div>
            <div class="opt" onclick="selectOpt(this,'reporting','Business intelligence (BI) tool integration is required (e.g. Power BI, Tableau, Looker). This will be scoped separately.')"><span class="opt-icon">🔌</span>BI tool integration (Power BI, Tableau etc.)</div>
          </div>
        </div>

        <!-- Step 17: GDPR & Compliance -->
        <div class="step" id="step-17">
          <div class="step-num">Step 17 of 19</div>
          <h2>What compliance and data privacy configuration is needed?</h2>
          <p>Select all that apply. GDPR configuration is strongly recommended for all UK/EU clients.</p>
          <div class="options opt-multi" id="compliance-options">
            <div class="opt" onclick="toggleMulti(this,'compliance','GDPR data retention policy configuration (automated deletion schedules for candidate records)')">🇪🇺 GDPR data retention</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Right-to-be-forgotten workflow configuration (candidate data deletion requests)')">🗑️ Right to be forgotten</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','EEO / diversity monitoring data collection setup')">📋 EEO / diversity monitoring</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Candidate consent and privacy notice configuration')">✅ Candidate consent notices</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','Audit trail and access log configuration')">🔍 Audit trail setup</div>
            <div class="opt" onclick="toggleMulti(this,'compliance','ISO 27001 / SOC 2 evidence documentation support')">🔒 ISO 27001 / SOC 2 support</div>
          </div>
          <div style="margin-top:10px">
            <div class="opt" onclick="selectOpt(this,'compliance','No specific compliance or data privacy configuration is required beyond platform defaults.')">❌ No specific compliance requirements</div>
          </div>
        </div>

        <!-- Step 18: Multi-country / International -->
        <div class="step" id="step-18">
          <div class="step-num">Step 18 of 19</div>
          <h2>What is the geographic scope of the implementation?</h2>
          <p>Multi-country or multilingual setups require additional configuration time.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation is for a single country (UK) with a single language. No multi-country or multi-language configuration is required.')"><span class="opt-icon">🇬🇧</span>UK only — single language</div>
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation covers multiple European markets. Multi-country configuration and at least one additional language is in scope. Specific countries and languages will be confirmed during discovery.')"><span class="opt-icon">🇪🇺</span>Multiple European markets</div>
            <div class="opt" onclick="selectOpt(this,'geoScope','The implementation is global in scope. Multi-region configuration, timezone support, and multiple languages are required. Full scope will be confirmed during discovery.')"><span class="opt-icon">🌍</span>Global — multiple regions and languages</div>
            <div class="opt" onclick="selectCustom(this,'geoScope-custom')"><span class="opt-icon">✏️</span>Custom — describe below</div>
          </div>
          <div class="custom-input" id="geoScope-custom">
            <input type="text" placeholder="e.g. UK, Ireland, and Germany" oninput="answers.geoScope=this.value">
          </div>
        </div>

        <!-- Step 19: Agency / Vendor Portal -->
        <div class="step" id="step-19">
          <div class="step-num">Step 19 of 19</div>
          <h2>Do you work with external recruitment agencies?</h2>
          <p>SmartRecruiters has a built-in vendor/agency portal for managing third-party recruiters and their submissions.</p>
          <div class="options">
            <div class="opt" onclick="selectOpt(this,'agencyPortal','No external recruitment agencies are used. Agency/vendor portal configuration is not in scope.')"><span class="opt-icon">❌</span>No agencies used</div>
            <div class="opt" onclick="selectOpt(this,'agencyPortal','External agencies are used. Basic vendor portal configuration is in scope, including agency account setup and job sharing. The number of agencies will be confirmed during discovery.')"><span class="opt-icon">🤝</span>Yes — basic agency portal setup</div>
            <div class="opt" onclick="selectOpt(this,'agencyPortal','External agencies are a core part of the hiring strategy. Full vendor management configuration is in scope: agency tiers, submission rules, fee agreements, and communication workflows.')"><span class="opt-icon">🏢</span>Yes — full vendor management (tiers, fees, rules)</div>
          </div>
        </div>

        <div class="nav">
          <button class="btn btn-secondary" id="btn-back" onclick="prevStep()" style="display:none">← Back</button>
          <button class="btn btn-primary" id="btn-next" onclick="nextStep()">Next →</button>
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
    document.getElementById('btn-next').textContent = current === TOTAL ? 'Generate SOW ✨' : 'Next →';
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
    var isMultiCountry = !!(a.geoScope && (a.geoScope.indexOf('European') >= 0 || a.geoScope.indexOf('global') >= 0 || a.geoScope.indexOf('Global') >= 0 || a.geoScope.indexOf('multi') >= 0));
    var hasFullOffer = !!(a.offerMgmt && a.offerMgmt.indexOf('Full offer') >= 0);
    var hasMultiApproval = !!(a.reqApproval && (a.reqApproval.indexOf('multi-level') >= 0 || a.reqApproval.indexOf('different chains') >= 0));
    var hasAgency = !!(a.agencyPortal && a.agencyPortal.indexOf('No external') < 0);
    var hasCareerPage = !!(a.careerPage && a.careerPage.indexOf('No dedicated') < 0 && a.careerPage.indexOf('not required') < 0);
    var longTimeline = !!(a.timeline && (a.timeline.indexOf('16') >= 0 || a.timeline.indexOf('20') >= 0 || a.timeline.indexOf('24') >= 0));
    var medTimeline = !!(a.timeline && a.timeline.indexOf('12') >= 0);

    var useEXecute = isEnterprise || intCount >= 3 || isMultiCountry || hasMigration || longTimeline || medTimeline;
    var methodology = useEXecute ? 'EXecute' : 'EXcelerate';

    var now = new Date();
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dateStr = now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
    var clientName = a.clientName || 'To be confirmed';
    var clientUpper = clientName.toUpperCase();
    var s2 = hasCareerPage ? '4.3' : '4.2';
    var s3 = hasCareerPage ? '4.4' : '4.3';
    var s4 = hasCareerPage ? '4.5' : '4.4';
    var s5 = hasCareerPage ? '4.6' : '4.5';
    var s6 = hasCareerPage ? '4.7' : '4.6';

    add('');
    add('STATEMENT OF WORK');
    add('SmartRecruiters Recruiting Implementation');
    add('');
    add('Client:         ' + clientName);
    add('Prepared by:    EX3 Consulting');
    add('Date:           ' + dateStr);
    add('Version:        1.0 (Draft)');
    add('');
    add('========================================================================');
    add('');
    add('This Statement of Work ("SOW") is entered into between EX3 Consulting');
    add('("EX3") and ' + clientName + ' ("Client") and forms part of the Master');
    add('Services Agreement between the parties. EX3 will provide SmartRecruiters');
    add('implementation consultancy services as described herein. All work will be');
    add('performed on a fixed-scope basis unless a formal Change Order is agreed in');
    add('writing by both parties.');
    add('');
    add('========================================================================');
    add('');
    add('1.  PERIOD OF PERFORMANCE');
    add('');
    add('    The project is estimated to complete within ' + (a.timeline || 'a timeline to be agreed'));
    add('    of project kick-off, subject to timely Client engagement and provision');
    add('    of required information and approvals.');
    add('');
    add('    Organisation:    ' + (a.orgSize || 'To be confirmed'));
    add('    Geography:       ' + (a.geoScope || 'To be confirmed'));
    add('    Users in scope:  ' + (a.numUsers || 'To be confirmed'));
    add('');
    add('========================================================================');
    add('');
    add('2.  ENGAGEMENT RESOURCES');
    add('');
    add('    EX3 Team');
    add('    -----------------------------------------------------------------------');
    add('    Role                          Responsibility');
    add('    -----------------------------------------------------------------------');
    add('    Engagement Lead               Overall delivery, escalation point');
    add('    Lead Implementation           Platform configuration, integrations,');
    add('    Consultant                    data migration');
    add('    Training Consultant           End-user training delivery and materials');
    add('    -----------------------------------------------------------------------');
    add('');
    add('    Client Team (required)');
    add('    -----------------------------------------------------------------------');
    add('    Role                          Responsibility');
    add('    -----------------------------------------------------------------------');
    add('    Project Owner                 Decision authority, internal coordination');
    add('    HR / TA Lead                  Requirements sign-off, UAT, go-live');
    add('    IT Representative             SSO, integrations, firewall clearance');
    add('    -----------------------------------------------------------------------');
    add('');
    add('========================================================================');
    add('');
    add('3.  IMPLEMENTATION METHODOLOGY — ' + methodology.toUpperCase());
    add('');
    if (methodology === 'EXcelerate') {
      add('    EX3 will deliver this project using the EXcelerate methodology, designed');
      add('    for streamlined SmartRecruiters deployments in focused, time-boxed');
      add('    engagements. EXcelerate is optimised for organisations seeking rapid');
      add('    time-to-value with a clearly scoped configuration.');
    } else {
      add('    EX3 will deliver this project using the EXecute methodology, designed');
      add('    for enterprise-grade SmartRecruiters deployments requiring phased');
      add('    delivery, complex integrations, multi-country scope, or significant');
      add('    data migration. EXecute provides structured governance with formal');
      add('    stakeholder sign-off at each milestone.');
    }
    add('');
    add('    Phase 1 — Discovery & Design');
    add('    Kick-off workshop, requirements capture, process mapping, platform design');
    add('    sign-off, integration scoping, data migration assessment (if applicable).');
    add('');
    add('    Phase 2 — Build & Configuration');
    add('    Platform configuration per agreed design: hiring workflows, job templates,');
    add('    user roles and permissions, approval chains, offer management, screening,');
    add('    email templates, career page, job board connections, integrations.');
    add('');
    add('    Phase 3 — Integration & Data Migration');
    if (integrationsList.length > 0 || hasMigration) {
      integrationsList.forEach(function(i) { add('    • ' + i); });
      if (hasMigration) { add('    • Data migration: ' + a.dataMigration); }
    } else {
      add('    No integrations or data migration in scope for this engagement.');
    }
    add('');
    add('    Phase 4 — Testing & UAT');
    add('    UAT test script delivery, facilitation of client UAT sessions, defect');
    add('    resolution, and written UAT sign-off prior to go-live.');
    add('');
    add('    Phase 5 — Training');
    if (trainingList.length > 0) {
      trainingList.forEach(function(t) { add('    • ' + t); });
    } else {
      add('    Training sessions to be confirmed during discovery.');
    }
    add('    All users will receive access to the EX3 SmartRecruiters Enablement Guide.');
    add('');
    add('    Phase 6 — Go-Live & Hypercare');
    add('    Go-live readiness review, production cutover support, and hypercare period.');
    add('');
    add('========================================================================');
    add('');
    add('4.  MODULE SCOPE');
    add('');
    add('4.1 Recruiting Management');
    add('');
    add('    Route Maps');
    add('    • Configuration of ' + (a.numProcesses || 'agreed number of') + ' hiring process route maps');
    add('    • Stage and status configuration aligned to ' + clientName + ' hiring workflow');
    add('');
    add('    Job Templates');
    add('    • Configuration of ' + (a.numTemplates || 'agreed number of') + ' job templates with custom fields');
    add('    • Department and location hierarchy setup');
    add('');
    add('    Application Template');
    add('    • Custom application form fields per agreed requirements');
    add('    • Screening / knockout questions: ' + (a.screening || 'to be defined during discovery'));
    add('');
    add('    Offer Management');
    add('    • ' + (a.offerMgmt || 'Offer configuration to be confirmed during discovery'));
    if (hasFullOffer) {
      add('    • Offer letter template configuration (client to provide template content)');
      add('    • E-signature integration scoped under Section ' + s2);
    }
    add('');
    add('    Approval Workflow');
    add('    • Requisition approval: ' + (a.reqApproval || 'to be confirmed during discovery'));
    if (hasMultiApproval) {
      add('    • Multi-level approval chain mapping to be completed in Phase 1 (Discovery)');
      add('    • Approval chains must be signed off by Client before Phase 2 begins');
    }
    add('');
    add('    Candidate Profile & Status Pipeline');
    add('    • Candidate profile fields and data capture configuration');
    add('    • Status pipeline aligned to route map stages');
    add('    • Rejection reason configuration');
    add('');
    add('    Email Templates');
    add('    • Application received, interview invite, rejection, and offer templates');
    add('    • Client to provide email copy and branding prior to configuration');
    add('');
    if (hasAgency) {
      add('    Agency / Vendor Portal');
      add('    • ' + a.agencyPortal);
      add('    • Agency account setup for agreed vendors (client to provide agency list)');
      add('    • Agency submission workflow and visibility controls');
      add('');
    }
    add('    Interview Scheduling');
    add('    • Interview scheduling configuration aligned to agreed route map stages');
    add('    • Calendar integration subject to integration scope (Section ' + s2 + ')');
    add('');
    add('    Recruiting Posting');
    if (jobBoardsList.length > 0) {
      add('    • Job boards: ' + jobBoardsList.join(', '));
    } else {
      add('    • Job board connections: to be confirmed during discovery');
    }
    add('    • Internal posting configuration');
    add('');
    add('    User Accounts & RBP Roles');
    add('    • Creation of ' + (a.numUsers || 'agreed number of') + ' user accounts');
    add('    • Role-Based Permission (RBP) configuration per agreed access matrix');
    add('    • EX3 to provide RBP design template; Client to complete and sign off');
    add('');
    if (hasCareerPage) {
      add('4.2 Recruiting Marketing / Career Site');
      add('');
      add('    • Career site configuration: ' + a.careerPage);
      add('    • Brand application (logo, colours, imagery) — client to provide assets');
      add('    • Job search and apply flow testing');
      add('    • Mobile responsiveness validation');
      add('');
    }
    add(s2 + ' Integrations');
    add('');
    if (integrationsList.length > 0) {
      add('    The following integrations are in scope:');
      integrationsList.forEach(function(i) { add('    • ' + i); });
      add('');
      add('    All integrations use standard SmartRecruiters Marketplace connectors.');
      add('    Custom API builds or non-standard connectors are out of scope.');
    } else {
      add('    No third-party integrations are in scope for this engagement.');
    }
    add('');
    add(s3 + ' Reporting & Analytics');
    add('');
    add('    • ' + (a.reporting || 'Standard SmartRecruiters reporting and analytics dashboards'));
    add('    • Configuration of agreed saved reports and scheduled report distribution');
    add('');
    add(s4 + ' Data Privacy & Compliance');
    add('');
    if (complianceList.length > 0) {
      add('    The following compliance configurations are in scope:');
      complianceList.forEach(function(c) { add('    • ' + c); });
    } else {
      add('    Standard SmartRecruiters data privacy defaults will be applied.');
    }
    add('');
    add(s5 + ' Data Migration');
    add('');
    add('    • ' + (a.dataMigration || 'Data migration is not in scope for this engagement'));
    if (hasMigration) {
      add('    • Data mapping document to be agreed in Phase 1 (Discovery)');
      add('    • Client responsible for data extraction in the EX3-specified format');
      add('    • Migration performed in sandbox environment first for validation');
    }
    add('');
    add(s6 + ' Training');
    add('');
    if (trainingList.length > 0) {
      add('    The following training sessions are in scope:');
      trainingList.forEach(function(t) { add('    • ' + t); });
    } else {
      add('    Training requirements to be confirmed during discovery.');
    }
    add('    • All users receive access to the EX3 SmartRecruiters Enablement Guide');
    add('    • Training materials provided in advance for pre-reading');
    add('    • Sessions recorded and shared with Client for future reference');
    add('');
    add('========================================================================');
    add('');
    add('5.  OUT OF SCOPE');
    add('');
    add('    The following are excluded from this engagement. Any such items require');
    add('    a formal Change Order signed by both parties before work begins:');
    add('');
    add('    • SmartRecruiters platform licensing fees (contracted directly between');
    add('      ' + clientName + ' and SmartRecruiters)');
    add('    • Any integrations not listed in Section ' + s2 + ' above');
    add('    • Custom API development, bespoke connectors, or non-standard builds');
    add('    • Ongoing platform administration or managed services after hypercare');
    add('    • Additional training sessions beyond those listed in Section ' + s6);
    add('    • Custom BI tool development or data warehouse integrations');
    add('    • Countries or languages beyond those agreed in Section 1');
    add('    • Recruitment process design or HR consultancy beyond configuration');
    add('    • Content creation (job descriptions, email copy, brand assets)');
    add('    • Changes arising from SmartRecruiters vendor platform updates');
    add('');
    add('========================================================================');
    add('');
    add('6.  TESTING ACTIVITIES');
    add('');
    add('    -----------------------------------------------------------------------');
    add('    Activity                          EX3             Client');
    add('    -----------------------------------------------------------------------');
    add('    Unit testing of configuration     EX3');
    add('    Integration testing               EX3');
    add('    UAT test script preparation       EX3');
    add('    UAT execution                                     Client');
    add('    Defect logging                    EX3             Client');
    add('    Critical/High defect resolution   EX3');
    add('    UAT sign-off                                      Client');
    add('    Go-live readiness review          EX3             Client');
    add('    -----------------------------------------------------------------------');
    add('');
    add('    EX3 will resolve all Critical and High priority defects raised during UAT.');
    add('    Medium and Low items after UAT sign-off are logged for post-go-live');
    add('    resolution and do not block go-live.');
    add('');
    add('========================================================================');
    add('');
    add('7.  GO-LIVE SUPPORT & HYPERCARE');
    add('');
    add('    Go-Live Day');
    add('    • EX3 Engagement Lead on-call for the duration of go-live day');
    add('    • Final production configuration checks prior to cutover');
    add('    • Real-time issue triage and resolution support');
    add('');
    add('    Hypercare Period: ' + (a.hypercare || 'to be agreed'));
    add('    • Daily check-in calls during Week 1 post go-live');
    add('    • Weekly check-in calls for the remainder of the hypercare period');
    add('    • EX3 available for issue resolution within 1 business day response time');
    add('    • Formal handover pack and post-implementation documentation at close');
    add('');
    add('========================================================================');
    add('');
    add('8.  PROJECT ASSUMPTIONS');
    add('');
    add('8.1 General');
    add('    • This SOW is based on information provided during initial scoping.');
    add('      Material changes to requirements may impact timeline, scope, and cost.');
    add('    • EX3 will not commence out-of-scope work without a signed Change Order.');
    add('');
    add('8.2 Project & Software');
    add('    • ' + clientName + ' holds a valid SmartRecruiters licence for the project duration');
    add('      including any sandbox/test environments required.');
    add('    • All integrations use standard SmartRecruiters Marketplace connectors.');
    add('    • User, workflow, and template counts do not exceed quantities stated');
    add('      in this SOW without a formal Change Order.');
    add('    • SmartRecruiters platform functionality will not materially change during');
    add('      the engagement. Vendor-driven changes are outside EX3 control and scope.');
    add('');
    add('8.3 Client Roles & Responsibilities');
    add('    • A named Project Owner with decision-making authority will be available');
    add('      throughout the engagement and will attend all key sessions.');
    add('    • Client feedback and approvals will be provided within 3 business days.');
    add('      Delays beyond this may impact project timeline.');
    add('    • All required IT access, credentials, and firewall clearance will be');
    add('      provided at least 10 business days before the integration build phase.');
    add('    • ' + clientName + ' is responsible for all content: job descriptions, email copy,');
    add('      brand assets, offer letter templates, and screening questions.');
    add('    • Approval chain definitions and RBP access matrix to be provided and');
    add('      signed off by Client before Phase 2 (Build) begins.');
    add('    • All users will complete pre-reading and attend designated training.');
    if (hasMigration) {
      add('    • Client will provide migration data in the EX3-specified format and');
      add('      within the agreed timeline. Data quality issues are Client responsibility.');
    }
    add('');
    add('8.4 Languages');
    if (isMultiCountry) {
      add('    • Translation of platform content into languages other than English is the');
      add('      responsibility of ' + clientName + '. EX3 will configure the platform to');
      add('      support the agreed languages once translations are provided.');
      add('    • Languages in scope to be confirmed and signed off in Phase 1 (Discovery).');
    } else {
      add('    • This engagement is scoped for English-language configuration only.');
      add('      Additional language requirements are out of scope (see Section 5).');
    }
    add('');
    add('========================================================================');
    add('');
    add('9.  DELIVERABLES & ACCEPTANCE CRITERIA');
    add('');
    add('    All deliverables are subject to a 5-business-day review period. If no');
    add('    written feedback is received within 5 business days, the deliverable is');
    add('    deemed accepted.');
    add('');
    add('    -----------------------------------------------------------------------');
    add('    Deliverable                         Phase  Acceptance Criteria');
    add('    -----------------------------------------------------------------------');
    add('    Discovery & Design Sign-off Doc      1     Client written approval');
    add('    RBP Access Matrix                    1     Client written approval');
    add('    Configured platform (sandbox)        2     Client written approval');
    add('    Integration test results             3     All critical tests passed');
    if (hasMigration) {
      add('    Migration validation report          3     Client data sign-off');
    }
    add('    UAT test scripts                     4     Client written approval');
    add('    UAT sign-off document                4     Signed by Client HR/TA Lead');
    add('    Training materials                   5     Delivered pre-training');
    add('    Go-live readiness checklist          6     Signed by both parties');
    add('    Post-implementation handover pack    6     5-day review window');
    add('    -----------------------------------------------------------------------');
    add('');
    add('========================================================================');
    add('');
    add('10. ISSUE MANAGEMENT & CHANGE CONTROL');
    add('');
    add('    RAID Log');
    add('    EX3 will maintain a RAID log (Risks, Assumptions, Issues, Dependencies)');
    add('    throughout the engagement. Shared with the Client at each weekly status');
    add('    call and updated in real time.');
    add('');
    add('    Change Order Process');
    add('    Any request to add, remove, or materially change scope must be submitted');
    add('    as a formal Change Order. The Change Order will document:');
    add('      • Description of the proposed change');
    add('      • Impact on timeline and project plan');
    add('      • Associated cost (if any)');
    add('      • Revised deliverables (if applicable)');
    add('');
    add('    Change Orders must be approved in writing by both parties before any');
    add('    out-of-scope work commences. Unsigned Change Orders expire after 10');
    add('    business days.');
    add('');
    add('========================================================================');
    add('');
    add('11. SIGN-OFF');
    add('');
    add('    By signing below, both parties confirm they have read, understood, and');
    add('    agree to the scope, responsibilities, and terms set out in this SOW.');
    add('');
    add('    EX3 CONSULTING');
    add('    -----------------------------------------------------------------------');
    add('    Name:          ________________________________');
    add('    Title:         ________________________________');
    add('    Signature:     ________________________________');
    add('    Date:          ________________________________');
    add('');
    add('    ' + clientUpper);
    add('    -----------------------------------------------------------------------');
    add('    Name:          ________________________________');
    add('    Title:         ________________________________');
    add('    Signature:     ________________________________');
    add('    Date:          ________________________________');
    add('');
    add('========================================================================');
    add('Prepared by EX3 Consulting  |  Confidential  |  ex3consulting.com');

    var sow = L.join('\\n');

    // ── end of SOW ──
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
    const isMultiCountry = a.geoScope && (a.geoScope.includes('European') || a.geoScope.includes('global') || a.geoScope.includes('Global'));
    const hasAgency = a.agencyPortal && !a.agencyPortal.includes('No external');
    const complianceCount = Array.isArray(a.compliance) ? a.compliance.length : 0;

    if (shortTimeline && hasHRIS && hasSSO) risks.push('HRIS + SSO + 8 weeks is very aggressive — consider extending to at least 12 weeks');
    if (shortTimeline && hasMigration) risks.push('Data migration in 8 weeks is high risk — this typically adds 2–4 weeks');
    if (isEnterprise && (shortTimeline || medTimeline)) risks.push('Enterprise organisations rarely complete in under 12 weeks — consider 16 weeks');
    if (integrations.length >= 3 && shortTimeline) risks.push(integrations.length + ' integrations in 8 weeks is very tight — each integration can take 1–2 weeks');
    if (isMultiCountry && shortTimeline) risks.push('Multi-country scope in 8 weeks is extremely ambitious — plan for at least 16 weeks');
    if (hasMultiApproval && shortTimeline) risks.push('Complex multi-level approval chains require significant configuration time — 8 weeks leaves little room for iteration');
    if (hasFullOffer && hasMigration && shortTimeline) risks.push('Full offer management + data migration + 8 weeks is very high risk — extend timeline or reduce scope');
    if (hasHRIS) warnings.push('HRIS integrations require IT involvement early — confirm credentials are available before the build phase');
    if (hasSSO) warnings.push("SSO setup requires the client's IT team — get them in the kickoff call");
    if (isLarge && a.training && Array.isArray(a.training) && a.training.length < 2) warnings.push('A large organisation with fewer than 2 training sessions may lead to low adoption — consider adding more');
    if (hasMultiApproval) warnings.push('Multi-level approval chains: map the exact approval flow in discovery before build starts — late changes are expensive');
    if (isMultiCountry) warnings.push('Multi-country/language: confirm which markets are live at go-live vs phased in later — scope creep risk is high');
    if (hasAgency) warnings.push('Agency portal: get a list of agencies and their contacts from the client early — account setup takes time');
    if (complianceCount >= 3) warnings.push('High compliance scope (' + complianceCount + ' items) — involve the client\\'s DPO or legal team in discovery');

    const banner = document.getElementById('risk-banner');
    if (risks.length === 0 && warnings.length === 0) { banner.style.display = 'none'; return; }

    let html = '';
    if (risks.length) {
      html += '<div style="font-weight:700;color:#991b1b;margin-bottom:8px">🔴 Risk flags</div>';
      html += risks.map(r => '<div style="margin-bottom:4px">• ' + r + '</div>').join('');
    }
    if (warnings.length) {
      if (risks.length) html += '<div style="margin:10px 0;border-top:1px solid #fde68a"></div>';
      html += '<div style="font-weight:700;color:#92400e;margin-bottom:8px">⚠️ Things to watch</div>';
      html += warnings.map(w => '<div style="margin-bottom:4px">• ' + w + '</div>').join('');
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
      aiStatus.textContent = 'AI generation failed — please try again.';
      aiStatus.style.background = '#fef2f2';
      aiStatus.style.color = '#991b1b';
    }
  }

  async function exportWord() {
    const content = document.getElementById('sow-doc').textContent;
    const res = await fetch('/consultant/sow-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, clientName: answers.clientName }),
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
      status.textContent = '✅ Sent successfully!';
      status.style.color = '#0d7c4c';
    } else {
      status.textContent = '❌ ' + (data.error || 'Failed to send');
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
        sc(500, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-2 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-3 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-4 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-5 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#integrations-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[1])o[1].click(); },380); });
        sc(1350, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#jobboards-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[1])o[1].click(); },300); setTimeout(function(){ if(o[3])o[3].click(); },600); });
        sc(1400, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-8 .opt'); if(o[0])o[0].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-9 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-10 .opt'); if(o[1])o[1].click(); setTimeout(function(){ if(o[2])o[2].click(); },380); });
        sc(1300, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-11 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-12 .opt'); if(o[2])o[2].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-13 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-14 .opt'); if(o[2])o[2].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-15 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-16 .opt'); if(o[1])o[1].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#compliance-options .opt'); if(o[0])o[0].click(); setTimeout(function(){ if(o[3])o[3].click(); },380); });
        sc(1300, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-18 .opt'); if(o[0])o[0].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
        sc(950, function(){ var o=document.querySelectorAll('#step-19 .opt'); if(o[0])o[0].click(); });
        sc(850, function(){ document.getElementById('btn-next').click(); });
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

// Demo presenter mode — automated split-screen product demo
app.get('/demo', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EX3 SmartRecruiters \u2014 Live Demo</title>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{font-family:'Sora',sans-serif;background:#060606;color:#fff}

/* ────── START SCREEN ────── */
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

/* ────── DEMO SHELL ────── */
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

/* ────── NARRATOR PANEL ────── */
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
</style>
</head>
<body>

<!-- ── Start screen ── -->
<div id="start-screen">
  <div class="ss-logo">EX3 <em>SmartRecruiters</em></div>
  <h1 class="ss-head">The complete<br><em>implementation platform</em></h1>
  <p class="ss-sub">Training, AI guidance, WhatsApp bot, consultant portal, and SOW builder — all in one place.</p>
  <div class="ss-pills">
    <div class="ss-pill">\uD83C\uDF93 Role-based training</div>
    <div class="ss-pill">\uD83E\uDD16 AI assistant</div>
    <div class="ss-pill">\uD83D\uDCF1 WhatsApp bot</div>
    <div class="ss-pill">\uD83E\uDDED Consultant portal</div>
    <div class="ss-pill">\uD83D\uDCDD SOW builder</div>
    <div class="ss-pill">\u2728 AI rewrite</div>
  </div>
  <button class="ss-btn" onclick="beginDemo()">\u25B6&nbsp;&nbsp;Start Demo</button>
  <p class="ss-note">Voice narration + manual next &nbsp;&middot;&nbsp; ~4 minutes &nbsp;&middot;&nbsp; 19 features</p>
</div>

<!-- ── Demo ── -->
<div id="demo">
  <div class="topbar">
    <div class="tb-logo">EX3 <em>SmartRecruiters</em></div>
    <div class="tb-step-label" id="tb-step">Step 1 of 13</div>
    <div class="tb-ctrl">
      <button class="cbtn" id="mute-btn" onclick="toggleMute()" title="Mute voice">\uD83D\uDD0A</button>
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
          <div class="wa-avatar">🤖</div>
          <div><div class="wa-hname">EX3 AI Assistant</div><div class="wa-hsub">WhatsApp · usually replies instantly</div></div>
        </div>
        <div class="wa-msgs" id="wa-msgs"></div>
        <div class="wa-typing-row">
          <div class="wa-typing-bubble" id="wa-typing">
            <div class="wa-dot-t"></div><div class="wa-dot-t"></div><div class="wa-dot-t"></div>
          </div>
        </div>
      </div>
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
          <button class="nar-btn" onclick="retryAudio()">🔄 Retry Audio</button>
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
// ── Steps ──
var steps = [
  {
    icon:'\uD83C\uDF10', title:'The EX3 Platform', url:'/', auto:[],
    voice:"Welcome to EX3's SmartRecruiters implementation platform — the complete toolkit for delivering world-class SmartRecruiters rollouts. In the next few minutes I'll show you everything it does.",
    callout:null
  },
  {
    icon:'\uD83D\uDCCB', title:'Recruiter Training', url:'/', auto:[{d:800,a:{action:'setRole',role:'rec'}}],
    voice:"Start with role-based training. Click Recruiter, and the platform reveals a complete step-by-step guide — covering every task from job posting to candidate pipeline management.",
    callout:{label:'Role-based training',text:'Dedicated guide for every recruiter task',dot:{x:50,y:14},bubble:{x:57,y:4}}
  },
  {
    icon:'\uD83D\uDC54', title:'Hiring Manager Training', url:'/', auto:[{d:700,a:{action:'setRole',role:'hm'}}],
    voice:"Switch to Hiring Manager and the content transforms instantly — application review, interview feedback, and offer approvals. Completely different view, same platform.",
    callout:{label:'Hiring Manager view',text:'Tailored content — no irrelevant clutter',dot:{x:50,y:14},bubble:{x:57,y:4}}
  },
  {
    icon:'\uD83D\uDC64', title:'Candidate & Admin Training', url:'/', auto:[{d:700,a:{action:'setRole',role:'cand'}},{d:4500,a:{action:'setRole',role:'adm'}}],
    voice:"Candidates and system administrators each get their own dedicated section. Four distinct roles, one platform — every person covered, nothing shared that shouldn't be.",
    callout:{label:'4 roles covered',text:'Candidate, Recruiter, Hiring Manager, Admin',dot:{x:50,y:14},bubble:{x:57,y:4}}
  },
  {
    icon:'\uD83E\uDD16', title:'AI Assistant', url:'/', auto:[{d:800,a:{action:'openAI'}},{d:1900,a:{action:'typeAndAsk',query:'How do I set up a hiring process in SmartRecruiters?'}}],
    voice:"The AI assistant answers any SmartRecruiters question instantly. No tickets, no waiting — type your question and get a precise, sourced answer in seconds. Available to consultants and clients alike.",
    callout:{label:'Instant AI answers',text:'Any SmartRecruiters question, answered instantly',dot:{x:88,y:86},bubble:{x:52,y:72}}
  },
  {
    icon:'\uD83D\uDCAD', title:'Conversation Memory', url:'/', auto:[{d:600,a:{action:'openAI'}},{d:3000,a:{action:'typeAndAsk',query:'What changes for high-volume hiring?'}}],
    voice:"It maintains full conversation context throughout the session. Ask a follow-up question about a complex scenario, and the AI connects the dots — just like talking to a senior consultant.",
    callout:{label:'Context memory',text:'Smart follow-ups — no repeating yourself',dot:{x:60,y:55},bubble:{x:38,y:42}}
  },
  {
    icon:'\uD83E\uDDE9', title:'One-Go Workflow', url:'/', auto:[{d:700,a:{action:'closeAI'}},{d:1500,a:{action:'openUnifiedFlow'}}],
    voice:"There is also an all-in-one workflow builder. Instead of jumping between separate guides, you can assemble the exact hiring processes you need into a single end-to-end execution path.",
    callout:{label:'One-go workflow',text:'Build one combined hiring runbook from multiple processes',dot:{x:33,y:38},bubble:{x:40,y:22}}
  },
  {
    icon:'\u2699\uFE0F', title:'Customise The Flow', url:'/', auto:[{d:700,a:{action:'setFlowProcesses',ids:['post-job','sched-interview','add-workflow','add-assessment'],buildNow:true}}],
    voice:"Each process is fully customisable. Pick the exact mix you want — for example posting the job, scheduling interviews, adding workflow automation, and configuring assessments — then generate the complete sequence instantly.",
    callout:{label:'Custom process mix',text:'Choose the exact processes you want in one combined flow',dot:{x:27,y:24},bubble:{x:38,y:10}}
  },
  {
    icon:'\u2728', title:'Workflow AI Assist', url:'/', auto:[{d:700,a:{action:'runUnifiedFlowAI'}}],
    voice:"Once that flow is built, EX3 can generate an AI execution checklist for it automatically — owners by role, prerequisites, handoff points, and the biggest delivery risks to watch out for.",
    callout:{label:'AI-tailored checklist',text:'Turn the selected workflow into a guided execution checklist',dot:{x:84,y:86},bubble:{x:52,y:70}}
  },
  {
    icon:'\uD83D\uDD0D', title:'Open Full Process Guide', url:'/', auto:[{d:700,a:{action:'closeAI'}},{d:1500,a:{action:'openTaskDetail',taskId:'add-workflow'}},{d:2500,a:{action:'expandTaskSteps',taskId:'add-workflow',indices:[0,1]}}],
    voice:"From any combined flow, you can jump straight into the full process guide. That opens every step in detail, along with who owns it, what must be true before you start, and the most important implementation context.",
    callout:{label:'Full process detail',text:'Open the full guide with steps, owners, prerequisites, and context',dot:{x:52,y:50},bubble:{x:60,y:28}}
  },
  {
    icon:'\u26A0\uFE0F', title:'Troubleshoot A Step', url:'/', auto:[{d:900,a:{action:'openStuck',taskId:'add-workflow',stepIdx:1}}],
    voice:"If a step is not working, every guide includes a built-in troubleshooting helper. Click the warning button and EX3 surfaces the common failure reasons, what to check first, and who can help fix it.",
    callout:{label:'Step troubleshooting',text:'Built-in stuck helper for blocked workflow steps',dot:{x:30,y:78},bubble:{x:40,y:62}}
  },
  {
    icon:'\uD83E\uDD16', title:'AI From A Blocker', url:'/', auto:[{d:900,a:{action:'askAIForStuck',taskId:'add-workflow',stepIdx:1}}],
    voice:"And if the troubleshooting hints are not enough, one click sends that exact blocked step to EX3 AI automatically. The assistant opens with the right context already loaded, so the user gets a targeted answer immediately.",
    callout:{label:'AI handoff from stuck state',text:'Escalate a blocked step to EX3 AI with the full context prefilled',dot:{x:84,y:86},bubble:{x:50,y:70}}
  },
  {
    icon:'\uD83D\uDCF1', title:'WhatsApp AI Bot',
    url:null,
    ph:{icon:'\uD83D\uDCF1',title:'WhatsApp AI Bot',body:'',link:null},
    waChat:[
      {from:'me',  text:"Hi, I can't find the Send Offer button for a candidate \u2014 any idea why?", delay:600},
      {from:'them', text:"The Send Offer button only appears once three things are in place:\\n\\n1\ufe0f\u20e3 The candidate is in the *Offer* stage\\n2\ufe0f\u20e3 The job has an active offer letter template\\n3\ufe0f\u20e3 You have the *Offer Manager* permission\\n\\nWhich one would you like to check first?", delay:1800},
      {from:'me',  text:"Probably permissions \u2014 how do I check that?", delay:5200},
      {from:'them', text:"Go to *Admin \u2192 User Management*, find your name, and look at your assigned role.\\n\\nYou need either the *Offer Manager* role, or a custom role with the *Create Offer* permission enabled.\\n\\nIf it's missing your SR admin can add it in about 2 minutes. \uD83D\uDC4D", delay:7000}
    ],
    auto:[],
    voice:"The same AI is available 24/7 on WhatsApp. No app to install, no login required — consultants and clients just message the bot and get an expert answer, even via voice note.",
    callout:{label:'WhatsApp AI bot',text:'Same expert answers via WhatsApp — no login needed',dot:{x:50,y:50},bubble:{x:55,y:32}}
  },
  {
    icon:'\uD83E\uDDED', title:'Consultant Portal', url:'/consultant',
    auto:[{d:800,a:{action:'showPhases'}},{d:1700,a:{action:'openPhase',index:0}},{d:3500,a:{action:'openPhase',index:1}},{d:5300,a:{action:'openPhase',index:2}},{d:7100,a:{action:'openPhase',index:3}}],
    voice:"The consultant portal is your implementation command centre. Six phases — Discovery, Build, Integration, Testing, Training, Go-Live — each with detailed checklists, responsibilities, and timelines.",
    callout:{label:'Full methodology',text:'Six phases, every checklist and deliverable',dot:{x:50,y:42},bubble:{x:60,y:28}}
  },
  {
    icon:'\uD83D\uDCDD', title:'SOW Builder', url:'/consultant/sow-builder', auto:[{d:500,a:{action:'demoWalkSOW'}}], hold:24000,
    voice:"The SOW builder walks through 19 questions about the client's requirements — size, integrations, workflows, compliance, training, and more. Watch it complete every step automatically. The platform captures every detail — org size, integrations, approval chains, compliance requirements, training sessions, and go-live timeline.",
    callout:{label:'19-step wizard',text:'Guided SOW building — every requirement captured',dot:{x:50,y:32},bubble:{x:60,y:18}}
  },
  {
    icon:'\u2728', title:'AI SOW Rewrite', url:'/consultant/sow-builder', auto:[{d:1000,a:{action:'triggerAIRewrite'}}],
    voice:"One click and the AI rewrites the draft into polished, client-ready consulting language — streamed live, word by word. A complete professional Statement of Work in under a minute.",
    callout:{label:'AI rewrite',text:'GPT-4 powered — client-ready language instantly',dot:{x:50,y:54},bubble:{x:60,y:40}}
  },
  {
    icon:'\uD83D\uDCE7', title:'Export & Email', url:'/consultant/sow-builder', auto:[{d:800,a:{action:'scrollToExport'}}],
    voice:"Export the finished SOW as a formatted Word document, or email it directly to the client without leaving the platform. From generation to delivery in one click.",
    callout:{label:'One-click delivery',text:'Word export or direct email to client',dot:{x:50,y:78},bubble:{x:60,y:64}}
  },
  {
    icon:'\uD83D\uDCAC', title:'Conversation History',
    url:null,
    ph:{icon:'\uD83D\uDCAC',title:'Conversation History',body:'Every web chat and WhatsApp session stored as a searchable, replayable thread. Nothing gets lost.',link:{label:'Open Conversation History \u2197',url:'/conversations'}},
    auto:[],
    voice:"Every conversation — web and WhatsApp combined — is stored as a searchable, replayable thread. Nothing gets lost between consultants or sessions.",
    callout:null
  },
  {
    icon:'\uD83D\uDE80', title:"What's Next", url:'/', auto:[{d:600,a:{action:'setRole',role:'rec'}}],
    voice:"That's the EX3 SmartRecruiters platform. Role training, AI assistant, one-go workflow building, step-level troubleshooting, WhatsApp bot, consultant tools, SOW generation, and conversation history — all in one place. Ready to use on your next engagement.",
    callout:null
  }
];

// ── State ──
var cur = 0, prevCur = -1, paused = false, muted = false;
var autoTimers = [], advTimer = null;
var narrationStepToken = 0;
var currentAudio = null;
var frameInteracted = false;

// ── Frame crossfade ──
function flashFrame(){
  var el=document.getElementById('frame-fade');
  if(!el) return;
  el.classList.add('in');
  setTimeout(function(){ el.classList.remove('in'); },300);
}

// ── Auto-advance ring ──
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

// ── Narration ──
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

// ── Callout ──
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

// ── Dots ──
function renderDots(){
  document.getElementById('dots-row').innerHTML = steps.map(function(_,i){
    var cls = i<cur?'dot done':i===cur?'dot cur':'dot';
    return '<div class="'+cls+'" onclick="jumpTo('+i+', true)" title="'+steps[i].title+'"></div>';
  }).join('');
  document.getElementById('prog-fill').style.width = Math.round((cur+1)/steps.length*100)+'%';
}

// ── Step pill ──
function showPill(s, idx){
  var el = document.getElementById('step-pill');
  el.classList.remove('show');
  document.getElementById('pill-icon').textContent = s.icon;
  document.getElementById('pill-title').textContent = s.title;
  setTimeout(function(){ el.classList.add('show'); }, 150);
  setTimeout(function(){ el.classList.remove('show'); }, 4500);
}

// ── postMessage ──
function postToFrame(msg){
  try{ document.getElementById('liveFrame').contentWindow.postMessage(Object.assign({type:'EX3_DEMO'},msg),'*'); }catch(e){}
}

var waTimers = [];
function clearWaChat(){
  waTimers.forEach(clearTimeout); waTimers = [];
  var shell = document.getElementById('wa-shell');
  if(shell) shell.classList.remove('active');
  var msgs = document.getElementById('wa-msgs');
  if(msgs) msgs.innerHTML = '';
  var typ = document.getElementById('wa-typing');
  if(typ) typ.classList.remove('show');
}
function startWaChat(msgs){
  var list = document.getElementById('wa-msgs');
  var typ = document.getElementById('wa-typing');
  if(!list) return;
  var now = new Date();
  var ts = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  msgs.forEach(function(msg){
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
      }, msg.delay));
    } else {
      waTimers.push(setTimeout(function(){
        var b = document.createElement('div');
        b.className = 'wa-bubble me';
        b.textContent = msg.text;
        var t = document.createElement('span'); t.className='wa-time';
        t.innerHTML = ts + ' <span class="wa-tick">✓✓</span>';
        b.appendChild(t);
        list.appendChild(b);
        setTimeout(function(){ b.classList.add('show'); },20);
        list.scrollTop = list.scrollHeight;
      }, msg.delay));
    }
  });
}

function clearAuto(){
  autoTimers.forEach(function(t){ clearTimeout(t); }); autoTimers = [];
  if(advTimer){ clearTimeout(advTimer); advTimer = null; }
  stopAutoAdvance();
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

// ── Render ──
function render(){
  if(paused) return;
  var s = steps[cur];
  var stepToken = ++narrationStepToken;
  frameInteracted = false;
  document.getElementById('tb-step').textContent = 'Step '+(cur+1)+' of '+steps.length;
  document.getElementById('nar-tag').textContent = s.icon+'  '+s.title;
  document.getElementById('nar-pb-fill').style.width = '0%';
  renderDots();
  showPill(s, cur);
  clearAuto();
  hideCallout();
  stopAudio();
  document.getElementById('bars').classList.remove('speaking');

  // Frame
  if(s.url){
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
    document.getElementById('ph').style.display = 'flex';
    clearWaChat();
    if(s.waChat){
      document.getElementById('ph-icon').textContent = '';
      document.getElementById('ph-title').textContent = '';
      document.getElementById('ph-body').textContent = '';
      document.getElementById('ph-cta').style.display = 'none';
      document.getElementById('wa-shell').classList.add('active');
      startWaChat(s.waChat);
    } else {
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
  var calloutTimer = setTimeout(function(){ showCallout(s.callout); }, 1500);
  autoTimers.push(calloutTimer);

  // Speak, then auto-advance after 5 s
  speak(s.voice, function(){
    if(stepToken !== narrationStepToken) return;
    if(paused) return;
    if(cur < steps.length-1) startAutoAdvance(10, function(){ go(1); });
  }, stepToken);
}

// ── Controls ──
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
  btn.textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
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

// ── Begin ──
function beginDemo(){
  var ss = document.getElementById('start-screen');
  ss.classList.add('fade');
  setTimeout(function(){
    ss.style.display = 'none';
    document.getElementById('demo').classList.add('show');
    render();
  }, 600);
}

// ── Count-up stats on load ──
(function(){
  var targets = [{id:'stat-features',val:19},{id:'stat-roles',val:4},{id:'stat-time',val:4}];
  targets.forEach(function(t,idx){
    setTimeout(function(){
      var el = document.getElementById(t.id); if(!el) return;
      var count=0, step=1, dur=700, interval=Math.round(dur/t.val);
      var iv = setInterval(function(){
        count += step;
        el.textContent = count;
        if(count >= t.val){ el.textContent = t.val; clearInterval(iv); }
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
<title>Conversation History — EX3</title>
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

  const label = t.source === 'whatsapp' ? 'WhatsApp — ' + t.id : 'Web Chat — ' + t.id.slice(-12);
  document.getElementById('chat-header').style.display = 'block';
  document.getElementById('chat-header-title').textContent = label;
  document.getElementById('chat-header-sub').textContent =
    t.msgs.length + ' messages · Started ' + new Date(t.msgs[0].ts).toLocaleString();

  const el = document.getElementById('chat-messages');
  el.innerHTML = t.msgs.map(m => {
    const q = m.question || m.body || '';
    const a = m.answer || m.response || '';
    const ts = new Date(m.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const uncertainBadge = m.uncertain ? '<span class="uncertain-badge">⚠ Uncertain answer</span>' : '';
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
        '<div class="msg-time">' + ts + ' · ' + (m.ms ? (m.ms/1000).toFixed(1) + 's' : '') + '</div>' +
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

app.listen(PORT, () => {
  if (!process.env.ASSISTANT_ID) {
    console.warn('⚠  ASSISTANT_ID not set — run "node setup.js" first to upload your documents.');
  }
  console.log(`EX3 Guide running at http://localhost:${PORT}`);
});
