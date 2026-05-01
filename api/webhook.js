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

const VALID_TYPES = ['Ongoing', 'Karaikal', 'Chennai', 'Renovation', 'Other'];
const RENO_VARIANTS = ['Before', 'After'];
const VALID_EXTS  = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_BYTES   = 5 * 1024 * 1024;
const YES_TOKENS  = ['yes', 'y', 'ok', 'confirm', 'commit'];
const NO_TOKENS   = ['no', 'n', 'cancel', 'skip'];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
//
// SESSIONS[chatId] = {
//   step: 'idle' | 'name' | 'category' | 'variant' | 'location' | 'detail' | 'more',
//   current: { fileId, ext, name?, category?, variant?, location?, detail? } | null,
//   queue: Array<{ fileId, ext, name, category, variant?, location?, detail? }>,
//   updatedAt: number,
// }
//
// Survives warm Vercel invocations; wiped on cold start. If that happens
// mid-conversation, the user just starts over — /cancel clears state too.
// For cross-container persistence swap this for Upstash Redis.
const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle → session stale

// Per-chat token → filename map for /delete inline buttons.
// Filenames can exceed Telegram's 64-byte callback_data limit, so we send a
// short token and look up the real filename here when the button is tapped.
const DELETE_TOKENS = new Map();

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

    if (body.callback_query) {
      await handleCallbackQuery(body.callback_query);
      return res.status(200).send('ok');
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
      await sendMessage(chatId, 'All clear, Sharik. Send an image whenever you\'re ready to list a property.');
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
      `Got the image, Sharik. Let's list this property.\n\n` +
      `1/4  What's the **property name**?  (e.g. Ruby Garden)\n\n` +
      `Send /cancel anytime to drop this one.`
    );
    return;
  }

  // No image, no command — interpret as an answer to whatever we're asking.
  switch (session.step) {
    case 'name':     return onName(chatId, session, text);
    case 'category': return onCategory(chatId, session, text);
    case 'variant':  return onVariant(chatId, session, text);
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
    `Nice — *${cleaned}*.\n\n` +
    `2/4  Which **section** does it go under?  Reply with one:\n` +
    `  • Ongoing — currently under development\n` +
    `  • Karaikal — completed Karaikal projects\n` +
    `  • Chennai — completed Chennai projects\n` +
    `  • Renovation — before/after transformations\n` +
    `  • Other — anything else`
  );
}

async function onCategory(chatId, session, text) {
  const match = VALID_TYPES.find(t => t.toLowerCase() === text.toLowerCase());
  if (!match) {
    await sendMessage(chatId,
      `Not a valid section. Reply with exactly one of:\n` +
      `Ongoing, Karaikal, Chennai, Renovation, Other`
    );
    return;
  }
  session.current.category = match;
  if (match === 'Renovation') {
    session.step = 'variant';
    touch(session);
    await sendMessage(chatId,
      `Renovation pic — is this the **Before** or the **After**?\n\n` +
      `Reply with one:\n  • Before\n  • After\n\n` +
      `Tip: upload the matching half later with the same property name and Cosmos will pair them on the card.`
    );
    return;
  }
  session.step = 'location';
  touch(session);
  await sendMessage(chatId,
    `3/4  **Location** to show on the card?  (optional)\n\n` +
    `Helpful for Ongoing listings so buyers spot the city at a glance.\n` +
    `Reply with the city, or send "skip" to keep it as just *${match}*.`
  );
}

async function onVariant(chatId, session, text) {
  const match = RENO_VARIANTS.find(v => v.toLowerCase() === text.toLowerCase());
  if (!match) {
    await sendMessage(chatId, 'Reply with exactly *Before* or *After*.');
    return;
  }
  session.current.variant = match;
  session.step = 'location';
  touch(session);
  await sendMessage(chatId,
    `Got it — *${match}*.\n\n` +
    `**Location** to show on the card?  (optional)\n` +
    `Reply with the city/area, or send "skip" to keep it as *Renovation*.`
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
    `Shown as a small crimson pill on the card — great for selling points\n` +
    `like "42 Plots", "Sold Out", or "Phase 2".\n` +
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
    `✓ Queued property #${session.queue.length}:\n` +
    formatItem(item) + '\n\n' +
    `Send another image to add more, or reply:\n` +
    `  yes  → publish everything to the site\n` +
    `  no   → drop all queued items`
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
    await sendMessage(chatId, 'No worries Sharik — queue cleared. Send an image whenever you\'re ready.');
    return;
  }
  await sendMessage(chatId,
    `Didn't catch that, Sharik. Send another image to queue more,\n` +
    `or reply "yes" to publish, "no" to discard.\n\n` +
    `/queue to review what's lined up.`
  );
}

