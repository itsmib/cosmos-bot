// Vercel serverless function — Telegram bot webhook (conversational flow).
//
// Flow:
//   1. User sends a photo or document (any filename / no filename).
//   2. Bot asks: Name → Category → Location (optional) → Badge (optional).
//   3. Bot queues the item, asks "add more or commit?".
//   4. Repeat, or user sends /commit to push all queued items.
//   5. Bot builds the canonical filename from answers and commits each to
//      src/projectadd/ on GitHub.
//
// Other commands:
//   /list, /delete Filename.jpg, /cancel, /help
//
// Env vars (Vercel dashboard):
//   TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH

const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_REPO    = process.env.GITHUB_REPO;
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';

const GH_CONTENTS_PATH = 'src/projectadd';

const VALID_TYPES = ['Ongoing', 'Karaikal', 'Chennai', 'Other'];
const VALID_EXTS  = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_BYTES   = 5 * 1024 * 1024;
const YES_TOKENS  = ['yes', 'y', 'ok', 'confirm', 'commit'];
const NO_TOKENS   = ['no', 'n', 'cancel', 'skip'];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
//
// SESSIONS[chatId] = {
//   step: 'idle' | 'name' | 'category' | 'location' | 'detail' | 'more',
//   current: { fileId, ext, name?, category?, location?, detail? } | null,
//   queue: Array<{ fileId, ext, name, category, location?, detail? }>,
//   updatedAt: number,
// }
//
// Survives warm Vercel invocations; wiped on cold start. If that happens
// mid-conversation, the user just starts over — /cancel clears state too.
// For cross-container persistence swap this for Upstash Redis.
const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle → session stale

// Dedup Telegram retries.
const SEEN_UPDATES = new Set();
const SEEN_MAX = 200;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('cosmos-bot webhook alive');
  }

  try {
    const body = req.body || {};

    if (typeof body.update_id === 'number') {
      if (SEEN_UPDATES.has(body.update_id)) return res.status(200).send('dup');
      SEEN_UPDATES.add(body.update_id);
      if (SEEN_UPDATES.size > SEEN_MAX) {
        const iter = SEEN_UPDATES.values();
        for (let i = 0; i < SEEN_MAX / 2; i++) SEEN_UPDATES.delete(iter.next().value);
      }
    }

    const message = body.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text   = (message.text || '').trim();

    // ---- Global commands (work in any state) ----
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await sendMessage(chatId, helpText());
      return res.status(200).send('ok');
    }
    if (text.startsWith('/cancel')) {
      SESSIONS.delete(chatId);
      await sendMessage(chatId, 'Cancelled. Session cleared.');
      return res.status(200).send('ok');
    }
    if (text.startsWith('/list')) {
      await handleList(chatId);
      return res.status(200).send('ok');
    }
    if (text.startsWith('/delete')) {
      await handleDelete(chatId, text);
      return res.status(200).send('ok');
    }
    if (text.startsWith('/commit')) {
      await handleCommit(chatId);
      return res.status(200).send('ok');
    }
    if (text.startsWith('/queue')) {
      await handleQueue(chatId);
      return res.status(200).send('ok');
    }

    // ---- Conversation flow ----
    await routeMessage(chatId, message, text);
    return res.status(200).send('ok');

  } catch (err) {
    console.error(err?.response?.data || err.message);
    return res.status(200).send('ok');
  }
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function routeMessage(chatId, message, text) {
  const session = getSession(chatId);

  // New image arrives — begin a new item. Accept both document and photo.
  const incoming = extractIncomingMedia(message);
  if (incoming) {
    // If user was mid-flow, abandon the previous partial item; newest wins.
    if (session.current && session.step !== 'idle' && session.step !== 'more') {
      await sendMessage(chatId, 'Switching to the new image. Previous partial entry discarded.');
    }
    if (incoming.warn) {
      await sendMessage(chatId, incoming.warn);
    }
    session.current = {
      fileId: incoming.fileId,
      ext: incoming.ext,
      fileSize: incoming.fileSize,
    };
    session.step = 'name';
    touch(session);
    await sendMessage(chatId,
      `Got it. Let's fill in the details.\n\n` +
      `1/4  What's the **property name**?  (e.g. Ruby Garden)\n\n` +
      `Send /cancel to abort.`
    );
    return;
  }

  // No image, no command — interpret as an answer to whatever we're asking.
  switch (session.step) {
    case 'name':     return onName(chatId, session, text);
    case 'category': return onCategory(chatId, session, text);
    case 'location': return onLocation(chatId, session, text);
    case 'detail':   return onDetail(chatId, session, text);
    case 'more':     return onMore(chatId, session, text);
    default:
      // Idle — guide the user.
      await sendMessage(chatId, helpText());
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function onName(chatId, session, text) {
  if (!text) {
    await sendMessage(chatId, 'Please send the property name as text.');
    return;
  }
  // Only enforce that the name reduces to something alphanumeric-ish.
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z0-9]/.test(cleaned)) {
    await sendMessage(chatId, 'Name must contain letters or numbers. Try again.');
    return;
  }
  if (cleaned.length > 60) {
    await sendMessage(chatId, 'Name is too long (max 60 characters). Try again.');
    return;
  }
  session.current.name = cleaned;
  session.step = 'category';
  touch(session);
  await sendMessage(chatId,
    `2/4  Which **section**?  Reply with one:\n` +
    `  • Ongoing\n` +
    `  • Karaikal\n` +
    `  • Chennai\n` +
    `  • Other`
  );
}

