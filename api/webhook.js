// Vercel serverless function — Telegram bot webhook.
//
// Commands / flows:
//   • Send image as FILE/DOCUMENT  → preview of how the card will look.
//                                    Resend the same image with caption
//                                    `confirm` (or `yes` / `ok`) to commit.
//   • /list                        → list all project images grouped by section.
//   • /delete Filename.jpg         → delete file from src/projectadd on GitHub.
//   • /help                        → usage reminder.
//
// Env vars (set in Vercel dashboard):
//   TELEGRAM_BOT_TOKEN   — from @BotFather
//   GITHUB_TOKEN         — fine-grained PAT, Contents:write on target repo
//   GITHUB_OWNER         — e.g. "noorul-misbah"
//   GITHUB_REPO          — e.g. "karaikal-showcase-web"
//   GITHUB_BRANCH        — defaults to "main"

const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_REPO    = process.env.GITHUB_REPO;
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';

const GH_CONTENTS_PATH = 'src/projectadd';

const VALID_TYPES     = ['ongoing', 'karaikal', 'chennai', 'other'];
const VALID_EXTS      = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_BYTES       = 5 * 1024 * 1024; // 5 MB
const CONFIRM_TOKENS  = ['confirm', 'yes', 'ok', 'y'];

// In-memory dedup of Telegram update_ids. Survives warm invocations on the
// same container; harmless on cold start (worst case: one duplicate slips
// through, but the GitHub upload is idempotent via sha lookup). For stronger
// guarantees, swap this for Vercel KV / Upstash Redis.
const SEEN_UPDATES = new Set();
const SEEN_MAX = 200;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  // Anything that isn't a POST is a stray visitor / health check.
  if (req.method !== 'POST') {
    return res.status(200).send('cosmos-bot webhook alive');
  }

  // ACK Telegram immediately. Any further errors below get swallowed into
  // Vercel logs so Telegram doesn't retry the webhook indefinitely.
  // (Vercel Node runtime keeps async work alive until the function settles,
  // so `res.end()` followed by awaits in the same tick is unsafe — we instead
  // rely on fast paths for dedup/help and keep the real work awaited.)
  try {
    const body = req.body || {};

    // Dedup by update_id — Telegram retries on slow responses.
    if (typeof body.update_id === 'number') {
      if (SEEN_UPDATES.has(body.update_id)) {
        return res.status(200).send('dup');
      }
      SEEN_UPDATES.add(body.update_id);
      if (SEEN_UPDATES.size > SEEN_MAX) {
        // Trim oldest entries so the set doesn't grow unbounded.
        const iter = SEEN_UPDATES.values();
        for (let i = 0; i < SEEN_MAX / 2; i++) SEEN_UPDATES.delete(iter.next().value);
      }
    }

    const message = body.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text   = (message.text || '').trim();
    const caption = (message.caption || '').trim();

    // ---- Commands ----
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await sendMessage(chatId, helpText());
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

    // ---- Upload (document) ----
    if (message.document) {
      const confirmed = CONFIRM_TOKENS.includes(caption.toLowerCase());
      await handleUpload(chatId, message.document, confirmed);
      return res.status(200).send('ok');
    }

    // ---- Fallback ----
    await sendMessage(chatId, helpText());
    return res.status(200).send('ok');

  } catch (err) {
    console.error(err?.response?.data || err.message);
    // Still 200 so Telegram stops hammering us.
    return res.status(200).send('ok');
  }
};

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

function helpText() {
  return (
    'Cosmos project bot.\n\n' +
    'Add a project:\n' +
    '  Send an image as a FILE/DOCUMENT.\n' +
    '  Filename: Name_Category(Location)_Detail.jpg\n' +
    '    Category = Ongoing | Karaikal | Chennai | Other\n' +
    '    (Location) and _Detail are optional.\n' +
    '  Caption `confirm` commits immediately. Without caption you get a preview.\n' +
    '  Examples:\n' +
    '    Ruby_Ongoing(Karaikal).jpg\n' +
    '    Ruby_Ongoing(Karaikal)_42Plots.jpg\n' +
    '    Zume_Karaikal_42Plots.jpg\n\n' +
    'Other commands:\n' +
    '  /list                → list all project images\n' +
    '  /delete Filename.jpg → remove a project\n' +
    '  /help                → this message'
  );
}

// ---------------------------------------------------------------------------
// Upload (validate → preview → commit)
// ---------------------------------------------------------------------------