// ---------------------------------------------------------------------------
// Commit queued items
// ---------------------------------------------------------------------------

async function handleCommit(chatId) {
  const session = SESSIONS.get(chatId);
  if (!session || session.queue.length === 0) {
    await sendMessage(chatId, 'Nothing queued, Sharik. Send a property image to get started.');
    return;
  }

  await sendMessage(chatId, `Publishing ${session.queue.length} propert${session.queue.length === 1 ? 'y' : 'ies'} to the site, Sharik...`);

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
    `Done, Sharik. Vercel is deploying — your site will reflect this in ~60s.`
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
    await sendMessage(chatId, 'Queue is empty, Sharik. Send a property image to start.');
    return;
  }
  const lines = [`Lined up for publishing (${session.queue.length}):`];
  session.queue.forEach((item, i) => {
    lines.push('', `${i + 1}. ${item.filename}`);
    lines.push(`   ${item.name} · ${item.category}${item.location ? ' · ' + item.location : ''}${item.detail ? ' · ' + item.detail : ''}`);
  });
  lines.push('', 'Reply "yes" to publish, "no" to discard, or send another image.');
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
      await sendMessage(chatId, 'No projects live yet, Sharik — the showcase is empty.');
      return;
    }
    throw e;
  }

  const files = entries.filter(e => e.type === 'file');
  if (files.length === 0) {
    await sendMessage(chatId, 'No projects live yet, Sharik — the showcase is empty.');
    return;
  }

  const buckets = { Ongoing: [], Karaikal: [], Chennai: [], Renovation: [], Other: [], _: [] };
  for (const f of files) {
    const parsed = parseFilename(f.name);
    const key = parsed ? parsed.categoryLabel : '_';
    buckets[key].push(f.name);
  }

  const sections = [
    ['Ongoing',    'Ongoing'],
    ['Karaikal',   'Karaikal'],
    ['Chennai',    'Chennai'],
    ['Renovation', 'Renovation'],
    ['Other',      'Other'],
    ['_',          'Unparseable'],
  ];

  const lines = [`Sharik, you've got ${files.length} propert${files.length === 1 ? 'y' : 'ies'} live on the site:`];
  for (const [key, label] of sections) {
    const arr = buckets[key];
    if (!arr || arr.length === 0) continue;
    lines.push('', `${label} (${arr.length}):`);
    for (const name of arr.sort()) lines.push(`  ${name}`);
  }
  lines.push('', `Use /delete to pick one to remove.`);
  await sendMessage(chatId, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// /delete
// ---------------------------------------------------------------------------

async function handleDelete(chatId, text) {
  const m = text.match(/^\/delete(?:@\S+)?(?:\s+(.+?))?\s*$/i);
  const arg = m && m[1] ? m[1].trim() : '';

  // No argument → show inline button list of live files.
  if (!arg) {
    await showDeleteMenu(chatId);
    return;
  }

  // Legacy path: /delete Filename.jpg still works.
  await deleteFile(chatId, arg);
}

async function showDeleteMenu(chatId) {
  let entries;
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}`,
      { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } }
    );
    entries = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    if (e?.response?.status === 404) {
      await sendMessage(chatId, 'No live properties to delete, Sharik.');
      return;
    }
    throw e;
  }

  const files = entries.filter(e => e.type === 'file').sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) {
    await sendMessage(chatId, 'No live properties to delete, Sharik.');
    return;
  }

  // Telegram callback_data limit is 64 bytes. Filenames can be longer than that,
  // so we keep an in-memory token map per chat and send tokens instead.
  const tokens = ensureDeleteTokens(chatId);
  tokens.clear();

  const keyboard = files.map((f, i) => {
    const token = String(i);
    tokens.set(token, f.name);
    const label = displayLabel(f.name);
    return [{ text: label, callback_data: `del:${token}` }];
  });
  keyboard.push([{ text: '✕ Close', callback_data: 'del:cancel' }]);

  await sendMessageWithKeyboard(chatId,
    `Sharik, tap the property you want to remove from the site:`,
    keyboard
  );
}

async function handleCallbackQuery(cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data || '';

  // Always ack quickly so the button stops spinning.
  await answerCallback(cq.id);

  if (!chatId || !data.startsWith('del:')) return;
  const payload = data.slice(4);

  if (payload === 'cancel') {
    await editMessage(chatId, messageId, 'Closed. Nothing was deleted.');
    deleteTokens(chatId);
    return;
  }

  // Confirm prompt step: "del:confirm:<token>"
  if (payload.startsWith('confirm:')) {
    const token = payload.slice('confirm:'.length);
    const tokens = getDeleteTokens(chatId);
    const filename = tokens?.get(token);
    if (!filename) {
      await editMessage(chatId, messageId, 'That selection expired, Sharik. Run /delete again.');
      return;
    }
    await editMessage(chatId, messageId, `Removing *${filename}*...`);
    try {
      const removed = await deleteFile(chatId, filename, /*silent*/ true);
      tokens.delete(token);
      await editMessage(chatId, messageId,
        removed
          ? `Deleted *${filename}*, Sharik. Site updates in ~60s.`
          : `Couldn't find *${filename}* — already gone?`
      );
    } catch (e) {
      const msg = e?.response?.data?.message || e.message;
      await editMessage(chatId, messageId, `Failed to delete ${filename}: ${msg}`);
    }
    return;
  }

  if (payload.startsWith('back')) {
    // Re-show the menu (cheap: just re-fetch).
    await editMessage(chatId, messageId, 'Loading list...');
    await showDeleteMenu(chatId);
    return;
  }

  // Initial tap: "del:<token>" → ask for confirmation.
  const token = payload;
  const tokens = getDeleteTokens(chatId);
  const filename = tokens?.get(token);
  if (!filename) {
    await editMessage(chatId, messageId, 'That selection expired, Sharik. Run /delete again.');
    return;
  }
  const keyboard = [
    [{ text: '🗑 Yes, delete it', callback_data: `del:confirm:${token}` }],
    [{ text: '↩ Back to list',   callback_data: `del:back` }],
    [{ text: '✕ Cancel',         callback_data: `del:cancel` }],
  ];
  await editMessageWithKeyboard(chatId, messageId,
    `Confirm: remove *${filename}* from the site?`,
    keyboard
  );
}