async function onCategory(chatId, session, text) {
  const match = VALID_TYPES.find(t => t.toLowerCase() === text.toLowerCase());
  if (!match) {
    await sendMessage(chatId,
      `Not a valid section. Reply with exactly one of:\n` +
      `Ongoing, Karaikal, Chennai, Other`
    );
    return;
  }
  session.current.category = match;
  session.step = 'location';
  touch(session);
  await sendMessage(chatId,
    `3/4  **Location** to display on the card?  (optional)\n\n` +
    `Useful for Ongoing cards so viewers see the city.\n` +
    `Reply with a city name, or send "skip" to use "${match}".`
  );
}

async function onLocation(chatId, session, text) {
  const skip = NO_TOKENS.includes(text.toLowerCase()) || text === '-' || text === '';
  if (!skip) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9 ]+$/.test(cleaned)) {
      await sendMessage(chatId, 'Location can only contain letters, numbers, and spaces. Try again, or send "skip".');
      return;
    }
    if (cleaned.length > 30) {
      await sendMessage(chatId, 'Location too long (max 30 chars). Try again, or send "skip".');
      return;
    }
    session.current.location = cleaned;
  }
  session.step = 'detail';
  touch(session);
  await sendMessage(chatId,
    `4/4  **Badge text**?  (optional)\n\n` +
    `Shown as a small crimson pill on the card, e.g. "42 Plots".\n` +
    `Reply with the text, or send "skip" for no badge.`
  );
}

async function onDetail(chatId, session, text) {
  const skip = NO_TOKENS.includes(text.toLowerCase()) || text === '-' || text === '';
  if (!skip) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9 ]+$/.test(cleaned)) {
      await sendMessage(chatId, 'Badge can only contain letters, numbers, and spaces. Try again, or send "skip".');
      return;
    }
    if (cleaned.length > 30) {
      await sendMessage(chatId, 'Badge too long (max 30 chars). Try again, or send "skip".');
      return;
    }
    session.current.detail = cleaned;
  }

  // All fields collected — move the item into the queue.
  const item = finaliseItem(session.current);
  session.queue.push(item);
  session.current = null;
  session.step = 'more';
  touch(session);

  await sendMessage(chatId,
    `✓ Queued #${session.queue.length}:\n` +
    formatItem(item) + '\n\n' +
    `Send another image to add more, or reply:\n` +
    `  yes  → commit everything now\n` +
    `  no   → cancel all queued items`
  );
}

async function onMore(chatId, session, text) {
  const lc = text.toLowerCase();
  if (YES_TOKENS.includes(lc)) {
    await handleCommit(chatId);
    return;
  }
  if (NO_TOKENS.includes(lc)) {
    SESSIONS.delete(chatId);
    await sendMessage(chatId, 'All queued items discarded. Session cleared.');
    return;
  }
  await sendMessage(chatId,
    `Not sure what you meant. Send another image to queue more,\n` +
    `or reply "yes" to commit, "no" to cancel.\n\n` +
    `/queue to review what's queued.`
  );
}

// ---------------------------------------------------------------------------
// Commit queued items
// ---------------------------------------------------------------------------

async function handleCommit(chatId) {
  const session = SESSIONS.get(chatId);
  if (!session || session.queue.length === 0) {
    await sendMessage(chatId, 'Nothing queued. Send an image to start.');
    return;
  }

  await sendMessage(chatId, `Committing ${session.queue.length} item${session.queue.length === 1 ? '' : 's'}...`);

  const results = [];
  for (const item of session.queue) {
    try {
      const outcome = await commitItem(item);
      results.push(`✓ ${outcome.action} ${outcome.filename}`);
    } catch (e) {
      const msg = e?.response?.data?.message || e.message;
      results.push(`✗ ${item.filename}: ${msg}`);
    }
  }

  SESSIONS.delete(chatId);
  await sendMessage(chatId,
    results.join('\n') + '\n\n' +
    `Vercel is deploying — site updates in ~60s.`
  );
}

