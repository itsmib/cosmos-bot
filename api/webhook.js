// Vercel serverless function — Telegram bot webhook (conversational flow).
//
// Changes in this version:
//   1. Single commit via GitHub Trees API — all files in one commit, one Vercel deploy.
//   2. Renovation flow — first image triggers "was this Before or After?" then
//      asks for the matching image, then proceeds to name/details. Both images
//      committed as before.<ext> and after.<ext> in the same folder.
//   3. Queue flow — if user sends a new image while in 'more' step (after first
//      property done), bot asks "Queue current and start new?" instead of blocking.
//   4. Vercel deploy hook called after commit instead of relying on git auto-deploy.
//
// Folder structure per project:
//   src/projectadd/<slug>/
//     cover.<ext>          (non-renovation)
//     before.<ext>         (renovation)
//     after.<ext>          (renovation)
//     gallery-1.<ext>, gallery-2.<ext>, ...
//     <slug>.md
//
// Env vars:
//   TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH

const axios = require('axios');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_OWNER    = process.env.GITHUB_OWNER;
const GITHUB_REPO     = process.env.GITHUB_REPO;
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH || 'main';
const VERCEL_DEPLOY_HOOK = 'https://api.vercel.com/v1/integrations/deploy/prj_H7VgRGbIdsqRiU8JwIf9qM0vEqfS/elQSqTjxqP';

const GH_CONTENTS_PATH = 'src/projectadd';
const GH_API_BASE      = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

const VALID_EXTS   = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_BYTES    = 5 * 1024 * 1024;
const SKIP_TOKENS  = ['skip', 's', '-', ''];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
//
// session.step values:
//   idle | reno_label_first | reno_wait_second | name | category | location |
//   badge | yearStarted | plots | plotsTotal | plotsSold | plotsAvailable |
//   areaSqft | price | mapLink | amenities | tagline | description |
//   youtubeId | gallery | more
//
// session.current for normal property:
//   { coverFileId, coverExt, galleryFiles[], name, category, location?, ... }
//
// session.current for renovation:
//   { renoFiles: [{fileId, ext, label}], waitingLabel?, galleryFiles[], name, ... }
//   renoFiles grows to 2 entries (before + after) before proceeding to name.

const SESSIONS      = new Map();
const SESSION_TTL   = 30 * 60 * 1000;
const DELETE_TOKENS = new Map();
// Edit sessions are kept separate from the add-flow sessions above so an
// in-progress upload doesn't collide with an /edit conversation. Shape:
//   { slug, category, fm, body, pendingField, updatedAt }
const EDIT_SESSIONS = new Map();
const EDIT_TOKENS   = new Map();
const SEEN_UPDATES  = new Set();
const SEEN_MAX      = 200;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('cosmos-bot webhook alive');

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

    if (body.callback_query) { await handleCallbackQuery(body.callback_query); return res.status(200).send('ok'); }

    const message = body.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text   = (message.text || '').trim();

    if (text.startsWith('/start') || text.startsWith('/help')) { await sendMessage(chatId, helpText()); return res.status(200).send('ok'); }
    if (text.startsWith('/cancel')) { SESSIONS.delete(chatId); await sendMessage(chatId, 'All clear, Sharik. Send an image whenever you\'re ready.'); return res.status(200).send('ok'); }
    if (text.startsWith('/list'))   { await handleList(chatId);         return res.status(200).send('ok'); }
    if (text.startsWith('/delete')) { await handleDelete(chatId, text); return res.status(200).send('ok'); }
    if (text.startsWith('/edit'))   { await handleEdit(chatId);         return res.status(200).send('ok'); }
    if (text.startsWith('/commit')) { await handleCommit(chatId);       return res.status(200).send('ok'); }
    if (text.startsWith('/queue'))  { await handleQueue(chatId);        return res.status(200).send('ok'); }
    if (text.startsWith('/refresh')) { await handleRefresh(chatId);     return res.status(200).send('ok'); }

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
  // If the user is mid-edit and just sent text, treat that as the new value
  // for the field they picked. Edit takes priority over add-flow text.
  const editSession = EDIT_SESSIONS.get(chatId);
  if (editSession?.pendingField && text && !extractIncomingMedia(message)) {
    await applyEditValue(chatId, editSession, text);
    return;
  }

  const session  = getSession(chatId);
  const incoming = extractIncomingMedia(message);

  // ── New image received ────────────────────────────────────────────────────

  if (incoming) {
    // Idle → start fresh flow
    if (session.step === 'idle') {
      if (incoming.warn) await sendMessage(chatId, incoming.warn);
      session.current = { coverFileId: incoming.fileId, coverExt: incoming.ext, galleryFiles: [], isReno: false };
      session.step = 'name';
      touch(session);
      await sendMessage(chatId,
        `Got the image, Sharik. Let\'s set up this property.\n\n` +
        `*1 / 12*  What\'s the *property name*?  (e.g. Ruby Garden)\n\n` +
        `Send /cancel anytime to start over.`
      );
      return;
    }

    // Gallery step → collect gallery photos
    if (session.step === 'gallery') {
      if (incoming.warn) await sendMessage(chatId, incoming.warn);
      session.current.galleryFiles.push({ fileId: incoming.fileId, ext: incoming.ext });
      touch(session);
      await sendMessageWithKeyboard(chatId,
        `Got gallery photo ${session.current.galleryFiles.length}. Send another or tap Done.`,
        [[{ text: '✅ Done — no more photos', callback_data: 'gallery:done' }]]
      );
      return;
    }

    // Waiting for the second renovation image
    if (session.step === 'reno_wait_second') {
      if (incoming.warn) await sendMessage(chatId, incoming.warn);
      const label = session.current.waitingLabel;
      session.current.renoFiles.push({ fileId: incoming.fileId, ext: incoming.ext, label });
      session.current.waitingLabel = null;
      // Name and category already collected — jump straight to location
      await goToStep(chatId, session, 'location');
      return;
    }

    // More step → user sent a new image after first property done
    // Queue current property and start fresh with the new image
    if (session.step === 'more') {
      if (incoming.warn) await sendMessage(chatId, incoming.warn);
      // The queue already has the previous item (it was pushed in gallery:done)
      // Start fresh flow for the new image
      session.current = { coverFileId: incoming.fileId, coverExt: incoming.ext, galleryFiles: [], isReno: false };
      session.step = 'name';
      touch(session);
      await sendMessageWithKeyboard(chatId,
        `Got a new image, Sharik. The previous property is already queued ✓\n\n` +
        `Let\'s set up this new property.\n` +
        `*1 / 12*  What\'s the *property name*?`,
        [[{ text: '🚀 Skip this — publish queue now', callback_data: 'more:commit' }]]
      );
      return;
    }

    // Any other mid-flow step → block
    await sendMessage(chatId, 'Please finish the current property first, or /cancel to start over.');
    return;
  }

  // ── Text answers ──────────────────────────────────────────────────────────

  switch (session.step) {
    case 'name':        return onName(chatId, session, text);
    case 'location':    return onLocation(chatId, session, text);
    case 'badge':       return onBadge(chatId, session, text);
    case 'yearStarted': return onYearStarted(chatId, session, text);
    case 'plots':          return onPlots(chatId, session, text);
    case 'plotsTotal':     return onPlotsTotal(chatId, session, text);
    case 'plotsSold':      return onPlotsSold(chatId, session, text);
    case 'plotsAvailable': return onPlotsAvailable(chatId, session, text);
    case 'areaSqft':    return onAreaSqft(chatId, session, text);
    case 'price':       return onPrice(chatId, session, text);
    case 'mapLink':     return onMapLink(chatId, session, text);
    case 'amenities':   return onAmenities(chatId, session, text);
    case 'tagline':     return onTagline(chatId, session, text);
    case 'description': return onDescription(chatId, session, text);
    case 'youtubeId':   return onYouTubeId(chatId, session, text);
    case 'more':        return onMore(chatId, session, text);
    default:
      await sendMessage(chatId, helpText());
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function onName(chatId, session, text) {
  if (!text) { await sendMessage(chatId, 'Please send the property name as text.'); return; }
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z0-9]/.test(cleaned)) { await sendMessage(chatId, 'Name must contain letters or numbers. Try again.'); return; }
  if (cleaned.length > 60) { await sendMessage(chatId, 'Name too long (max 60 chars). Try again.'); return; }
  session.current.name = cleaned;
  session.step = 'category';
  touch(session);
  await sendMessageWithKeyboard(chatId,
    `*${cleaned}* — nice.\n\n*2 / 12*  Which *section* does it belong to?`,
    [
      [{ text: '🔨 Ongoing',    callback_data: 'cat:Ongoing'    },
       { text: '📍 Karaikal',   callback_data: 'cat:Karaikal'   }],
      [{ text: '🗺 Plots for Sale', callback_data: 'cat:PlotLayout' },
       { text: '🔁 Renovation',     callback_data: 'cat:Renovation' }],
      [{ text: '📦 Other',      callback_data: 'cat:Other'      }],
    ]
  );
}

