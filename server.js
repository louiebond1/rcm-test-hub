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
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
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
    <div class="progress-label" id="progress-label">Step 1 of 12</div>
    <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:8%"></div></div>
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
          <div class="step-num">Step 1 of 12</div>
          <h2>What's the client's name?</h2>
          <p>This will appear throughout the SOW document.</p>
          <input type="text" id="client-name" placeholder="e.g. Acme Corporation" style="width:100%;padding:14px 18px;border:1.5px solid #e4e2dc;border-radius:10px;font-family:inherit;font-size:15px;outline:none" oninput="answers.clientName=this.value" onfocus="this.style.borderColor='#0f0f0f'" onblur="this.style.borderColor='#e4e2dc'">
        </div>

        <!-- Step 2: Org Size -->
        <div class="step" id="step-2">
          <div class="step-num">Step 2 of 12</div>
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
          <div class="step-num">Step 3 of 12</div>
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
          <div class="step-num">Step 4 of 12</div>
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
          <div class="step-num">Step 5 of 12</div>
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
          <div class="step-num">Step 6 of 12</div>
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
          <div class="step-num">Step 7 of 12</div>
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
          <div class="step-num">Step 8 of 12</div>
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
          <div class="step-num">Step 9 of 12</div>
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
          <div class="step-num">Step 10 of 12</div>
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
          <div class="step-num">Step 11 of 12</div>
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
          <div class="step-num">Step 12 of 12</div>
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

        <div class="nav">
          <button class="btn btn-secondary" id="btn-back" onclick="prevStep()" style="display:none">← Back</button>
          <button class="btn btn-primary" id="btn-next" onclick="nextStep()">Next →</button>
        </div>
      </div>

    </div>
  </div>