async function commitItem(item) {
  // 1. Download from Telegram.
  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${item.fileId}`
  );
  const filePath = fileInfo.data.result.file_path;

  const fileRes = await axios.get(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`,
    { responseType: 'arraybuffer' }
  );
  const size = fileRes.data.byteLength;
  if (size > MAX_BYTES) {
    throw new Error(`File too large: ${(size / 1024 / 1024).toFixed(1)} MB (max 5 MB).`);
  }
  const contentBase64 = Buffer.from(fileRes.data).toString('base64');

  // 2. Existing? Fetch sha to overwrite.
  const sha = await ghGetSha(item.filename);

  // 3. PUT to GitHub.
  await axios.put(
    ghContentsUrl(item.filename),
    {
      message: `${sha ? 'Update' : 'Add'} project image: ${item.filename}`,
      content: contentBase64,
      branch: GITHUB_BRANCH,
      ...(sha && { sha }),
    },
    { headers: ghHeaders() }
  );

  return { action: sha ? 'updated' : 'added', filename: item.filename };
}

// ---------------------------------------------------------------------------
// /queue — show what's pending
// ---------------------------------------------------------------------------

async function handleQueue(chatId) {
  const session = SESSIONS.get(chatId);
  if (!session || session.queue.length === 0) {
    await sendMessage(chatId, 'Queue is empty.');
    return;
  }
  const lines = [`Queued (${session.queue.length}):`];
  session.queue.forEach((item, i) => {
    lines.push('', `${i + 1}. ${item.filename}`);
    lines.push(`   ${item.name} · ${item.category}${item.location ? ' · ' + item.location : ''}${item.detail ? ' · ' + item.detail : ''}`);
  });
  lines.push('', 'Reply "yes" to commit, "no" to cancel, or send another image.');
  await sendMessage(chatId, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// /list
// ---------------------------------------------------------------------------

async function handleList(chatId) {
  let entries;
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}`,
      { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } }
    );
    entries = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    if (e?.response?.status === 404) {
      await sendMessage(chatId, 'No projects yet — the folder is empty.');
      return;
    }
    throw e;
  }

  const files = entries.filter(e => e.type === 'file');
  if (files.length === 0) {
    await sendMessage(chatId, 'No projects yet — the folder is empty.');
    return;
  }

  const buckets = { Ongoing: [], Karaikal: [], Chennai: [], Other: [], _: [] };
  for (const f of files) {
    const parsed = parseFilename(f.name);
    const key = parsed ? parsed.categoryLabel : '_';
    buckets[key].push(f.name);
  }

  const sections = [
    ['Ongoing',  'Ongoing'],
    ['Karaikal', 'Karaikal'],
    ['Chennai',  'Chennai'],
    ['Other',    'Other'],
    ['_',        'Unparseable'],
  ];

  const lines = [`${files.length} project image${files.length === 1 ? '' : 's'}:`];
  for (const [key, label] of sections) {
    const arr = buckets[key];
    if (!arr || arr.length === 0) continue;
    lines.push('', `${label} (${arr.length}):`);
    for (const name of arr.sort()) lines.push(`  ${name}`);
  }
  lines.push('', `Delete with: /delete Filename.jpg`);
  await sendMessage(chatId, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// /delete
// ---------------------------------------------------------------------------

async function handleDelete(chatId, text) {
  const m = text.match(/^\/delete(?:@\S+)?\s+(.+?)\s*$/i);
  if (!m) {
    await sendMessage(chatId,
      `Usage: /delete Filename.jpg\n\n` +
      `Tip: use /list to see exact filenames.`
    );
    return;
  }
  const filename = m[1].trim();

  if (filename.includes('/') || filename.includes('..')) {
    await sendMessage(chatId, 'Filename must be a plain filename.');
    return;
  }

  const sha = await ghGetSha(filename);
  if (!sha) {
    await sendMessage(chatId, `Not found: ${filename}`);
    return;
  }

  await axios.delete(ghContentsUrl(filename), {
    headers: ghHeaders(),
    data: {
      message: `Remove project image: ${filename}`,
      sha,
      branch: GITHUB_BRANCH,
    },
  });

  await sendMessage(chatId,
    `Deleted ${filename}.\n\n` +
    `Site updates in ~60s.`
  );
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpText() {
  return (
    'Cosmos project bot.\n\n' +
    'To add projects:\n' +
    '  1. Send a photo or a file.\n' +
    '  2. I\'ll ask for name, section, location, badge.\n' +
    '  3. Send more images to queue more.\n' +
    '  4. Reply "yes" or /commit to push everything.\n\n' +
    'Commands:\n' +
    '  /list   — show what\'s live on the site\n' +
    '  /queue  — show items waiting to commit\n' +
    '  /commit — commit the queue now\n' +
    '  /cancel — clear the queue / abort current step\n' +
    '  /delete Filename.jpg — remove a live project\n' +
    '  /help   — this message'
  );
}

// ---------------------------------------------------------------------------
// Filename synthesis — builds canonical Name_Category(Location)_Detail.ext
// ---------------------------------------------------------------------------

function finaliseItem(current) {
  const slugName   = slug(current.name);
  const slugLoc    = current.location ? slug(current.location) : null;
  const slugDetail = current.detail   ? slug(current.detail)   : null;

  const typePart = slugLoc ? `${current.category}(${slugLoc})` : current.category;
  const parts    = [slugName, typePart];
  if (slugDetail) parts.push(slugDetail);

  const filename = `${parts.join('_')}.${current.ext}`;
  return {
    fileId:   current.fileId,
    ext:      current.ext,
    name:     current.name,
    category: current.category,
    location: current.location,
    detail:   current.detail,
    filename,
  };
}

// Collapse whitespace to PascalCase-ish slug so the parts split on "_" cleanly.
// "Ruby Garden" → "RubyGarden". Strips anything not [A-Za-z0-9].
function slug(raw) {
  return raw
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
}

function formatItem(item) {
  const lines = [
    `  File : ${item.filename}`,
    `  Name : ${item.name}`,
    `  Section: ${item.category}`,
  ];
  if (item.location) lines.push(`  Location: ${item.location}`);
  if (item.detail)   lines.push(`  Badge: ${item.detail}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Extract a photo or document from an incoming Telegram message
// ---------------------------------------------------------------------------

function extractIncomingMedia(message) {
  // Document: has original filename; preferred (no Telegram compression).
  if (message.document) {
    const d = message.document;
    const ext = guessExt(d.file_name, d.mime_type);
    if (!ext) {
      return { error: true }; // signaled below
    }
    return {
      fileId: d.file_id,
      ext,
      fileSize: d.file_size,
      warn: null,
    };
  }
  // Photo: array of sizes, pick the largest. Telegram compresses these.
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) =>
      (a.file_size || 0) >= (b.file_size || 0) ? a : b
    );
    return {
      fileId: largest.file_id,
      ext: 'jpg', // Telegram photos are always JPEG.
      fileSize: largest.file_size,
      warn: 'Note: this was sent as a compressed photo. For best quality, send as a file next time.',
    };
  }
  return null;
}