async function onLocation(chatId, session, text) {
  if (!isSkip(text)) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9 ,]+$/.test(cleaned)) { await sendMessage(chatId, 'Letters, numbers, spaces and commas only. Try again or tap Skip.'); return; }
    if (cleaned.length > 40) { await sendMessage(chatId, 'Location too long (max 40 chars). Try again or tap Skip.'); return; }
    session.current.location = cleaned;
  }
  await goToStep(chatId, session, 'badge');
}

async function onBadge(chatId, session, text) {
  if (!isSkip(text)) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 30) { await sendMessage(chatId, 'Badge too long (max 30 chars). Try again or tap Skip.'); return; }
    session.current.badge = cleaned;
  }
  await goToStep(chatId, session, 'yearStarted');
}

async function onYearStarted(chatId, session, text) {
  if (!isSkip(text)) {
    if (!/^\d{4}$/.test(text.trim())) { await sendMessage(chatId, 'Please send a 4-digit year like 2022, or tap Skip.'); return; }
    session.current.yearStarted = text.trim();
  }
  await goToStep(chatId, session, 'plots');
}

async function onPlots(chatId, session, text) {
  if (!isSkip(text)) session.current.plots = text.replace(/\s+/g, ' ').trim();
  // For PlotLayout, branch into the inventory questions before area/price.
  await goToStep(chatId, session, isPlotLayout(session) ? 'plotsTotal' : 'areaSqft');
}

async function onPlotsTotal(chatId, session, text) {
  if (!isSkip(text)) session.current.plotsTotal = text.replace(/\s+/g, ' ').trim();
  await goToStep(chatId, session, 'plotsSold');
}

async function onPlotsSold(chatId, session, text) {
  if (!isSkip(text)) session.current.plotsSold = text.replace(/\s+/g, ' ').trim();
  // The website derives "available" from total - sold whenever both parse as
  // numbers, so we only ask for plotsAvailable when one of them is non-numeric
  // (e.g. "Sold out", "12+") and the math can't be done.
  await goToStep(chatId, session, needsManualAvailable(session) ? 'plotsAvailable' : 'areaSqft');
}

async function onPlotsAvailable(chatId, session, text) {
  if (!isSkip(text)) session.current.plotsAvailable = text.replace(/\s+/g, ' ').trim();
  await goToStep(chatId, session, 'areaSqft');
}

// True only when we couldn't derive available = total - sold from numeric
// values — i.e. one of them is missing or non-numeric.
function needsManualAvailable(session) {
  const c = session?.current || {};
  const totalN = parseLooseNumber(c.plotsTotal);
  const soldN = parseLooseNumber(c.plotsSold);
  return totalN === null || soldN === null;
}

function parseLooseNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Reject strings like "12+", "Sold out" — only accept clean integers/decimals.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function onAreaSqft(chatId, session, text) {
  if (!isSkip(text)) session.current.areaSqft = text.replace(/\s+/g, ' ').trim();
  await goToStep(chatId, session, 'price');
}

async function onPrice(chatId, session, text) {
  if (!isSkip(text)) session.current.price = text.replace(/\s+/g, ' ').trim();
  await goToStep(chatId, session, 'mapLink');
}

async function onMapLink(chatId, session, text) {
  if (!isSkip(text)) {
    if (!text.startsWith('http')) { await sendMessage(chatId, 'Please send a valid URL starting with http, or tap Skip.'); return; }
    session.current.mapLink = text.trim();
  }
  await goToStep(chatId, session, 'amenities');
}

async function onAmenities(chatId, session, text) {
  if (!isSkip(text)) session.current.amenities = text.split(',').map(s => s.trim()).filter(Boolean);
  await goToStep(chatId, session, 'tagline');
}

async function onTagline(chatId, session, text) {
  if (!isSkip(text)) session.current.tagline = text.replace(/\s+/g, ' ').trim();
  await goToStep(chatId, session, 'description');
}

async function onDescription(chatId, session, text) {
  if (!isSkip(text)) session.current.description = text.trim();
  await goToStep(chatId, session, 'youtubeId');
}

async function onYouTubeId(chatId, session, text) {
  if (!isSkip(text)) {
    const id = parseYouTubeId(text);
    if (!id) {
      await sendMessage(chatId,
        'That doesn\'t look like a YouTube link. Send a full URL (https://youtu.be/… or https://www.youtube.com/watch?v=…), the bare 11-char video ID, or tap Skip.'
      );
      return;
    }
    session.current.youtubeId = id;
  }
  await goToStep(chatId, session, 'gallery');
}

async function onMore(chatId, session, text) {
  await sendMessageWithKeyboard(chatId,
    'Send another image to queue a new property, or choose:',
    [
      [{ text: '🚀 Publish everything now', callback_data: 'more:commit'  }],
      [{ text: '🗑 Discard all',             callback_data: 'more:discard' }],
    ]
  );
}

// ---------------------------------------------------------------------------
// Step prompts
// ---------------------------------------------------------------------------

const STEP_PROMPTS = {
  badge:          { text: `*4 / 12*  *Badge text*?  (optional)\n\nSmall crimson pill — e.g. "42 Plots", "Sold Out". Send or tap Skip.` },
  yearStarted:    { text: `*5 / 12*  *Year started*?  (optional)\n\nE.g. 2022. Send or tap Skip.` },
  plots:          { text: `*6 / 12*  *Number of plots*?  (optional)\n\nE.g. 42. Send or tap Skip.` },
  // Plot-layout-only inventory questions (only reached when category === PlotLayout).
  plotsTotal:     { text: `*Plot inventory — Total plots*?  (optional)\n\nHow many plots are in this layout in total? E.g. 24. Send or tap Skip.` },
  plotsSold:      { text: `*Plot inventory — Plots sold*?  (optional)\n\nHow many plots have been sold so far? E.g. 17.\n\n_If both Total and Sold are numbers, I'll calculate Available for you automatically._` },
  plotsAvailable: { text: `*Plot inventory — Plots available*?  (optional)\n\nI need this only because Total or Sold isn't a clean number — couldn't calculate it. E.g. "Sold out" or 7. Send or tap Skip.` },
  areaSqft:       { text: `*7 / 12*  *Plot area (sqft)*?  (optional)\n\nE.g. "1200 – 2400". Send or tap Skip.` },
  price:       { text: `*8 / 12*  *Starting price*?  (optional)\n\nE.g. "From ₹48 L". Send or tap Skip.` },
  mapLink:     { text: `*9 / 12*  *Google Maps link*?  (optional)\n\nPaste the link or tap Skip.` },
  amenities:   { text: `*10 / 12*  *Amenities*?  (optional)\n\nComma-separated: _Gated community, 30ft roads, Solar lighting_\n\nOr tap Skip.` },
  tagline:     { text: `*11 / 12*  *Property tagline*?  (optional)\n\nE.g. _"A garden address, a forever home"_\n\nSend or tap Skip.` },
  description: { text: `*12 / 12*  *Property description*?  (optional)\n\nA few sentences about the property. Plain text. Send or tap Skip.` },
  youtubeId:   { text: `*Property walkthrough video*?  (optional)\n\nPaste a YouTube link (https://youtu.be/… or https://www.youtube.com/watch?v=…) or the 11-char video ID. The video shows on the property page.\n\nLeave it for later? Tap Skip.` },
};