async function handleUpload(chatId, doc, confirmed) {
  const filename = doc.file_name || '';

  // 1. Extension whitelist.
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!VALID_EXTS.includes(ext)) {
    await sendMessage(chatId,
      `Unsupported file type: .${ext || '(none)'}\n\n` +
      `Allowed: ${VALID_EXTS.map(e => '.' + e).join(', ')}`
    );
    return;
  }

  // 2. Size cap — block before we waste bandwidth on GitHub.
  if (typeof doc.file_size === 'number' && doc.file_size > MAX_BYTES) {
    const mb = (doc.file_size / 1024 / 1024).toFixed(1);
    await sendMessage(chatId,
      `File too large: ${mb} MB (max ${MAX_BYTES / 1024 / 1024} MB).`
    );
    return;
  }

  // 3. Filename parse: Name_Category[(Location)][_Detail].ext
  const parsed = parseFilename(filename);
  if (!parsed) {
    await sendMessage(chatId,
      `Invalid filename format.\n\n` +
      `Use: Name_Category(Location)_Detail.jpg\n` +
      `Category must be: Ongoing, Karaikal, Chennai, or Other\n\n` +
      `Examples:\n` +
      `  Ruby_Ongoing(Karaikal).jpg\n` +
      `  Zume_Karaikal_42Plots.jpg`
    );
    return;
  }

  // 4. Preview step — unless user already sent caption `confirm`.
  if (!confirmed) {
    const exists = Boolean(await ghGetSha(filename));
    const previewLines = [
      `Preview:`,
      `  Name      : ${parsed.name}`,
      `  Section   : ${parsed.categoryLabel} Projects`,
      `  Location  : ${parsed.location}`,
      parsed.detail ? `  Badge     : ${parsed.detail}` : null,
      `  Action    : ${exists ? 'UPDATE existing image' : 'ADD new image'}`,
      ``,
      `To commit: resend this image with caption:  confirm`,
    ].filter(Boolean);
    await sendMessage(chatId, previewLines.join('\n'));
    return;
  }

  // 5. Commit — download from Telegram, base64, PUT to GitHub.
  await sendMessage(chatId, `Receiving: ${filename}...`);

  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`
  );
  const filePath = fileInfo.data.result.file_path;

  const fileRes = await axios.get(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`,
    { responseType: 'arraybuffer' }
  );
  const fileContent = Buffer.from(fileRes.data).toString('base64');

  const sha = await ghGetSha(filename);

  await axios.put(
    ghContentsUrl(filename),
    {
      message: `${sha ? 'Update' : 'Add'} project image: ${filename}`,
      content: fileContent,
      branch: GITHUB_BRANCH,
      ...(sha && { sha }),
    },
    { headers: ghHeaders() }
  );

  await sendMessage(chatId,
    `Done. ${filename} has been ${sha ? 'updated' : 'added'}.\n\n` +
    `Vercel is deploying — the card will appear on the site in ~60 seconds.`
  );
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

  // Group by category (from filename) so the list mirrors the site sections.
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
    lines.push(``, `${label} (${arr.length}):`);
    for (const name of arr.sort()) lines.push(`  ${name}`);
  }
  lines.push(``, `Delete with: /delete Filename.jpg`);

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
      `Example: /delete RubyGarden_Karaikal.jpg\n\n` +
      `Tip: use /list to see all filenames.`
    );
    return;
  }
  const filename = m[1].trim();

  // Guardrail: no path traversal, no subdirectories.
  if (filename.includes('/') || filename.includes('..')) {
    await sendMessage(chatId, `Filename must be a plain filename, no slashes.`);
    return;
  }

  const sha = await ghGetSha(filename);
  if (!sha) {
    await sendMessage(chatId, `Not found: ${filename}\n\nRun /list to see available files.`);
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
    `Vercel is deploying — the card will disappear in ~60 seconds.`
  );
}

// ---------------------------------------------------------------------------
// Filename parser — mirrors the frontend in src/lib/projects.ts
// ---------------------------------------------------------------------------

function parseFilename(filename) {
  const base = filename.replace(/\.[^/.]+$/, '');
  const parts = base.split('_');
  if (parts.length < 2) return null;

  const [namePart, rawTypePart, ...rest] = parts;

  // Split "Ongoing(Karaikal)" → type "Ongoing", location "Karaikal".
  let typeToken = rawTypePart;
  let locationOverride;
  const locMatch = rawTypePart.match(/^([^()]+)\(([^()]+)\)$/);
  if (locMatch) {
    typeToken = locMatch[1];
    locationOverride = locMatch[2];
  }

  const typeLc = typeToken.toLowerCase();
  if (!VALID_TYPES.includes(typeLc)) return null;

  const categoryLabel = typeToken.charAt(0).toUpperCase() + typeLc.slice(1);
  const location = titleCase(locationOverride || categoryLabel);
  const detail = rest.length ? titleCase(rest.join('_')) : undefined;
  const name = titleCase(namePart);

  return { name, categoryLabel, location, detail };
}

function titleCase(raw) {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
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
// Telegram helper
// ---------------------------------------------------------------------------

async function sendMessage(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: chatId, text }
  );
}