function guessExt(filename, mimeType) {
  if (filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (VALID_EXTS.includes(ext)) return ext;
  }
  if (mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/png')  return 'png';
    if (mimeType === 'image/webp') return 'webp';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getSession(chatId) {
  const now = Date.now();
  let s = SESSIONS.get(chatId);
  if (s && now - s.updatedAt > SESSION_TTL_MS) {
    // Stale — wipe.
    s = undefined;
    SESSIONS.delete(chatId);
  }
  if (!s) {
    s = { step: 'idle', current: null, queue: [], updatedAt: now };
    SESSIONS.set(chatId, s);
  }
  return s;
}

function touch(session) {
  session.updatedAt = Date.now();
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function ghContentsUrl(filename) {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}/${encodeURIComponent(filename)}`;
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cosmos-bot',
  };
}

async function ghGetSha(filename) {
  try {
    const r = await axios.get(ghContentsUrl(filename), {
      headers: ghHeaders(),
      params: { ref: GITHUB_BRANCH },
    });
    return r.data.sha;
  } catch (e) {
    if (e?.response?.status === 404) return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Filename parser — used by /list. Mirrors src/lib/projects.ts.
// ---------------------------------------------------------------------------

function parseFilename(filename) {
  const base = filename.replace(/\.[^/.]+$/, '');
  const parts = base.split('_');
  if (parts.length < 2) return null;
  const [, rawTypePart] = parts;
  let typeToken = rawTypePart;
  const locMatch = rawTypePart.match(/^([^()]+)\(([^()]+)\)$/);
  if (locMatch) typeToken = locMatch[1];
  const typeLc = typeToken.toLowerCase();
  if (!VALID_TYPES.map(t => t.toLowerCase()).includes(typeLc)) return null;
  const categoryLabel = typeToken.charAt(0).toUpperCase() + typeLc.slice(1);
  return { categoryLabel };
}

// ---------------------------------------------------------------------------
// Telegram helper — supports basic Markdown so the prompts render nicely.
// ---------------------------------------------------------------------------

async function sendMessage(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown' }
  ).catch(async (e) => {
    // If Markdown parsing fails (stray _ or * in user input echoed back),
    // retry as plain text so the user still gets the message.
    if (e?.response?.data?.description?.includes('parse')) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: chatId, text }
      );
    } else {
      throw e;
    }
  });
}