<script>
  const TOTAL = 12;
  let current = 1;
  const answers = {
    clientName: '', orgSize: '', numUsers: '', numProcesses: '',
    numTemplates: '', integrations: [], jobBoards: [], careerPage: '',
    dataMigration: '', training: [], hypercare: '', timeline: ''
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
    const a = answers;
    const integrationsList = Array.isArray(a.integrations) && a.integrations.length
      ? a.integrations.map(i => '  • ' + i).join('\\n')
      : '  • No third-party integrations required';
    const jobBoardsList = Array.isArray(a.jobBoards) && a.jobBoards.length
      ? a.jobBoards.join(', ')
      : 'none at this stage';
    const trainingList = Array.isArray(a.training) && a.training.length
      ? a.training.map(t => '  • ' + t).join('\\n')
      : '  • No training sessions specified';

    const sow = \`STATEMENT OF WORK
SmartRecruiters Implementation — \${a.clientName}
Prepared by: EX3 Consulting
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. PROJECT OVERVIEW
━━━━━━━━━━━━━━━━━━

This Statement of Work defines the scope, deliverables, timeline, and responsibilities for the implementation of SmartRecruiters for \${a.clientName}. EX3 will provide implementation consultancy services to configure, integrate, and deploy the SmartRecruiters platform in accordance with \${a.clientName}'s requirements as agreed during the discovery phase.

Organisation size: \${a.orgSize || 'To be confirmed'}
Expected project duration: \${a.timeline || 'To be confirmed'}

2. IN SCOPE
━━━━━━━━━━━

2.1 Platform Configuration
  • Configuration of company settings, branding, and system preferences
  • Creation and configuration of user roles and permissions
  • Creation of \${a.numUsers || 'agreed number of'} user accounts
  • Setup of \${a.numProcesses || 'agreed number of'} hiring process workflows
  • Configuration of \${a.numTemplates || 'agreed number of'} job templates with custom fields
  • Setup of email notification templates (application received, interview invite, rejection, offer)
  • Configuration of offer letter templates
  • Setup of interview scheduling configuration

2.2 Career Page & Advertising
  • \${a.careerPage || 'Career page setup to be confirmed'}
  • Connection of the following job boards: \${jobBoardsList}

2.3 Integrations
\${integrationsList}

2.4 Testing
  • Facilitation of User Acceptance Testing (UAT) with agreed test scripts
  • Resolution of critical and high-priority issues identified during UAT
  • Provision of written UAT sign-off template

2.5 Training
\${trainingList}
  • Access to the EX3 SmartRecruiters Enablement Guide for all users

2.6 Go-Live & Hypercare Support
  • Go-live readiness review and final production checks
  • On-call support on go-live day
  • Hypercare support period: \${a.hypercare || 'to be agreed'} post go-live (daily check-ins in week 1, weekly thereafter)
  • Post-implementation documentation and formal handover

2.7 Data Migration
  • \${a.dataMigration || 'Data migration requirements to be confirmed during discovery'}

3. OUT OF SCOPE
━━━━━━━━━━━━━━

The following are explicitly excluded from this engagement unless agreed via a separate Change Request:

  • Any integrations not listed in section 2.3 above
  • Custom development, bespoke API builds, or non-standard connectors
  • SmartRecruiters platform licensing costs (to be contracted directly between \${a.clientName} and SmartRecruiters)
  • Ongoing managed services or system administration after the hypercare period
  • Training sessions beyond those listed in section 2.5
  • Changes to scope agreed after project kick-off (subject to formal change request process)

4. CLIENT RESPONSIBILITIES
━━━━━━━━━━━━━━━━━━━━━━━━━

\${a.clientName} is responsible for:

  • Appointing a named internal project owner with authority to make decisions throughout the engagement
  • Completing the EX3 Discovery Questionnaire within 5 business days of kickoff
  • Providing timely feedback and approvals at each phase gate (within 3 business days of request)
  • Ensuring key stakeholders are available for all scheduled sessions
  • Providing IT access and credentials required for integrations (section 2.3)
  • Providing brand assets (logo, colour palette, imagery) prior to career page configuration
  • Completing UAT and providing written sign-off before go-live
  • Ensuring all users attend or watch their relevant training session prior to go-live

5. ASSUMPTIONS
━━━━━━━━━━━━━━

This SOW is based on the following assumptions. Material changes to these assumptions may impact timeline and cost:

  • \${a.clientName} holds a valid SmartRecruiters licence for the duration of the project
  • A named internal project owner will be available and responsive throughout the engagement
  • Client feedback and approvals will be provided within 3 business days of request
  • All integrations use standard SmartRecruiters Marketplace connectors — no custom development is required
  • The number of users, workflows, and templates does not exceed the quantities stated above without a Change Request
  • Go-live will occur within \${a.timeline || 'the agreed timeline'} of project kick-off. Delays caused by the client may impact timelines and costs
  • All required IT access and credentials will be provided at least 2 weeks before the integration build phase begins

6. CHANGE REQUEST PROCESS
━━━━━━━━━━━━━━━━━━━━━━━━━

Any changes to the agreed scope must be submitted as a formal Change Request by either party. Change Requests will include a description of the change, impact on timeline, and any associated cost. No out-of-scope work will commence without written approval from both parties.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prepared by EX3 Consulting | ex3-guide-production.up.railway.app
\`;

    document.getElementById('sow-doc').textContent = sow;
    document.getElementById('wizard-card').style.display = 'none';
    document.getElementById('sow-output').classList.add('show');
    document.getElementById('progress-fill').style.width = '100%';
    document.getElementById('progress-label').textContent = 'Complete ✓';
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

    if (shortTimeline && hasHRIS && hasSSO) risks.push('HRIS + SSO + 8 weeks is very aggressive — consider extending to at least 12 weeks');
    if (shortTimeline && hasMigration) risks.push('Data migration in 8 weeks is high risk — this typically adds 2–4 weeks');
    if (isEnterprise && (shortTimeline || medTimeline)) risks.push('Enterprise organisations rarely complete in under 12 weeks — consider 16 weeks');
    if (integrations.length >= 3 && shortTimeline) risks.push(integrations.length + ' integrations in 8 weeks is very tight — each integration can take 1–2 weeks');
    if (hasHRIS) warnings.push('HRIS integrations require IT involvement early — confirm credentials are available before the build phase');
    if (hasSSO) warnings.push("SSO setup requires the client's IT team — get them in the kickoff call");
    if (isLarge && a.training && Array.isArray(a.training) && a.training.length < 2) warnings.push('A large organisation with fewer than 2 training sessions may lead to low adoption — consider adding more');

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
</script>
</body>
</html>`);
});