function skipKeyboard(step) {
  return [[{ text: '⏭ Skip', callback_data: `skip:${step}` }]];
}

async function goToStep(chatId, session, step) {
  session.step = step;
  touch(session);

  if (step === 'gallery') {
    await sendMessageWithKeyboard(chatId,
      `All details collected ✓\n\nDoes this property have *additional gallery photos*?\n` +
      `(These appear in the detail page slideshow.)`,
      [
        [{ text: '📸 Yes, I have more photos', callback_data: 'gallery:yes'  }],
        [{ text: '✅ No, that\'s it',           callback_data: 'gallery:done' }],
      ]
    );
    return;
  }

  const prompt = STEP_PROMPTS[step];
  if (!prompt) return;
  await sendMessageWithKeyboard(chatId, prompt.text, skipKeyboard(step));
}

// ---------------------------------------------------------------------------
// Callback query handler
// ---------------------------------------------------------------------------

async function handleCallbackQuery(cq) {
  const chatId    = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data      = cq.data || '';

  await answerCallback(cq.id);
  if (!chatId) return;

  // ── Category selection ────────────────────────────────────────────────────
  if (data.startsWith('cat:')) {
    const cat     = data.slice(4);
    const session = getSession(chatId);
    if (session.step !== 'category') return;
    session.current.category = cat;

    if (cat === 'Renovation') {
      // Mark as renovation — collect Before and After images before name/details
      session.current.isReno    = true;
      session.current.renoFiles = [];
      // The first image was already uploaded as coverFileId — ask which it is
      session.step = 'reno_label_first';
      touch(session);
      await editMessage(chatId, messageId, `Section: *Renovation* ✓`);
      await sendMessageWithKeyboard(chatId,
        `Was the image you just sent the *Before* or *After* photo?`,
        [
          [{ text: '⬅️ Before', callback_data: 'renolabel:Before' }],
          [{ text: '➡️ After',  callback_data: 'renolabel:After'  }],
        ]
      );
      return;
    }

    session.step = 'location';
    touch(session);
    await editMessage(chatId, messageId, `Section: *${cat}* ✓`);
    await sendMessageWithKeyboard(chatId,
      `*3 / 12*  *Location* to show on the card?  (optional)\n\nE.g. "Karaikal". Send or tap Skip.`,
      skipKeyboard('location')
    );
    return;
  }

  // ── Renovation: label the first uploaded image ────────────────────────────
  if (data.startsWith('renolabel:')) {
    const label   = data.slice(10);
    const session = getSession(chatId);
    if (session.step !== 'reno_label_first') return;

    // Store the first image with its label
    session.current.renoFiles.push({
      fileId: session.current.coverFileId,
      ext:    session.current.coverExt,
      label,
    });
    session.current.coverFileId  = null;
    session.current.coverExt     = null;

    const needed = label === 'Before' ? 'After' : 'Before';
    session.current.waitingLabel = needed;
    session.step = 'reno_wait_second';
    touch(session);

    await editMessage(chatId, messageId, `*${label}* photo saved ✓`);
    await sendMessage(chatId,
      `Now send the *${needed}* photo.\n\nSend it as a file for best quality.`
    );
    return;
  }

  // ── Skip an optional field ────────────────────────────────────────────────
  if (data.startsWith('skip:')) {
    const step    = data.slice(5);
    const session = getSession(chatId);
    if (session.step !== step) return;

    const NEXT = {
      location: 'badge', badge: 'yearStarted', yearStarted: 'plots',
      plots: 'areaSqft', areaSqft: 'price', price: 'mapLink',
      mapLink: 'amenities', amenities: 'tagline', tagline: 'description',
      description: 'youtubeId', youtubeId: 'gallery',
      // PlotLayout-only chain — skip jumps within the inventory trio and back
      // out to areaSqft when the user skips the last one.
      plotsTotal: 'plotsSold', plotsAvailable: 'areaSqft',
    };
    // For 'plots' specifically, route into the inventory chain when this is a
    // PlotLayout property — otherwise stay on the generic path.
    let nextStep = NEXT[step];
    if (step === 'plots' && isPlotLayout(session)) nextStep = 'plotsTotal';
    // After skipping plotsSold, only ask plotsAvailable when total/sold can't
    // be calculated arithmetically; otherwise the website will derive it.
    if (step === 'plotsSold') nextStep = needsManualAvailable(session) ? 'plotsAvailable' : 'areaSqft';
    if (!nextStep) return;

    await editMessage(chatId, messageId, `${prettyStepName(step)}: _skipped_`);
    await goToStep(chatId, session, nextStep);
    return;
  }

  // ── Gallery flow ──────────────────────────────────────────────────────────
  if (data.startsWith('gallery:')) {
    const action  = data.slice(8);
    const session = getSession(chatId);
    if (session.step !== 'gallery') return;

    if (action === 'yes') {
      await editMessage(chatId, messageId, '📸 Send gallery photos one by one. Tap Done when finished.');
      return;
    }

    if (action === 'done') {
      const item = finaliseItem(session.current);
      session.queue.push(item);
      session.current = null;
      session.step    = 'more';
      touch(session);
      await editMessage(chatId, messageId, `✓ Queued: *${item.name}*`);
      const photoCount = item.isReno
        ? item.renoFiles.length + item.galleryFiles.length
        : 1 + item.galleryFiles.length;
      await sendMessageWithKeyboard(chatId,
        `*${item.name}* is queued.\n\n` +
        `📁 Ready to commit:\n` +
        (item.isReno
          ? item.renoFiles.map(r => `  • ${r.label.toLowerCase()}.${r.ext}`).join('\n') + '\n'
          : `  • cover.${item.coverExt}\n`) +
        (item.galleryFiles.length > 0 ? `  • ${item.galleryFiles.length} gallery photo(s)\n` : '') +
        `  • ${item.slug}.md\n\n` +
        `Send another image to add another property, or:`,
        [
          [{ text: '🚀 Publish everything now', callback_data: 'more:commit'  }],
          [{ text: '🗑 Discard all',             callback_data: 'more:discard' }],
        ]
      );
      return;
    }
    return;
  }

  // ── More / publish ────────────────────────────────────────────────────────
  if (data.startsWith('more:')) {
    const action = data.slice(5);
    if (action === 'commit')  { await handleCommit(chatId); return; }
    if (action === 'discard') {
      SESSIONS.delete(chatId);
      await editMessage(chatId, messageId, 'Queue cleared. Send an image whenever you\'re ready.');
      return;
    }
    return;
  }

  // ── Delete flow ───────────────────────────────────────────────────────────
  if (data.startsWith('del:')) {
    await handleDeleteCallback(chatId, messageId, data.slice(4));
    return;
  }

  // ── Edit flow ─────────────────────────────────────────────────────────────
  if (data.startsWith('edit:')) {
    await handleEditCallback(chatId, messageId, data.slice(5));
    return;
  }
}

// ---------------------------------------------------------------------------
// Commit — GitHub Trees API (single commit, one Vercel deploy)
// ---------------------------------------------------------------------------

