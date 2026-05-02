// Vercel serverless function — Telegram bot webhook (conversational flow).
//
// Flow:
//   1. User sends a photo or document.
//   2. Bot asks: Name → Category [buttons] → Location → Badge → yearStarted →
//      plots → areaSqft → price → mapLink → amenities → tagline → description
//   3. Bot asks: any additional gallery photos? [Yes/No buttons]
//   4. If yes — collects gallery images one by one until "Done" button.
//   5. On commit: creates folder structure in src/projectadd/<slug>/
//        cover.<ext>
//        gallery-1.<ext>, gallery-2.<ext>, ...
//        <slug>.md
//   6. Single GitHub commit with all files → one Vercel deploy.
//
// Other commands:
//   /list, /delete, /cancel, /queue, /commit, /help
//
// Env vars:
//   TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH

const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_REPO    = process.env.GITHUB_REPO;
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';

const GH_CONTENTS_PATH = 'src/projectadd';

const VALID_TYPES   = ['Ongoing', 'Karaikal', 'Chennai', 'Renovation', 'Other'];
const RENO_VARIANTS = ['Before', 'After'];
const VALID_EXTS    = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_BYTES     = 5 * 1024 * 1024;
const SKIP_TOKENS   = ['skip', 's', '-', ''];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const SESSIONS     = new Map();
const SESSION_TTL  = 30 * 60 * 1000;
const DELETE_TOKENS = new Map();
const SEEN_UPDATES = new Set();
const SEEN_MAX     = 200;

// ---------------------------------------------------------------------------
// Entry point
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

    if (text.startsWith('/start') || text.startsWith('/help')) {
      await sendMessage(chatId, helpText());
      return res.status(200).send('ok');
    }
    if (text.startsWith('/cancel')) {
      SESSIONS.delete(chatId);
      await sendMessage(chatId, 'All clear, Sharik. Send an image whenever you\'re ready.');
      return res.status(200).send('ok');
    }
    if (text.startsWith('/list'))   { await handleList(chatId);         return res.status(200).send('ok'); }
    if (text.startsWith('/delete')) { await handleDelete(chatId, text); return res.status(200).send('ok'); }
    if (text.startsWith('/commit')) { await handleCommit(chatId);       return res.status(200).send('ok'); }
    if (text.startsWith('/queue'))  { await handleQueue(chatId);        return res.status(200).send('ok'); }

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
  const session  = getSession(chatId);
  const incoming = extractIncomingMedia(message);

  // New cover image — start fresh flow
  if (incoming && session.step === 'idle') {
    if (incoming.warn) await sendMessage(chatId, incoming.warn);
    session.current = {
      coverFileId:  incoming.fileId,
      coverExt:     incoming.ext,
      beforeFileId: null,
      beforeExt:    null,
      afterFileId:  null,
      afterExt:     null,
      galleryFiles: [],
    };
    session.step = 'name';
    touch(session);
    await sendMessage(chatId,
      `Got the cover image, Sharik. Let\'s set up this property.\n\n` +
      `*1 / 12*  What\'s the *property name*?  (e.g. Ruby Garden)\n\n` +
      `Send /cancel anytime to start over.`
    );
    return;
  }

  // Renovation before photo
  if (incoming && session.step === 'renovation_before') {
    if (incoming.warn) await sendMessage(chatId, incoming.warn);
    session.current.beforeFileId = incoming.fileId;
    session.current.beforeExt = incoming.ext;
    session.step = 'renovation_after';
    touch(session);
    await sendMessage(chatId, `Got it. Now send the *After* photo.`);
    return;
  }

  // Renovation after photo
  if (incoming && session.step === 'renovation_after') {
    if (incoming.warn) await sendMessage(chatId, incoming.warn);
    session.current.afterFileId = incoming.fileId;
    session.current.afterExt = incoming.ext;
    session.step = 'location';
    touch(session);
    await sendMessageWithKeyboard(chatId,
      `*3 / 12*  *Location* to show on the card?  (optional)\n\n` +
      `E.g. "Karaikal" or "ECR Chennai". Send or tap Skip.`,
      skipKeyboard('location')
    );
    return;
  }

  // Gallery image received while in gallery step
  if (incoming && session.step === 'gallery') {
    if (incoming.warn) await sendMessage(chatId, incoming.warn);
    session.current.galleryFiles.push({ fileId: incoming.fileId, ext: incoming.ext });
    touch(session);
    const count = session.current.galleryFiles.length;
    await sendMessageWithKeyboard(chatId,
      `Got gallery photo ${count}. Send another or tap Done.`,
      [[{ text: '✅ Done — no more photos', callback_data: 'gallery:done' }]]
    );
    return;
  }

  // Image received mid-flow (not gallery step)
  if (incoming && session.step !== 'idle' && session.step !== 'gallery') {
    await sendMessage(chatId, 'Please finish the current property first, or /cancel to start over.');
    return;
  }

  // Text answers
  switch (session.step) {
    case 'name':        return onName(chatId, session, text);
    case 'location':    return onLocation(chatId, session, text);
    case 'badge':       return onBadge(chatId, session, text);
    case 'yearStarted': return onYearStarted(chatId, session, text);
    case 'plots':       return onPlots(chatId, session, text);
    case 'areaSqft':    return onAreaSqft(chatId, session, text);
    case 'price':       return onPrice(chatId, session, text);
    case 'mapLink':     return onMapLink(chatId, session, text);
    case 'amenities':   return onAmenities(chatId, session, text);
    case 'tagline':     return onTagline(chatId, session, text);
    case 'description': return onDescription(chatId, session, text);
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
      [{ text: '🏙 Chennai',    callback_data: 'cat:Chennai'    },
       { text: '🔁 Renovation', callback_data: 'cat:Renovation' }],
      [{ text: '📦 Other',      callback_data: 'cat:Other'      }],
    ]
  );
}