// Web chatbot analytics page
app.all('/analytics/web', requirePassword);
app.get('/analytics/web', (req, res) => {
  const allLogs = readWebLogs();
  const search = (req.query.q || '').trim();
  const logs = search ? allLogs.filter(l => l.threadId === search) : allLogs;

  const total = logs.length;
  const errors = logs.filter(l => !l.success).length;
  const uncertain = logs.filter(l => l.uncertain).length;
  const avgMs = total ? Math.round(logs.reduce((s, l) => s + l.ms, 0) / total) : 0;

  const byDay = {};
  for (const l of logs) {
    const day = l.ts.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  const uniqueThreads = [...new Set(allLogs.map(l => l.threadId))];

  const rows = logs.slice().reverse().map(l => {
    const status = !l.success ? '❌ Error' : l.uncertain ? '⚠️ Uncertain' : '✅';
    const shortThread = l.threadId ? l.threadId.slice(-8) : '—';
    return `
    <tr>
      <td>${l.ts.replace('T', ' ').slice(0, 19)}</td>
      <td><a href="/analytics/web?q=${encodeURIComponent(l.threadId || '')}" style="color:#4a90e2;text-decoration:none;font-family:monospace" title="${escHtml(l.threadId || '')}">${shortThread}</a></td>
      <td>${escHtml(l.question)}</td>
      <td class="preview" onclick="showAnswer(this)" data-full="${escHtml(l.answer || '—')}">${escHtml(l.answer || '—').slice(0, 120)}${(l.answer || '').length > 120 ? '… <span style="color:#4a90e2;font-size:.8rem">(click to expand)</span>' : ''}</td>
      <td>${status}</td>
      <td>${(l.ms / 1000).toFixed(1)}s</td>
    </tr>`;
  }).join('');

  const dayRows = Object.entries(byDay).sort().reverse().map(([d, c]) =>
    `<tr><td>${d}</td><td>${c}</td></tr>`).join('');

  const threadOptions = uniqueThreads.map(t =>
    `<option value="${escHtml(t)}" ${search === t ? 'selected' : ''}>${escHtml(t.slice(-8))} (${allLogs.filter(l => l.threadId === t).length} msgs)</option>`
  ).join('');

  const searchLabel = search ? `— thread <strong style="font-family:monospace">${escHtml(search.slice(-8))}</strong> <a href="/analytics/web" style="font-size:.85rem;color:#4a90e2">clear</a>` : '';

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Web Chat Analytics</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; background: #f9f9f9; }
    h1 { color: #333; }
    nav { margin-bottom: 1.5rem; }
    nav a { margin-right: 1rem; color: #4a90e2; text-decoration: none; font-weight: bold; }
    nav a.active { border-bottom: 2px solid #4a90e2; }
    .cards { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .card { background: white; border-radius: 8px; padding: 1rem 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.1); min-width: 140px; }
    .card .num { font-size: 2rem; font-weight: bold; color: #4a90e2; }
    .card .label { color: #888; font-size: .85rem; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
    th { background: #4a90e2; color: white; padding: .6rem 1rem; text-align: left; }
    td { padding: .55rem 1rem; border-bottom: 1px solid #eee; font-size: .9rem; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    h2 { margin-top: 2rem; color: #555; }
    .search-bar { display: flex; gap: .5rem; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; }
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
  <nav>
    <a href="/analytics">WhatsApp</a>
    <a href="/analytics/web" class="active">Web Chat</a>
  </nav>
  <h1>Web Chat Analytics ${searchLabel}</h1>

  <form class="search-bar" method="get" action="/analytics/web">
    <select onchange="this.form.q.value=this.value;this.form.submit()" name="_pick">
      <option value="">— filter by session —</option>
      ${threadOptions}
    </select>
    <input name="q" type="hidden" value="${escHtml(req.query.q || '')}" />
    <a href="/analytics/web" style="color:#999;font-size:.9rem">Clear filter</a>
  </form>

  <div class="cards">
    <div class="card"><div class="num">${total}</div><div class="label">${search ? 'Session' : 'Total'} messages</div></div>
    <div class="card"><div class="num">${uniqueThreads.length}</div><div class="label">Sessions</div></div>
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
    <tr><th>Time</th><th>Session</th><th>Question</th><th>Answer</th><th>OK</th><th>Time</th></tr>
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

app.listen(PORT, () => {
  if (!process.env.ASSISTANT_ID) {
    console.warn('⚠  ASSISTANT_ID not set — run "node setup.js" first to upload your documents.');
  }
  console.log(`EX3 Guide running at http://localhost:${PORT}`);
});