async function handleCommit(chatId) {
  const session = SESSIONS.get(chatId);
  if (!session || session.queue.length === 0) {
    await sendMessage(chatId, 'Nothing queued, Sharik. Send a property image to get started.');
    return;
  }

  await sendMessage(chatId,
    `Publishing ${session.queue.length} propert${session.queue.length === 1 ? 'y' : 'ies'} in one commit...`
  );

  try {
    // 1. Download all files for all queued items
    const allTreeEntries = [];

    for (const item of session.queue) {
      if (item.isReno) {
        // Before and After images
        for (const rFile of item.renoFiles) {
          const content = await downloadFileAsBase64(rFile.fileId);
          allTreeEntries.push({
            path:    `${GH_CONTENTS_PATH}/${item.slug}/${rFile.label.toLowerCase()}.${rFile.ext}`,
            mode:    '100644',
            type:    'blob',
            content: Buffer.from(content, 'base64').toString('binary'), // will use blob API below
            _base64: content,
          });
        }
      } else {
        // Cover image
        const content = await downloadFileAsBase64(item.coverFileId);
        allTreeEntries.push({
          path:    `${GH_CONTENTS_PATH}/${item.slug}/cover.${item.coverExt}`,
          mode:    '100644',
          type:    'blob',
          _base64: content,
        });
      }

      // Gallery images
      for (let i = 0; i < item.galleryFiles.length; i++) {
        const g       = item.galleryFiles[i];
        const content = await downloadFileAsBase64(g.fileId);
        allTreeEntries.push({
          path:    `${GH_CONTENTS_PATH}/${item.slug}/gallery-${i + 1}.${g.ext}`,
          mode:    '100644',
          type:    'blob',
          _base64: content,
        });
      }

      // Markdown file
      allTreeEntries.push({
        path:    `${GH_CONTENTS_PATH}/${item.slug}/${item.slug}.md`,
        mode:    '100644',
        type:    'blob',
        _base64: Buffer.from(buildMarkdown(item)).toString('base64'),
      });
    }

    // 2. Create blobs for binary files (images), use content for text files
    const treeItems = [];
    for (const entry of allTreeEntries) {
      if (entry.path.endsWith('.md')) {
        // Text file — use content directly in tree
        treeItems.push({
          path:    entry.path,
          mode:    entry.mode,
          type:    entry.type,
          content: Buffer.from(entry._base64, 'base64').toString('utf8'),
        });
      } else {
        // Binary file — create blob first, use sha in tree
        const blobRes = await axios.post(
          `${GH_API_BASE}/git/blobs`,
          { content: entry._base64, encoding: 'base64' },
          { headers: ghHeaders() }
        );
        treeItems.push({
          path: entry.path,
          mode: entry.mode,
          type: entry.type,
          sha:  blobRes.data.sha,
        });
      }
    }

    // 3. Get current HEAD commit SHA and tree SHA
    const refRes    = await axios.get(`${GH_API_BASE}/git/ref/heads/${GITHUB_BRANCH}`, { headers: ghHeaders() });
    const headSha   = refRes.data.object.sha;
    const commitRes = await axios.get(`${GH_API_BASE}/git/commits/${headSha}`, { headers: ghHeaders() });
    const treeSha   = commitRes.data.tree.sha;

    // 4. Create new tree on top of existing tree
    const newTreeRes = await axios.post(
      `${GH_API_BASE}/git/trees`,
      { base_tree: treeSha, tree: treeItems },
      { headers: ghHeaders() }
    );
    const newTreeSha = newTreeRes.data.sha;

    // 5. Create a single commit
    const names     = session.queue.map(i => i.name).join(', ');
    const newCommit = await axios.post(
      `${GH_API_BASE}/git/commits`,
      {
        message: `Add project${session.queue.length > 1 ? 's' : ''}: ${names}`,
        tree:    newTreeSha,
        parents: [headSha],
      },
      { headers: ghHeaders() }
    );
    const newCommitSha = newCommit.data.sha;

    // 6. Update branch ref
    await axios.patch(
      `${GH_API_BASE}/git/refs/heads/${GITHUB_BRANCH}`,
      { sha: newCommitSha },
      { headers: ghHeaders() }
    );

    // 7. Trigger Vercel deploy hook
    await axios.get(VERCEL_DEPLOY_HOOK).catch(e => console.error('Deploy hook failed:', e.message));

    const summary = session.queue.map(i => `✓ ${i.name} → ${i.slug}/`).join('\n');
    SESSIONS.delete(chatId);
    await sendMessage(chatId,
      summary + '\n\n' +
      `Done, Sharik 🎉 One commit pushed. Vercel is deploying — site updates in ~60s.`
    );

  } catch (e) {
    const msg = e?.response?.data?.message || e.message;
    await sendMessage(chatId, `Something went wrong, Sharik: ${msg}\n\nTry /commit again.`);
    console.error(e?.response?.data || e.message);
  }
}