async function deleteFile(chatId, filename, silent = false) {
  if (filename.includes('/') || filename.includes('..')) {
    if (!silent) await sendMessage(chatId, 'Filename must be a plain filename.');
    return false;
  }

  const sha = await ghGetSha(filename);
  if (!sha) {
    if (!silent) await sendMessage(chatId, `Not found: ${filename}`);
    return false;
  }

  await axios.delete(ghContentsUrl(filename), {
    headers: ghHeaders(),
    data: {
      message: `Remove project image: ${filename}`,
      sha,
      branch: GITHUB_BRANCH,
    },
  });

  if (!silent) {
    await sendMessage(chatId,
      `Deleted *${filename}*, Sharik.\n\nSite updates in ~60s.`
    );
  }
  return true;
}

// Pretty label for a filename in the delete-menu button.
function displayLabel(filename) {
  const base = filename.replace(/\.[^/.]+$/, '');
  const parts = base.split('_');
  const name = parts[0] ? parts[0].replace(/-/g, ' ') : filename;
  const typePart = parts[1] || '';
  const locMatch = typePart.match(/^([^()]+)\(([^()]+)\)$/);
  const cat = locMatch ? locMatch[1] : typePart;
  const loc = locMatch ? locMatch[2].replace(/-/g, ' ') : '';
  let label = name;
  if (cat) label += ` · ${cat}`;
  if (loc) label += ` (${loc})`;
  // Telegram button text is limited; Telegram tolerates long labels but
  // they get truncated visually. Keep them tidy.
  return label.length > 60 ? label.slice(0, 57) + '...' : label;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpText() {
  return (
    'Hey Sharik 👋  Cosmos showcase manager at your service.\n\n' +
    'To list a new property:\n' +
    '  1. Send a photo or file of the property.\n' +
    '  2. I\'ll ask for name, section, location, and badge.\n' +
    '  3. Send more images to queue more properties.\n' +
    '  4. Reply "yes" or /commit when you\'re ready to publish.\n\n' +
    'Commands:\n' +
    '  /list   — see what\'s live on your site\n' +
    '  /queue  — see properties waiting to publish\n' +
    '  /commit — publish the queue now\n' +
    '  /cancel — clear queue / abort current step\n' +
    '  /delete — pick a live property to remove (button list)\n' +
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
  if (current.variant) parts.push(current.variant); // Renovation: Before / After
  if (slugDetail) parts.push(slugDetail);

  const filename = `${parts.join('_')}.${current.ext}`;
  return {
    fileId:   current.fileId,
    ext:      current.ext,
    name:     current.name,
    category: current.category,
    location: current.location,
    detail:   current.detail,
    variant:  current.variant,
    filename,
  };
}

// Turn free text into a filename-safe slug that still round-trips back to
// human-readable text via the frontend's titleCase() (which splits on `-`,
// `_`, and spaces).
//
// We use `-` as the internal word separator (NOT `_`, because `_` is the
// outer part separator between Name / Category / Detail).
//
//   "Ruby Garden"  → "Ruby-Garden"   → card shows "Ruby Garden"
//   "42 Plots"     → "42-Plots"      → badge shows "42 Plots"
//   "Ruby_Garden"  → "Ruby-Garden"   (user's underscores normalised)
//   "Sky's End"    → "Skys-End"      (strips punctuation, keeps hyphen)
function slug(raw) {
  return raw
    .replace(/[^A-Za-z0-9\s_-]+/g, '') // drop punctuation
    .split(/[\s_-]+/)                   // split on whitespace / _ / -
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('-');
}

function formatItem(item) {
  const lines = [
    `  File : ${item.filename}`,
    `  Name : ${item.name}`,
    `  Section: ${item.category}`,
  ];
  if (item.variant)  lines.push(`  Variant: ${item.variant}`);
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

function ensureDeleteTokens(chatId) {
  let m = DELETE_TOKENS.get(chatId);
  if (!m) { m = new Map(); DELETE_TOKENS.set(chatId, m); }
  return m;
}
function getDeleteTokens(chatId) {
  return DELETE_TOKENS.get(chatId);
}
function deleteTokens(chatId) {
  DELETE_TOKENS.delete(chatId);
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

async function sendMessageWithKeyboard(chatId, text, inline_keyboard) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    }
  ).catch(async (e) => {
    if (e?.response?.data?.description?.includes('parse')) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: chatId, text, reply_markup: { inline_keyboard } }
      );
    } else {
      throw e;
    }
  });
}

async function editMessage(chatId, messageId, text) {
  if (!messageId) return sendMessage(chatId, text);
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
    { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }
  ).catch(async (e) => {
    const desc = e?.response?.data?.description || '';
    if (desc.includes('parse')) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        { chat_id: chatId, message_id: messageId, text }
      );
    } else if (desc.includes('not modified')) {
      // Same content — ignore.
    } else {
      // Edit failed (e.g. message too old) — fall back to a fresh message.
      await sendMessage(chatId, text);
    }
  });
}

async function editMessageWithKeyboard(chatId, messageId, text, inline_keyboard) {
  if (!messageId) return sendMessageWithKeyboard(chatId, text, inline_keyboard);
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    }
  ).catch(async (e) => {
    const desc = e?.response?.data?.description || '';
    if (desc.includes('parse')) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard } }
      );
    } else if (!desc.includes('not modified')) {
      await sendMessageWithKeyboard(chatId, text, inline_keyboard);
    }
  });
}

async function answerCallback(callbackQueryId, text = '') {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
    { callback_query_id: callbackQueryId, ...(text && { text }) }
  ).catch(() => { /* best-effort */ });
}