async function onLocation(chatId, session, text) {
  if (!isSkip(text)) {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9 ,]+$/.test(cleaned)) {
      await sendMessage(chatId, 'Location can only contain letters, numbers, spaces and commas. Try again or "skip".');
      return;
    }
    if (cleaned.length > 40) { await sendMessage(chatId, 'Location too long (max 40 chars). Try again or "skip".'); return; }
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
  await goToStep(chatId, session, 'areaSqft');
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
  if (!isSkip(text)) {
    session.current.amenities = text.split(',').map(s => s.trim()).filter(Boolean);
  }
  await goToStep(chatId, session, 'tagline');
}

async function onTagline(chatId, session, text) {
  if (!isSkip(text)) session.current.tagline = text.replace(/\s+/g, ' ').trim();
  await goToStep(chatId, session, 'description');
}

async function onDescription(chatId, session, text) {
  if (!isSkip(text)) session.current.description = text.trim();
  await goToStep(chatId, session, 'gallery');
}

// ---------------------------------------------------------------------------
// Step prompts — central place for the question text + skip-button keyboard
// ---------------------------------------------------------------------------

const STEP_PROMPTS = {
  badge: {
    text:
      `*4 / 12*  *Badge text*?  (optional)\n\n` +
      `Small crimson pill on the card — e.g. "42 Plots", "Sold Out", "Phase 2".\n` +
      `Send text or tap Skip.`,
  },
  yearStarted: {
    text: `*5 / 12*  *Year started*?  (optional)\n\nE.g. 2022. Send the year or tap Skip.`,
  },
  plots: {
    text: `*6 / 12*  *Number of plots*?  (optional)\n\nE.g. 42. Send the number or tap Skip.`,
  },
  areaSqft: {
    text: `*7 / 12*  *Plot area (sqft)*?  (optional)\n\nE.g. "1200 – 2400". Send or tap Skip.`,
  },
  price: {
    text: `*8 / 12*  *Starting price*?  (optional)\n\nE.g. "From ₹48 L". Send or tap Skip.`,
  },
  mapLink: {
    text: `*9 / 12*  *Google Maps link*?  (optional)\n\nPaste the link or tap Skip.`,
  },
  amenities: {
    text:
      `*10 / 12*  *Amenities*?  (optional)\n\n` +
      `Send as comma-separated list:\n` +
      `_Gated community, 30ft roads, Solar lighting_\n\nOr tap Skip.`,
  },
  tagline: {
    text:
      `*11 / 12*  *Property tagline*?  (optional)\n\n` +
      `One punchy heading line — e.g. _"A garden address, a forever home"_\n\nSend or tap Skip.`,
  },
  description: {
    text:
      `*12 / 12*  *Property description*?  (optional)\n\n` +
      `A few sentences about the property — location, highlights, why it\'s great.\n` +
      `Plain text is fine.\n\nSend or tap Skip.`,
  },
};