async function downloadFileAsBase64(fileId) {
  const fileInfo = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const filePath = fileInfo.data.result.file_path;
  const fileRes  = await axios.get(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`,
    { responseType: 'arraybuffer' }
  );
  if (fileRes.data.byteLength > MAX_BYTES) {
    throw new Error(`File too large: ${(fileRes.data.byteLength / 1024 / 1024).toFixed(1)} MB (max 5 MB).`);
  }
  return Buffer.from(fileRes.data).toString('base64');
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(item) {
  const fm = ['---'];
  fm.push(`name: ${item.name}`);
  fm.push(`category: ${item.category}`);
  if (item.location)    fm.push(`location: ${item.location}`);
  if (item.badge)       fm.push(`badge: ${item.badge}`);
  if (item.yearStarted) fm.push(`yearStarted: ${item.yearStarted}`);
  if (item.plots)          fm.push(`plots: ${item.plots}`);
  if (item.plotsTotal)     fm.push(`plotsTotal: ${item.plotsTotal}`);
  if (item.plotsSold)      fm.push(`plotsSold: ${item.plotsSold}`);
  if (item.plotsAvailable) fm.push(`plotsAvailable: ${item.plotsAvailable}`);
  if (item.areaSqft)    fm.push(`areaSqft: ${item.areaSqft}`);
  if (item.price)       fm.push(`price: ${item.price}`);
  if (item.mapLink)     fm.push(`mapLink: ${item.mapLink}`);
  if (item.youtubeId)   fm.push(`youtubeId: ${item.youtubeId}`);
  if (item.isReno)      fm.push(`isRenovation: true`);
  if (item.amenities && item.amenities.length > 0) {
    fm.push(`amenities:`);
    for (const a of item.amenities) fm.push(`  - ${a}`);
  }
  fm.push('---');
  const lines = [fm.join('\n')];
  if (item.tagline)     lines.push(`\n# ${item.tagline}`);
  if (item.description) lines.push(`\n${item.description}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Finalise item
// ---------------------------------------------------------------------------

function finaliseItem(current) {
  return {
    slug:         slug(current.name),
    name:         current.name,
    category:     current.category,
    isReno:       current.isReno       || false,
    renoFiles:    current.renoFiles    || [],
    coverFileId:  current.coverFileId  || null,
    coverExt:     current.coverExt     || null,
    location:     current.location     || null,
    badge:        current.badge        || null,
    yearStarted:  current.yearStarted  || null,
    plots:           current.plots          || null,
    plotsTotal:      current.plotsTotal     || null,
    plotsSold:       current.plotsSold      || null,
    plotsAvailable:  current.plotsAvailable || null,
    areaSqft:     current.areaSqft     || null,
    price:        current.price        || null,
    mapLink:      current.mapLink      || null,
    youtubeId:    current.youtubeId    || null,
    amenities:    current.amenities    || [],
    tagline:      current.tagline      || null,
    description:  current.description  || null,
    galleryFiles: current.galleryFiles || [],
  };
}

// ---------------------------------------------------------------------------
// /refresh — trigger a Vercel rebuild without committing anything. Useful
// after pushing changes from another tool, or to force a redeploy.
// ---------------------------------------------------------------------------

async function handleRefresh(chatId) {
  await sendMessage(chatId, 'Triggering a fresh deploy...');
  try {
    await axios.get(VERCEL_DEPLOY_HOOK);
    await sendMessage(chatId, '✓ Deploy hook fired. Site will refresh in ~60s.');
  } catch (e) {
    await sendMessage(chatId, `Deploy hook failed: ${e?.response?.data?.message || e.message}`);
  }
}

// ---------------------------------------------------------------------------
// /queue
// ---------------------------------------------------------------------------

async function handleQueue(chatId) {
  const session = SESSIONS.get(chatId);
  if (!session || session.queue.length === 0) {
    await sendMessage(chatId, 'Queue is empty, Sharik. Send a property image to start.');
    return;
  }
  const lines = [`Queued for publishing (${session.queue.length}):`];
  session.queue.forEach((item, i) => {
    lines.push('', `${i + 1}. *${item.name}* — ${item.category}${item.isReno ? ' (Renovation)' : ''}`);
    if (item.location) lines.push(`   📍 ${item.location}`);
    if (item.badge)    lines.push(`   🏷 ${item.badge}`);
    const photoCount = item.isReno
      ? item.renoFiles.length + item.galleryFiles.length
      : 1 + item.galleryFiles.length;
    lines.push(`   🖼 ${photoCount} photo(s)`);
  });
  await sendMessageWithKeyboard(chatId, lines.join('\n'), [
    [{ text: '🚀 Publish now', callback_data: 'more:commit'  }],
    [{ text: '🗑 Discard all', callback_data: 'more:discard' }],
  ]);
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
    if (e?.response?.status === 404) { await sendMessage(chatId, 'No projects live yet, Sharik.'); return; }
    throw e;
  }
  const folders = entries.filter(e => e.type === 'dir');
  if (folders.length === 0) { await sendMessage(chatId, 'No projects live yet, Sharik.'); return; }
  const lines = [`Sharik, you\'ve got *${folders.length}* project${folders.length === 1 ? '' : 's'} live:\n`];
  for (const f of folders.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`  • ${titleCase(f.name)}`);
  lines.push('\nUse /delete to remove a project or specific photo.');
  await sendMessage(chatId, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// /delete
// ---------------------------------------------------------------------------

async function handleDelete(chatId, text) {
  const m   = text.match(/^\/delete(?:@\S+)?(?:\s+(.+?))?\s*$/i);
  const arg = m && m[1] ? m[1].trim() : '';
  if (!arg) { await showDeleteProjectMenu(chatId); return; }
  await askDeleteScope(chatId, arg);
}

async function askDeleteScope(chatId, projSlug) {
  await sendMessageWithKeyboard(chatId,
    `*${titleCase(projSlug)}* — what would you like to delete?`,
    [
      [{ text: '🗑 Entire project',   callback_data: `del:entiredirect:${projSlug}` }],
      [{ text: '🖼 A specific photo', callback_data: `del:photosdirect:${projSlug}` }],
      [{ text: '✕ Cancel',           callback_data: 'del:cancel'                    }],
    ]
  );
}

async function showDeleteProjectMenu(chatId) {
  let entries;
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}`,
      { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } }
    );
    entries = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    if (e?.response?.status === 404) { await sendMessage(chatId, 'No projects to delete.'); return; }
    throw e;
  }
  const folders = entries.filter(e => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length === 0) { await sendMessage(chatId, 'No projects to delete.'); return; }
  const tokens = ensureDeleteTokens(chatId);
  tokens.clear();
  const keyboard = folders.map((f, i) => { tokens.set(String(i), f.name); return [{ text: titleCase(f.name), callback_data: `del:proj:${i}` }]; });
  keyboard.push([{ text: '✕ Close', callback_data: 'del:cancel' }]);
  await sendMessageWithKeyboard(chatId, 'Which project, Sharik?', keyboard);
}

async function handleDeleteCallback(chatId, messageId, payload) {
  if (payload === 'cancel') { await editMessage(chatId, messageId, 'Closed. Nothing deleted.'); deleteTokens(chatId); return; }
  if (payload === 'back')   { await editMessage(chatId, messageId, 'Loading...'); await showDeleteProjectMenu(chatId); return; }

  if (payload.startsWith('proj:')) {
    const token = payload.slice(5); const tokens = getDeleteTokens(chatId); const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired. Run /delete again.'); return; }
    await editMessageWithKeyboard(chatId, messageId, `*${titleCase(projSlug)}* — what would you like to delete?`,
      [
        [{ text: '🗑 Entire project',   callback_data: `del:entire:${token}`  }],
        [{ text: '🖼 A specific photo', callback_data: `del:photos:${token}`  }],
        [{ text: '↩ Back',             callback_data: `del:back`              }],
        [{ text: '✕ Cancel',           callback_data: `del:cancel`            }],
      ]
    );
    return;
  }

  if (payload.startsWith('entire:')) {
    const token = payload.slice(7); const tokens = getDeleteTokens(chatId); const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessageWithKeyboard(chatId, messageId, `Confirm: delete the entire *${titleCase(projSlug)}* project?`,
      [
        [{ text: '🗑 Yes, delete everything', callback_data: `del:entireconfirm:${token}` }],
        [{ text: '↩ Back',                    callback_data: `del:proj:${token}`           }],
        [{ text: '✕ Cancel',                  callback_data: `del:cancel`                  }],
      ]
    );
    return;
  }

  if (payload.startsWith('entireconfirm:')) {
    const token = payload.slice(14); const tokens = getDeleteTokens(chatId); const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessage(chatId, messageId, `Deleting *${titleCase(projSlug)}*...`);
    try { await deleteFolderContents(projSlug); deleteTokens(chatId); await editMessage(chatId, messageId, `✓ *${titleCase(projSlug)}* deleted. Site updates in ~60s.`); }
    catch (e) { await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`); }
    return;
  }

  if (payload.startsWith('entiredirect:')) {
    const projSlug = payload.slice(13);
    await editMessageWithKeyboard(chatId, messageId, `Confirm: delete the entire *${titleCase(projSlug)}* project?`,
      [
        [{ text: '🗑 Yes, delete everything', callback_data: `del:entiredirectconfirm:${projSlug}` }],
        [{ text: '✕ Cancel',                  callback_data: `del:cancel`                          }],
      ]
    );
    return;
  }

  if (payload.startsWith('entiredirectconfirm:')) {
    const projSlug = payload.slice(20);
    await editMessage(chatId, messageId, `Deleting *${titleCase(projSlug)}*...`);
    try { await deleteFolderContents(projSlug); await editMessage(chatId, messageId, `✓ *${titleCase(projSlug)}* deleted. Site updates in ~60s.`); }
    catch (e) { await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`); }
    return;
  }

  if (payload.startsWith('photos:')) {
    const token = payload.slice(7); const tokens = getDeleteTokens(chatId); const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await showPhotoDeleteMenu(chatId, messageId, projSlug, `del:proj:${token}`);
    return;
  }

  if (payload.startsWith('photosdirect:')) {
    const projSlug = payload.slice(13);
    await showPhotoDeleteMenu(chatId, messageId, projSlug, 'del:cancel');
    return;
  }

  if (payload.startsWith('photo:')) {
    const key = payload.slice(6); const tokens = getDeleteTokens(chatId); const filePath = tokens?.get(`photo:${key}`);
    if (!filePath) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessageWithKeyboard(chatId, messageId, `Confirm: delete *${filePath.split('/').pop()}*?`,
      [
        [{ text: '🗑 Yes, delete it', callback_data: `del:photoconfirm:${key}` }],
        [{ text: '✕ Cancel',          callback_data: `del:cancel`               }],
      ]
    );
    return;
  }

  if (payload.startsWith('photoconfirm:')) {
    const key = payload.slice(13); const tokens = getDeleteTokens(chatId); const filePath = tokens?.get(`photo:${key}`);
    if (!filePath) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessage(chatId, messageId, `Deleting *${filePath.split('/').pop()}*...`);
    try {
      const sha = await ghGetSha(`${GH_CONTENTS_PATH}/${filePath}`, true);
      if (!sha) { await editMessage(chatId, messageId, 'File not found — already deleted?'); return; }
      await axios.delete(ghContentsUrlFull(`${GH_CONTENTS_PATH}/${filePath}`),
        { headers: ghHeaders(), data: { message: `Remove: ${filePath}`, sha, branch: GITHUB_BRANCH } }
      );
      deleteTokens(chatId);
      await editMessage(chatId, messageId, `✓ *${filePath.split('/').pop()}* deleted. Site updates in ~60s.`);
    } catch (e) { await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`); }
    return;
  }
}