function skipKeyboard(step) {
  return [[{ text: '⏭ Skip', callback_data: `skip:${step}` }]];
}

async function goToStep(chatId, session, step) {
  session.step = step;
  touch(session);

  if (step === 'gallery') {
    await sendMessageWithKeyboard(chatId,
      `All details collected ✓\n\n` +
      `Does this property have *additional gallery photos*?\n` +
      `(Cover is already saved — these appear inside the detail page.)`,
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
// Callback query handler
// ---------------------------------------------------------------------------

async function handleCallbackQuery(cq) {
  const chatId    = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data      = cq.data || '';

  await answerCallback(cq.id);
  if (!chatId) return;

  // Category selection
  if (data.startsWith('cat:')) {
    const cat     = data.slice(4);
    const session = getSession(chatId);
    if (session.step !== 'category') return;
    session.current.category = cat;

    if (cat === 'Renovation') {
      session.step = 'renovation_before';
      touch(session);
      await editMessage(chatId, messageId, `Section: *Renovation* ✓`);
      await sendMessage(chatId, `Please send the *Before* photo.`);
      return;
    }

    session.step = 'location';
    touch(session);
    await editMessage(chatId, messageId, `Section: *${cat}* ✓`);
    await sendMessageWithKeyboard(chatId,
      `*3 / 12*  *Location* to show on the card?  (optional)\n\n` +
      `E.g. "Karaikal" or "ECR Chennai". Send or tap Skip.`,
      skipKeyboard('location')
    );
    return;
  }

  // Renovation variant
  if (data.startsWith('variant:')) {
    const variant = data.slice(8);
    const session = getSession(chatId);
    if (session.step !== 'variant') return;
    session.current.variant = variant;
    session.step = 'location';
    touch(session);
    await editMessage(chatId, messageId, `Variant: *${variant}* ✓`);
    await sendMessageWithKeyboard(chatId,
      `*3 / 12*  *Location* to show on the card?  (optional)\n\nSend or tap Skip.`,
      skipKeyboard('location')
    );
    return;
  }

  // Skip an optional field — advance to the next step without setting anything
  if (data.startsWith('skip:')) {
    const step    = data.slice(5);
    const session = getSession(chatId);
    if (session.step !== step) return;

    const NEXT = {
      location:    'badge',
      badge:       'yearStarted',
      yearStarted: 'plots',
      plots:       'areaSqft',
      areaSqft:    'price',
      price:       'mapLink',
      mapLink:     'amenities',
      amenities:   'tagline',
      tagline:     'description',
      description: 'gallery',
    };
    const nextStep = NEXT[step];
    if (!nextStep) return;

    await editMessage(chatId, messageId, `${prettyStepName(step)}: _skipped_`);
    await goToStep(chatId, session, nextStep);
    return;
  }

  // Gallery flow
  if (data.startsWith('gallery:')) {
    const action  = data.slice(8);
    const session = getSession(chatId);
    if (session.step !== 'gallery') return;

    if (action === 'yes') {
      await editMessage(chatId, messageId, '📸 Send your gallery photos one by one. Tap Done when finished.');
      return;
    }

    if (action === 'done') {
      const item = finaliseItem(session.current);
      session.queue.push(item);
      session.current = null;
      session.step    = 'more';
      touch(session);
      await editMessage(chatId, messageId, `✓ Queued: *${item.name}*`);
      await sendMessageWithKeyboard(chatId,
        `*${item.name}* is queued.\n\n` +
        `📁 Ready to commit:\n` +
        `  • cover.${item.coverExt}\n` +
        (item.galleryFiles.length > 0 ? `  • ${item.galleryFiles.length} gallery photo(s)\n` : '') +
        `  • ${item.slug}.md\n\n` +
        `What's next?`,
        [
          [{ text: '➕ Add another property',   callback_data: 'more:add'     }],
          [{ text: '🚀 Publish everything now', callback_data: 'more:commit'  }],
          [{ text: '🗑 Discard all',             callback_data: 'more:discard' }],
        ]
      );
      return;
    }
    return;
  }

  // More / publish
  if (data.startsWith('more:')) {
    const action = data.slice(5);
    if (action === 'add') {
      await editMessage(chatId, messageId, 'Got it. Send the cover photo for the next property.');
      return;
    }
    if (action === 'commit')  { await handleCommit(chatId); return; }
    if (action === 'discard') {
      SESSIONS.delete(chatId);
      await editMessage(chatId, messageId, 'Queue cleared. Send an image whenever you\'re ready.');
      return;
    }
    return;
  }

  // Delete flow
  if (data.startsWith('del:')) {
    await handleDeleteCallback(chatId, messageId, data.slice(4));
    return;
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function handleCommit(chatId) {
  const session = SESSIONS.get(chatId);
  if (!session || session.queue.length === 0) {
    await sendMessage(chatId, 'Nothing queued, Sharik. Send a property image to get started.');
    return;
  }

  await sendMessage(chatId,
    `Publishing ${session.queue.length} propert${session.queue.length === 1 ? 'y' : 'ies'} to the site...`
  );

  const results = [];
  for (const item of session.queue) {
    try {
      await commitProject(item);
      results.push(`✓ ${item.name} → ${item.slug}/`);
    } catch (e) {
      const msg = e?.response?.data?.message || e.message;
      results.push(`✗ ${item.name}: ${msg}`);
    }
  }

  SESSIONS.delete(chatId);
  await sendMessage(chatId,
    results.join('\n') + '\n\n' +
    `Done, Sharik 🎉 Vercel is deploying — site updates in ~60s.`
  );
}

async function commitProject(item) {
  const files = [];

  // Cover image
  const coverContent = await downloadFileAsBase64(item.coverFileId);
  files.push({
    path:    `${GH_CONTENTS_PATH}/${item.slug}/cover.${item.coverExt}`,
    content: coverContent,
    message: `Add cover: ${item.slug}/cover.${item.coverExt}`,
  });

  // Gallery images
  for (let i = 0; i < item.galleryFiles.length; i++) {
    const g       = item.galleryFiles[i];
    const content = await downloadFileAsBase64(g.fileId);
    files.push({
      path:    `${GH_CONTENTS_PATH}/${item.slug}/gallery-${i + 1}.${g.ext}`,
      content,
      message: `Add gallery: ${item.slug}/gallery-${i + 1}.${g.ext}`,
    });
  }

  // Markdown file
  const mdContent = Buffer.from(buildMarkdown(item)).toString('base64');
  files.push({
    path:    `${GH_CONTENTS_PATH}/${item.slug}/${item.slug}.md`,
    content: mdContent,
    message: `Add metadata: ${item.slug}/${item.slug}.md`,
  });

  // Commit each file to GitHub
  for (const file of files) {
    const sha = await ghGetSha(file.path, true);
    await axios.put(
      ghContentsUrlFull(file.path),
      {
        message: file.message,
        content: file.content,
        branch:  GITHUB_BRANCH,
        ...(sha && { sha }),
      },
      { headers: ghHeaders() }
    );
  }
}

async function commitRenovationProject(item) {
  const files = [];

  // Before image
  const beforeContent = await downloadFileAsBase64(item.beforeFileId);
  files.push({
    path:    `${GH_CONTENTS_PATH}/${item.slug}/before.${item.beforeExt}`,
    content: beforeContent,
    message: `Add before image: ${item.slug}/before.${item.beforeExt}`,
  });

  // After image
  const afterContent = await downloadFileAsBase64(item.afterFileId);
  files.push({
    path:    `${GH_CONTENTS_PATH}/${item.slug}/after.${item.afterExt}`,
    content: afterContent,
    message: `Add after image: ${item.slug}/after.${item.afterExt}`,
  });

  // Markdown file
  const mdContent = Buffer.from(buildMarkdown(item)).toString('base64');
  files.push({
    path:    `${GH_CONTENTS_PATH}/${item.slug}/${item.slug}.md`,
    content: mdContent,
    message: `Add metadata: ${item.slug}/${item.slug}.md`,
  });

  // Commit each file to GitHub
  for (const file of files) {
    const sha = await ghGetSha(file.path, true);
    await axios.put(
      ghContentsUrlFull(file.path),
      {
        message: file.message,
        content: file.content,
        branch:  GITHUB_BRANCH,
        ...(sha && { sha }),
      },
      { headers: ghHeaders() }
    );
  }
}

async function downloadFileAsBase64(fileId) {
  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
  );
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
  if (item.plots)       fm.push(`plots: ${item.plots}`);
  if (item.areaSqft)    fm.push(`areaSqft: ${item.areaSqft}`);
  if (item.price)       fm.push(`price: ${item.price}`);
  if (item.mapLink)     fm.push(`mapLink: ${item.mapLink}`);
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
    location:     current.location    || null,
    badge:        current.badge       || null,
    yearStarted:  current.yearStarted || null,
    plots:        current.plots       || null,
    areaSqft:     current.areaSqft    || null,
    price:        current.price       || null,
    mapLink:      current.mapLink     || null,
    amenities:    current.amenities   || [],
    tagline:      current.tagline     || null,
    description:  current.description || null,
    coverFileId:  current.coverFileId,
    coverExt:     current.coverExt,
    beforeFileId: current.beforeFileId,
    beforeExt:    current.beforeExt,
    afterFileId:  current.afterFileId,
    afterExt:     current.afterExt,
    galleryFiles: current.galleryFiles || [],
  };
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
    lines.push('', `${i + 1}. *${item.name}* — ${item.category}`);
    if (item.location) lines.push(`   📍 ${item.location}`);
    if (item.badge)    lines.push(`   🏷 ${item.badge}`);
    lines.push(`   🖼 ${1 + item.galleryFiles.length} photo(s)`);
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
  for (const f of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  • ${titleCase(f.name)}`);
  }
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

  const keyboard = folders.map((f, i) => {
    tokens.set(String(i), f.name);
    return [{ text: titleCase(f.name), callback_data: `del:proj:${i}` }];
  });
  keyboard.push([{ text: '✕ Close', callback_data: 'del:cancel' }]);

  await sendMessageWithKeyboard(chatId, 'Which project, Sharik?', keyboard);
}

async function handleDeleteCallback(chatId, messageId, payload) {
  if (payload === 'cancel') {
    await editMessage(chatId, messageId, 'Closed. Nothing deleted.');
    deleteTokens(chatId);
    return;
  }

  // Back to project list
  if (payload === 'back') {
    await editMessage(chatId, messageId, 'Loading...');
    await showDeleteProjectMenu(chatId);
    return;
  }

  // Select project from menu
  if (payload.startsWith('proj:')) {
    const token    = payload.slice(5);
    const tokens   = getDeleteTokens(chatId);
    const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired. Run /delete again.'); return; }
    await editMessageWithKeyboard(chatId, messageId,
      `*${titleCase(projSlug)}* — what would you like to delete?`,
      [
        [{ text: '🗑 Entire project',   callback_data: `del:entire:${token}`  }],
        [{ text: '🖼 A specific photo', callback_data: `del:photos:${token}`  }],
        [{ text: '↩ Back',             callback_data: `del:back`              }],
        [{ text: '✕ Cancel',           callback_data: `del:cancel`            }],
      ]
    );
    return;
  }

  // Confirm entire project delete (from menu)
  if (payload.startsWith('entire:')) {
    const token    = payload.slice(7);
    const tokens   = getDeleteTokens(chatId);
    const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessageWithKeyboard(chatId, messageId,
      `Confirm: delete the entire *${titleCase(projSlug)}* project and all its photos?`,
      [
        [{ text: '🗑 Yes, delete everything', callback_data: `del:entireconfirm:${token}` }],
        [{ text: '↩ Back',                    callback_data: `del:proj:${token}`           }],
        [{ text: '✕ Cancel',                  callback_data: `del:cancel`                  }],
      ]
    );
    return;
  }

  // Confirmed — delete entire folder (from menu token)
  if (payload.startsWith('entireconfirm:')) {
    const token    = payload.slice(14);
    const tokens   = getDeleteTokens(chatId);
    const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessage(chatId, messageId, `Deleting *${titleCase(projSlug)}*...`);
    try {
      await deleteFolderContents(projSlug);
      deleteTokens(chatId);
      await editMessage(chatId, messageId, `✓ *${titleCase(projSlug)}* deleted. Site updates in ~60s.`);
    } catch (e) {
      await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`);
    }
    return;
  }

  // Direct entire delete (from /delete <slug> path)
  if (payload.startsWith('entiredirect:')) {
    const projSlug = payload.slice(13);
    await editMessageWithKeyboard(chatId, messageId,
      `Confirm: delete the entire *${titleCase(projSlug)}* project?`,
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
    try {
      await deleteFolderContents(projSlug);
      await editMessage(chatId, messageId, `✓ *${titleCase(projSlug)}* deleted. Site updates in ~60s.`);
    } catch (e) {
      await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`);
    }
    return;
  }

  // Show photo list (from menu token)
  if (payload.startsWith('photos:')) {
    const token    = payload.slice(7);
    const tokens   = getDeleteTokens(chatId);
    const projSlug = tokens?.get(token);
    if (!projSlug) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await showPhotoDeleteMenu(chatId, messageId, projSlug, `del:proj:${token}`);
    return;
  }

  // Show photo list (direct path)
  if (payload.startsWith('photosdirect:')) {
    const projSlug = payload.slice(13);
    await showPhotoDeleteMenu(chatId, messageId, projSlug, 'del:cancel');
    return;
  }

  // Delete specific photo confirm
  if (payload.startsWith('photo:')) {
    const key      = payload.slice(6);
    const tokens   = getDeleteTokens(chatId);
    const filePath = tokens?.get(`photo:${key}`);
    if (!filePath) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessageWithKeyboard(chatId, messageId,
      `Confirm: delete *${filePath.split('/').pop()}*?`,
      [
        [{ text: '🗑 Yes, delete it', callback_data: `del:photoconfirm:${key}` }],
        [{ text: '✕ Cancel',          callback_data: `del:cancel`               }],
      ]
    );
    return;
  }

  // Confirmed — delete specific photo
  if (payload.startsWith('photoconfirm:')) {
    const key      = payload.slice(13);
    const tokens   = getDeleteTokens(chatId);
    const filePath = tokens?.get(`photo:${key}`);
    if (!filePath) { await editMessage(chatId, messageId, 'Selection expired.'); return; }
    await editMessage(chatId, messageId, `Deleting *${filePath.split('/').pop()}*...`);
    try {
      const sha = await ghGetSha(`${GH_CONTENTS_PATH}/${filePath}`, true);
      if (!sha) { await editMessage(chatId, messageId, 'File not found — already deleted?'); return; }
      await axios.delete(
        ghContentsUrlFull(`${GH_CONTENTS_PATH}/${filePath}`),
        { headers: ghHeaders(), data: { message: `Remove: ${filePath}`, sha, branch: GITHUB_BRANCH } }
      );
      deleteTokens(chatId);
      await editMessage(chatId, messageId, `✓ *${filePath.split('/').pop()}* deleted. Site updates in ~60s.`);
    } catch (e) {
      await editMessage(chatId, messageId, `Failed: ${e?.response?.data?.message || e.message}`);
    }
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
  } catch (e) {
    await editMessage(chatId, messageId, 'Could not fetch photo list.'); return;
  }

  if (files.length === 0) { await editMessage(chatId, messageId, 'No photos found in this project.'); return; }

  const photoTokens = ensureDeleteTokens(chatId);
  files.forEach((f, i) => photoTokens.set(`photo:${i}`, `${projSlug}/${f.name}`));

  const keyboard = files.map((f, i) => [{ text: f.name, callback_data: `del:photo:${i}` }]);
  keyboard.push([{ text: '↩ Back',   callback_data: backCallback  }]);
  keyboard.push([{ text: '✕ Cancel', callback_data: 'del:cancel'  }]);

  await editMessageWithKeyboard(chatId, messageId,
    `Which photo from *${titleCase(projSlug)}*?`, keyboard
  );
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
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept:        'application/vnd.github+json',
    'User-Agent':  'cosmos-bot',
  };
}

async function ghGetSha(path, fullPath = false) {
  const url = fullPath
    ? ghContentsUrlFull(path)
    : ghContentsUrlFull(`${GH_CONTENTS_PATH}/${path}`);
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

function ensureDeleteTokens(chatId) {
  let m = DELETE_TOKENS.get(chatId);
  if (!m) { m = new Map(); DELETE_TOKENS.set(chatId, m); }
  return m;
}
function getDeleteTokens(chatId) { return DELETE_TOKENS.get(chatId); }
function deleteTokens(chatId)    { DELETE_TOKENS.delete(chatId); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slug(raw) {
  return raw
    .replace(/[^A-Za-z0-9\s_-]+/g, '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('-')
    .toLowerCase();
}

function titleCase(s) {
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isSkip(text) {
  return SKIP_TOKENS.includes((text || '').toLowerCase().trim());
}

function prettyStepName(step) {
  const map = {
    location:    'Location',
    badge:       'Badge',
    yearStarted: 'Year started',
    plots:       'Plots',
    areaSqft:    'Area',
    price:       'Price',
    mapLink:     'Map link',
    amenities:   'Amenities',
    tagline:     'Tagline',
    description: 'Description',
  };
  return map[step] || step;
}

function extractIncomingMedia(message) {
  if (message.document) {
    const d   = message.document;
    const ext = guessExt(d.file_name, d.mime_type);
    if (!ext) return null;
    return { fileId: d.file_id, ext, fileSize: d.file_size, warn: null };
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) => (a.file_size || 0) >= (b.file_size || 0) ? a : b);
    return {
      fileId:   largest.file_id,
      ext:      'jpg',
      fileSize: largest.file_size,
      warn:     '⚠️ Sent as compressed photo. For best quality, send as a *file* next time.',
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
// Help
// ---------------------------------------------------------------------------

function helpText() {
  return (
    'Hey Sharik 👋  Cosmos showcase manager.\n\n' +
    'To add a new property:\n' +
    '  1. Send the *cover photo* as a file.\n' +
    '  2. I\'ll ask for all details — name, section, location, badge,\n' +
    '     year, plots, area, price, map link, amenities, tagline, description.\n' +
    '  3. Then I\'ll ask if you have gallery photos.\n' +
    '  4. Tap *Publish* — site updates in ~60s.\n\n' +
    'Commands:\n' +
    '  /list   — see live projects\n' +
    '  /queue  — see what\'s waiting to publish\n' +
    '  /commit — publish the queue now\n' +
    '  /cancel — clear everything and start over\n' +
    '  /delete — remove a project or specific photo\n' +
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
    if (e?.response?.data?.description?.includes('parse')) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: chatId, text }
      );
    } else throw e;
  });
}

async function sendMessageWithKeyboard(chatId, text, inline_keyboard) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }
  ).catch(async (e) => {
    if (e?.response?.data?.description?.includes('parse')) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: chatId, text, reply_markup: { inline_keyboard } }
      );
    } else throw e;
  });
}

async function editMessage(chatId, messageId, text) {
  if (!messageId) return sendMessage(chatId, text);
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
    { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }
  ).catch(async (e) => {
    const desc = e?.response?.data?.description || '';
    if (desc.includes('parse')) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        { chat_id: chatId, message_id: messageId, text }
      );
    } else if (!desc.includes('not modified')) {
      await sendMessage(chatId, text);
    }
  });
}

async function editMessageWithKeyboard(chatId, messageId, text, inline_keyboard) {
  if (!messageId) return sendMessageWithKeyboard(chatId, text, inline_keyboard);
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
    { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }
  ).catch(async (e) => {
    const desc = e?.response?.data?.description || '';
    if (desc.includes('parse')) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`,
        { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard } }
      );
    } else if (!desc.includes('not modified')) {
      await sendMessageWithKeyboard(chatId, text, inline_keyboard);
    }
  });
}

async function answerCallback(callbackQueryId, text = '') {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
    { callback_query_id: callbackQueryId, ...(text && { text }) }
  ).catch(() => {});
}