async function showPhotoDeleteMenu(chatId, messageId, projSlug, backCallback) {
  let files;
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}/${projSlug}`,
      { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } }
    );
    files = Array.isArray(r.data) ? r.data.filter(f => f.type === 'file' && !f.name.endsWith('.md')) : [];
  } catch (e) { await editMessage(chatId, messageId, 'Could not fetch photo list.'); return; }
  if (files.length === 0) { await editMessage(chatId, messageId, 'No photos found in this project.'); return; }
  const photoTokens = ensureDeleteTokens(chatId);
  files.forEach((f, i) => photoTokens.set(`photo:${i}`, `${projSlug}/${f.name}`));
  const keyboard = files.map((f, i) => [{ text: f.name, callback_data: `del:photo:${i}` }]);
  keyboard.push([{ text: '↩ Back', callback_data: backCallback }, { text: '✕ Cancel', callback_data: 'del:cancel' }]);
  await editMessageWithKeyboard(chatId, messageId, `Which photo from *${titleCase(projSlug)}*?`, keyboard);
}

// ---------------------------------------------------------------------------
// Edit flow — pick category → project → field → enter value → done
// ---------------------------------------------------------------------------

const EDITABLE_CATEGORIES = [
  { key: 'Ongoing',    label: '🔨 Ongoing'        },
  { key: 'Karaikal',   label: '📍 Karaikal'       },
  { key: 'PlotLayout', label: '🗺 Plots for Sale' },
  { key: 'Renovation', label: '🔁 Renovation'     },
  { key: 'Other',      label: '📦 Other'          },
];

// Common editable fields. PlotLayout adds three more — see editableFieldsFor.
const EDIT_FIELDS_BASE = [
  { key: 'name',        label: '📝 Name'        },
  { key: 'location',    label: '📍 Location'    },
  { key: 'badge',       label: '🏷 Badge'        },
  { key: 'yearStarted', label: '📅 Year started'},
  { key: 'plots',       label: '🔢 Plots count' },
  { key: 'areaSqft',    label: '📐 Area (sqft)' },
  { key: 'price',       label: '💰 Price'       },
  { key: 'mapLink',     label: '🗺 Map link'    },
  { key: 'amenities',   label: '✨ Amenities'   },
  { key: 'tagline',     label: '💬 Tagline'     },
  { key: 'description', label: '📖 Description' },
  { key: 'youtubeId',   label: '▶️ YouTube video'},
];

// Plots available is intentionally NOT here — the website derives it from
// total - sold. We only expose Total and Sold for editing.
const EDIT_FIELDS_PLOTLAYOUT = [
  { key: 'plotsTotal', label: '🔢 Total plots' },
  { key: 'plotsSold',  label: '✅ Plots sold'  },
];

function editableFieldsFor(category) {
  if (category === 'PlotLayout') {
    // Insert the inventory trio right after "Plots count" so they cluster.
    const idx = EDIT_FIELDS_BASE.findIndex(f => f.key === 'plots');
    return [
      ...EDIT_FIELDS_BASE.slice(0, idx + 1),
      ...EDIT_FIELDS_PLOTLAYOUT,
      ...EDIT_FIELDS_BASE.slice(idx + 1),
    ];
  }
  return EDIT_FIELDS_BASE;
}

async function handleEdit(chatId) {
  // Reset any prior edit session for this chat.
  EDIT_SESSIONS.delete(chatId);
  EDIT_TOKENS.delete(chatId);
  await sendMessageWithKeyboard(chatId,
    `Edit a project, Sharik. Which *category* is it in?`,
    [
      ...EDITABLE_CATEGORIES.map(c => [{ text: c.label, callback_data: `edit:cat:${c.key}` }]),
      [{ text: '✕ Cancel', callback_data: 'edit:cancel' }],
    ]
  );
}

async function handleEditCallback(chatId, messageId, payload) {
  if (payload === 'cancel') {
    EDIT_SESSIONS.delete(chatId);
    EDIT_TOKENS.delete(chatId);
    await editMessage(chatId, messageId, 'Edit cancelled.');
    return;
  }

  if (payload === 'back') {
    EDIT_SESSIONS.delete(chatId);
    EDIT_TOKENS.delete(chatId);
    await editMessageWithKeyboard(chatId, messageId,
      `Edit a project, Sharik. Which *category* is it in?`,
      [
        ...EDITABLE_CATEGORIES.map(c => [{ text: c.label, callback_data: `edit:cat:${c.key}` }]),
        [{ text: '✕ Cancel', callback_data: 'edit:cancel' }],
      ]
    );
    return;
  }

  if (payload.startsWith('cat:')) {
    const cat = payload.slice(4);
    await showEditProjectMenu(chatId, messageId, cat);
    return;
  }

  if (payload.startsWith('proj:')) {
    const token = payload.slice(5);
    const filePath = ensureEditTokens(chatId).get(token);
    if (!filePath) { await editMessage(chatId, messageId, 'Selection expired. Run /edit again.'); return; }
    await loadEditProject(chatId, messageId, filePath);
    return;
  }

  if (payload.startsWith('field:')) {
    const field = payload.slice(6);
    const session = EDIT_SESSIONS.get(chatId);
    if (!session) { await editMessage(chatId, messageId, 'Edit session expired. Run /edit again.'); return; }
    session.pendingField = field;
    touch(session);
    const current = readEditField(session, field);
    const currentLine = current ? `\n\n_Current:_ ${truncate(current, 140)}` : '\n\n_Currently empty._';
    const hint = field === 'amenities'
      ? 'Send a comma-separated list, e.g. _Gated community, 30ft roads, Solar lighting_.'
      : field === 'description'
      ? 'Send the new description as plain text. It replaces the existing description body.'
      : field === 'mapLink'
      ? 'Send a full URL starting with http.'
      : field === 'youtubeId'
      ? 'Paste a YouTube link (youtu.be/… or youtube.com/watch?v=…) or the 11-char ID.'
      : 'Send the new value as plain text.';
    await editMessageWithKeyboard(chatId, messageId,
      `Editing *${prettyEditField(field)}* for *${session.fm.name || session.slug}*.\n\n${hint}${currentLine}`,
      [
        [{ text: '🗑 Clear this field', callback_data: 'edit:clearfield' }],
        [{ text: '↩ Pick another field', callback_data: 'edit:pickfield' }],
        [{ text: '✕ Cancel',             callback_data: 'edit:cancel'    }],
      ]
    );
    return;
  }

  if (payload === 'clearfield') {
    const session = EDIT_SESSIONS.get(chatId);
    if (!session?.pendingField) { await editMessage(chatId, messageId, 'No field selected.'); return; }
    await applyEditValue(chatId, session, '', { fromButton: true, messageId });
    return;
  }

  if (payload === 'pickfield') {
    const session = EDIT_SESSIONS.get(chatId);
    if (!session) { await editMessage(chatId, messageId, 'Edit session expired.'); return; }
    session.pendingField = null;
    touch(session);
    await renderEditFieldMenu(chatId, messageId, session);
    return;
  }

  if (payload === 'commit') {
    const session = EDIT_SESSIONS.get(chatId);
    if (!session) { await editMessage(chatId, messageId, 'Edit session expired.'); return; }
    await commitEdit(chatId, messageId, session);
    return;
  }
}

async function showEditProjectMenu(chatId, messageId, category) {
  let entries;
  try {
    const r = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}`,
      { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } }
    );
    entries = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    if (e?.response?.status === 404) { await editMessage(chatId, messageId, 'No projects to edit.'); return; }
    throw e;
  }
  const folders = entries.filter(e => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length === 0) { await editMessage(chatId, messageId, 'No projects to edit.'); return; }

  // Open each .md and filter by frontmatter category.
  const tokens = ensureEditTokens(chatId);
  tokens.clear();
  const matches = [];
  let counter = 0;
  for (const f of folders) {
    const mdPath = `${GH_CONTENTS_PATH}/${f.name}/${f.name}.md`;
    try {
      const md = await fetchTextFile(mdPath);
      if (!md) continue;
      const { data } = parseFrontmatter(md.content);
      const cat = String(data.category || '').toLowerCase();
      if (categoryMatches(cat, category)) {
        const key = String(counter++);
        tokens.set(key, mdPath);
        matches.push({ key, label: data.name || titleCase(f.name) });
      }
    } catch { /* skip */ }
  }

  if (matches.length === 0) {
    await editMessageWithKeyboard(chatId, messageId,
      `No *${category}* projects found.`,
      [
        [{ text: '↩ Pick another category', callback_data: 'edit:back' }],
        [{ text: '✕ Cancel',                callback_data: 'edit:cancel' }],
      ]
    );
    // Allow back-tap to re-open the category picker.
    EDIT_SESSIONS.set(chatId, { pickingCategory: true, updatedAt: Date.now() });
    return;
  }

  const keyboard = matches.map(m => [{ text: m.label, callback_data: `edit:proj:${m.key}` }]);
  keyboard.push([{ text: '✕ Cancel', callback_data: 'edit:cancel' }]);
  await editMessageWithKeyboard(chatId, messageId,
    `*${category}* projects — pick one to edit:`,
    keyboard
  );
}

async function loadEditProject(chatId, messageId, mdPath) {
  await editMessage(chatId, messageId, 'Loading...');
  const md = await fetchTextFile(mdPath);
  if (!md) { await editMessage(chatId, messageId, 'Could not load this project.'); return; }
  const { data, content } = parseFrontmatter(md.content);
  const slug = mdPath.split('/').slice(-2, -1)[0];
  const session = {
    slug,
    mdPath,
    sha: md.sha,
    fm: { ...data },
    body: content,
    category: String(data.category || ''),
    pendingField: null,
    dirty: false,
    updatedAt: Date.now(),
  };
  EDIT_SESSIONS.set(chatId, session);
  await renderEditFieldMenu(chatId, messageId, session);
}

async function renderEditFieldMenu(chatId, messageId, session) {
  const fields = editableFieldsFor(session.category);
  const keyboard = [];
  for (let i = 0; i < fields.length; i += 2) {
    const row = [{ text: fields[i].label, callback_data: `edit:field:${fields[i].key}` }];
    if (fields[i + 1]) row.push({ text: fields[i + 1].label, callback_data: `edit:field:${fields[i + 1].key}` });
    keyboard.push(row);
  }
  keyboard.push([
    session.dirty
      ? { text: '🚀 Save & publish', callback_data: 'edit:commit' }
      : { text: '✓ Done (no changes)', callback_data: 'edit:cancel' },
  ]);
  keyboard.push([{ text: '✕ Cancel', callback_data: 'edit:cancel' }]);

  const dirtyTag = session.dirty ? '\n\n_Unsaved changes — tap Save & publish when done._' : '';
  await editMessageWithKeyboard(chatId, messageId,
    `Editing *${session.fm.name || session.slug}*\nCategory: *${session.category}*${dirtyTag}\n\nPick a field to update:`,
    keyboard
  );
}

async function applyEditValue(chatId, session, rawText, opts = {}) {
  const field = session.pendingField;
  if (!field) return;

  const value = rawText.trim();
  // Empty / explicit clear → unset the field. For description, that means
  // empty body. For other frontmatter keys, delete the key.
  const clearing = opts.fromButton ? true : value === '' || isSkip(value);

  if (field === 'description') {
    session.body = clearing ? '' : value;
  } else if (field === 'amenities') {
    if (clearing) delete session.fm.amenities;
    else session.fm.amenities = value.split(',').map(s => s.trim()).filter(Boolean);
  } else if (field === 'name') {
    if (clearing) {
      await sendMessage(chatId, 'Name cannot be empty. Please send a value or pick a different field.');
      return;
    }
    if (!/[A-Za-z0-9]/.test(value) || value.length > 60) {
      await sendMessage(chatId, 'Name must be 1–60 chars and contain a letter or number.');
      return;
    }
    session.fm.name = value;
  } else if (field === 'mapLink') {
    if (clearing) delete session.fm.mapLink;
    else if (!value.startsWith('http')) {
      await sendMessage(chatId, 'Please send a URL starting with http, or tap Clear.');
      return;
    } else session.fm.mapLink = value;
  } else if (field === 'youtubeId') {
    if (clearing) delete session.fm.youtubeId;
    else {
      const id = parseYouTubeId(value);
      if (!id) {
        await sendMessage(chatId, 'Not a valid YouTube link or ID. Send a watch URL, youtu.be link, or the 11-char ID.');
        return;
      }
      session.fm.youtubeId = id;
    }
  } else if (field === 'yearStarted') {
    if (clearing) delete session.fm.yearStarted;
    else if (!/^\d{4}$/.test(value)) {
      await sendMessage(chatId, 'Year should be 4 digits like 2022.');
      return;
    } else session.fm.yearStarted = value;
  } else {
    if (clearing) delete session.fm[field];
    else session.fm[field] = value;
  }

  session.pendingField = null;
  session.dirty = true;
  touch(session);

  if (opts.fromButton && opts.messageId) {
    await editMessage(chatId, opts.messageId, `*${prettyEditField(field)}* cleared ✓`);
  } else {
    await sendMessage(chatId, `*${prettyEditField(field)}* updated ✓`);
  }
  // Re-render the field menu so the user can pick another or save.
  await sendMessageWithKeyboard(chatId,
    `Editing *${session.fm.name || session.slug}* — pick another field or save:`,
    [
      ...editableFieldsFor(session.category).reduce((rows, f, i) => {
        if (i % 2 === 0) rows.push([{ text: f.label, callback_data: `edit:field:${f.key}` }]);
        else rows[rows.length - 1].push({ text: f.label, callback_data: `edit:field:${f.key}` });
        return rows;
      }, []),
      [{ text: '🚀 Save & publish', callback_data: 'edit:commit' }],
      [{ text: '✕ Cancel',          callback_data: 'edit:cancel' }],
    ]
  );
}

async function commitEdit(chatId, messageId, session) {
  await editMessage(chatId, messageId, 'Publishing changes...');
  try {
    const newMd = serialiseMarkdown(session.fm, session.body);
    await axios.put(
      ghContentsUrlFull(session.mdPath),
      {
        message: `Edit project: ${session.fm.name || session.slug}`,
        content: Buffer.from(newMd, 'utf8').toString('base64'),
        sha:     session.sha,
        branch:  GITHUB_BRANCH,
      },
      { headers: ghHeaders() }
    );
    await axios.get(VERCEL_DEPLOY_HOOK).catch(e => console.error('Deploy hook failed:', e.message));
    EDIT_SESSIONS.delete(chatId);
    EDIT_TOKENS.delete(chatId);
    await editMessage(chatId, messageId,
      `✓ *${session.fm.name || session.slug}* updated. Site refreshes in ~60s.`
    );
  } catch (e) {
    await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`);
  }
}

// Fetch a text file from the repo. Returns { content, sha } or null on 404.
async function fetchTextFile(path) {
  try {
    const r = await axios.get(ghContentsUrlFull(path), {
      headers: ghHeaders(),
      params: { ref: GITHUB_BRANCH },
    });
    const content = Buffer.from(r.data.content, 'base64').toString('utf8');
    return { content, sha: r.data.sha };
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

// Lightweight YAML frontmatter parser — only handles the keys the bot writes.
// Supports scalars and a single-level "amenities:\n  - x\n  - y" list. That's
// all our markdown produces, so we don't need full YAML.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, content: raw };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const val = kv[2];
    if (val === '') {
      // Possibly a list — gather subsequent "- item" lines.
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s+/, '').trim());
        j++;
      }
      if (items.length > 0) { data[key] = items; i = j; continue; }
    }
    data[key] = val;
    i++;
  }
  return { data, content: m[2] || '' };
}

// Re-emit YAML frontmatter + body in the same shape buildMarkdown produces,
// so the file stays consistent across add and edit.
function serialiseMarkdown(fm, body) {
  const out = ['---'];
  // Preserve a sensible field order — same order buildMarkdown writes new files.
  const order = [
    'name', 'category', 'location', 'badge', 'yearStarted', 'plots',
    'plotsTotal', 'plotsSold', 'plotsAvailable',
    'areaSqft', 'price', 'mapLink', 'youtubeId', 'isRenovation',
  ];
  for (const k of order) {
    if (fm[k] === undefined || fm[k] === null || fm[k] === '') continue;
    out.push(`${k}: ${fm[k]}`);
  }
  if (Array.isArray(fm.amenities) && fm.amenities.length > 0) {
    out.push('amenities:');
    for (const a of fm.amenities) out.push(`  - ${a}`);
  }
  out.push('---');
  const trimmedBody = (body || '').replace(/^\s+/, '');
  return trimmedBody ? `${out.join('\n')}\n\n${trimmedBody}` : out.join('\n') + '\n';
}

function readEditField(session, field) {
  if (field === 'description') return session.body || '';
  if (field === 'amenities') {
    const a = session.fm.amenities;
    return Array.isArray(a) ? a.join(', ') : (a || '');
  }
  return session.fm[field] || '';
}

function prettyEditField(field) {
  const map = {
    name: 'Name', location: 'Location', badge: 'Badge', yearStarted: 'Year started',
    plots: 'Plots count', plotsTotal: 'Total plots', plotsSold: 'Plots sold',
    plotsAvailable: 'Plots available', areaSqft: 'Area (sqft)', price: 'Price',
    mapLink: 'Map link', amenities: 'Amenities', tagline: 'Tagline', description: 'Description',
    youtubeId: 'YouTube video',
  };
  return map[field] || field;
}

function categoryMatches(raw, target) {
  // Same loose matching the website uses, so users don't have to remember the
  // exact casing in the .md file.
  const r = raw.toLowerCase();
  if (target === 'PlotLayout') return ['plotlayout', 'plot-layout', 'plot_layout', 'plot', 'plots', 'available', 'available-plots'].includes(r);
  return r === target.toLowerCase();
}

function ensureEditTokens(chatId) {
  let m = EDIT_TOKENS.get(chatId);
  if (!m) { m = new Map(); EDIT_TOKENS.set(chatId, m); }
  return m;
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

async function deleteFolderContents(projSlug) {
  const r = await axios.get(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GH_CONTENTS_PATH}/${projSlug}`,
    { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } }
  );
  const files = Array.isArray(r.data) ? r.data.filter(f => f.type === 'file') : [];
  for (const f of files) {
    await axios.delete(
      ghContentsUrlFull(`${GH_CONTENTS_PATH}/${projSlug}/${f.name}`),
      { headers: ghHeaders(), data: { message: `Remove: ${projSlug}/${f.name}`, sha: f.sha, branch: GITHUB_BRANCH } }
    );
  }
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function ghContentsUrlFull(path) {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
}

function ghHeaders() {
  return { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cosmos-bot' };
}

async function ghGetSha(path, fullPath = false) {
  const url = fullPath ? ghContentsUrlFull(path) : ghContentsUrlFull(`${GH_CONTENTS_PATH}/${path}`);
  try {
    const r = await axios.get(url, { headers: ghHeaders(), params: { ref: GITHUB_BRANCH } });
    return r.data.sha;
  } catch (e) {
    if (e?.response?.status === 404) return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getSession(chatId) {
  const now = Date.now();
  let s = SESSIONS.get(chatId);
  if (s && now - s.updatedAt > SESSION_TTL) { s = undefined; SESSIONS.delete(chatId); }
  if (!s) { s = { step: 'idle', current: null, queue: [], updatedAt: now }; SESSIONS.set(chatId, s); }
  return s;
}

function touch(s) { s.updatedAt = Date.now(); }
function ensureDeleteTokens(chatId) { let m = DELETE_TOKENS.get(chatId); if (!m) { m = new Map(); DELETE_TOKENS.set(chatId, m); } return m; }
function getDeleteTokens(chatId)    { return DELETE_TOKENS.get(chatId); }
function deleteTokens(chatId)       { DELETE_TOKENS.delete(chatId); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slug(raw) {
  return raw.replace(/[^A-Za-z0-9\s_-]+/g, '').split(/[\s_-]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-').toLowerCase();
}

function titleCase(s) { return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function isSkip(text) { return SKIP_TOKENS.includes((text || '').toLowerCase().trim()); }

function prettyStepName(step) {
  const map = {
    location: 'Location', badge: 'Badge', yearStarted: 'Year started',
    plots: 'Plots', plotsTotal: 'Total plots', plotsSold: 'Plots sold',
    plotsAvailable: 'Plots available',
    areaSqft: 'Area', price: 'Price', mapLink: 'Map link',
    amenities: 'Amenities', tagline: 'Tagline', description: 'Description',
    youtubeId: 'YouTube video',
  };
  return map[step] || step;
}

// Pull the 11-char video ID out of any of the common YouTube URL shapes, or
// pass a bare ID through. Mirrors the website's extractYouTubeId so the bot
// stores exactly what the loader expects.
function parseYouTubeId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

function isPlotLayout(session) {
  return session?.current?.category === 'PlotLayout';
}

function extractIncomingMedia(message) {
  if (message.document) {
    const d = message.document; const ext = guessExt(d.file_name, d.mime_type);
    if (!ext) return null;
    return { fileId: d.file_id, ext, fileSize: d.file_size, warn: null };
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) => (a.file_size || 0) >= (b.file_size || 0) ? a : b);
    return { fileId: largest.file_id, ext: 'jpg', fileSize: largest.file_size, warn: '⚠️ Sent as compressed photo. For best quality, send as a *file* next time.' };
  }
  return null;
}

function guessExt(filename, mimeType) {
  if (filename) { const ext = (filename.split('.').pop() || '').toLowerCase(); if (VALID_EXTS.includes(ext)) return ext; }
  if (mimeType) { if (mimeType === 'image/jpeg') return 'jpg'; if (mimeType === 'image/png') return 'png'; if (mimeType === 'image/webp') return 'webp'; }
  return null;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpText() {
  return (
    'Hey Sharik 👋  Cosmos showcase manager.\n\n' +
    'To add a property:\n' +
    '  1. Send the *cover photo* as a file.\n' +
    '  2. I\'ll ask for all details.\n' +
    '  3. For Renovation — I\'ll ask if it\'s Before or After, then ask for the matching photo.\n' +
    '  4. I\'ll ask if you have gallery photos.\n' +
    '  5. Tap *Publish* — one commit, site updates in ~60s.\n\n' +
    'Commands:\n' +
    '  /list   — see live projects\n' +
    '  /queue  — see what\'s waiting to publish\n' +
    '  /commit — publish the queue now\n' +
    '  /cancel — clear everything and start over\n' +
    '  /edit   — edit details of a published project\n' +
    '  /delete — remove a project or photo\n' +
    '  /refresh — trigger a fresh Vercel deploy\n' +
    '  /help   — this message'
  );
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

async function sendMessage(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown' }
  ).catch(async (e) => {
    if (e?.response?.data?.description?.includes('parse')) await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text });
    else throw e;
  });
}

async function sendMessageWithKeyboard(chatId, text, inline_keyboard) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }
  ).catch(async (e) => {
    if (e?.response?.data?.description?.includes('parse')) await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text, reply_markup: { inline_keyboard } });
    else throw e;
  });
}

async function editMessage(chatId, messageId, text) {
  if (!messageId) return sendMessage(chatId, text);
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
    { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }
  ).catch(async (e) => {
    const desc = e?.response?.data?.description || '';
    if (desc.includes('parse')) await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { chat_id: chatId, message_id: messageId, text });
    else if (!desc.includes('not modified')) await sendMessage(chatId, text);
  });
}

async function editMessageWithKeyboard(chatId, messageId, text, inline_keyboard) {
  if (!messageId) return sendMessageWithKeyboard(chatId, text, inline_keyboard);
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
    { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }
  ).catch(async (e) => {
    const desc = e?.response?.data?.description || '';
    if (desc.includes('parse')) await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard } });
    else if (!desc.includes('not modified')) await sendMessageWithKeyboard(chatId, text, inline_keyboard);
  });
}

async function answerCallback(callbackQueryId, text = '') {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
    { callback_query_id: callbackQueryId, ...(text && { text }) }
  ).catch(() => {});
}