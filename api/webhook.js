// Vercel serverless function — Telegram bot webhook.
//
// Handles two flows:
//   1. User sends an image as a FILE/DOCUMENT  → uploads to src/projectadd/ on GitHub
//   2. User sends `/delete Filename.jpg`       → deletes src/projectadd/Filename.jpg from GitHub
//
// Deploy: push this repo to Vercel. Set env vars in Vercel dashboard:
//   TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
// Then point Telegram webhook at https://<your-project>.vercel.app/api/webhook

const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_OWNER   = process.env.GITHUB_OWNER;
const GITHUB_REPO    = process.env.GITHUB_REPO;
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';

const GH_CONTENTS_PATH = 'src/projectadd';

module.exports = async (req, res) => {
  // Telegram only POSTs. Anything else is a health-check or stray visit.
  if (req.method !== 'POST') {
    return res.status(200).send('cosmos-bot webhook alive');
  }

  // Acknowledge to Telegram immediately so it doesn't retry while we work.
  // On Vercel we still need to await async work BEFORE the function returns,
  // because the container is frozen once the response finishes. So we do the
  // work first, then respond. Telegram's retry window is generous enough.
  try {
    const message = req.body && req.body.message;
    if (!message) {
      return res.status(200).send('ok');
    }

    const chatId = message.chat.id;
    const text   = (message.text || '').trim();

    // --- Delete command ---
    if (text.startsWith('/delete')) {
      await handleDelete(chatId, text);
      return res.status(200).send('ok');
    }

    // --- Upload (document) ---
    if (message.document) {
      await handleUpload(chatId, message.document);
      return res.status(200).send('ok');
    }

    // --- Help for anything else ---
    await sendMessage(chatId,
      'Send an image as a FILE/DOCUMENT to add a project.\n' +
      'Filename format: PropertyName_Type_OptionalDetail.jpg\n\n' +
      'To remove: /delete Filename.jpg'
    );
    return res.status(200).send('ok');

  } catch (err) {
    // Log for Vercel's function logs; still return 200 so Telegram stops retrying.
    console.error(err?.response?.data || err.message);
    return res.status(200).send('ok');
  }
};

// ---------------------------------------------------------------------------
// Upload flow
// ---------------------------------------------------------------------------

async function handleUpload(chatId, doc) {
  const filename = doc.file_name;

  // Filename must look like Name_Type[_Detail].ext so the frontend parser works.
  const parts = filename.replace(/\.[^/.]+$/, '').split('_');
  if (parts.length < 2) {
    await sendMessage(chatId,
      `Invalid filename format.\n\n` +
      `Use: PropertyName_Type_OptionalDetail.jpg\n\n` +
      `Example: RubyGarden_Karaikal_42Plots.jpg`
    );
    return;
  }

  await sendMessage(chatId, `Receiving: ${filename}...`);

  // Resolve Telegram's file_path, then download the raw bytes.
  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`
  );
  const filePath = fileInfo.data.result.file_path;

  const fileRes = await axios.get(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`,
    { responseType: 'arraybuffer' }
  );
  const fileContent = Buffer.from(fileRes.data).toString('base64');

  // If the file already exists at the target path we need its sha to overwrite.
  // NOTE: we check the SAME path we write to. The original Express version had
  // a bug — it checked public/projectadd but wrote to src/projectadd, so the
  // existence check never matched and overwrites failed.
  const sha = await ghGetSha(filename);

  await axios.put(
    ghContentsUrl(filename),
    {
      message: `Add project image: ${filename}`,
      content: fileContent,
      branch: GITHUB_BRANCH,
      ...(sha && { sha }),
    },
    { headers: ghHeaders() }
  );

  await sendMessage(chatId,
    `Done. ${filename} has been ${sha ? 'updated' : 'added'}.\n\n` +
    `Vercel is deploying now — the card will appear on the site in ~60 seconds.`
  );
}

// ---------------------------------------------------------------------------
// Delete flow
// ---------------------------------------------------------------------------

async function handleDelete(chatId, text) {
  // Accept "/delete Filename.jpg" or "/delete@BotName Filename.jpg".
  const m = text.match(/^\/delete(?:@\S+)?\s+(.+?)\s*$/i);
  if (!m) {
    await sendMessage(chatId,
      `Usage: /delete Filename.jpg\n\n` +
      `Example: /delete RubyGarden_Karaikal.jpg`
    );
    return;
  }
  const filename = m[1].trim();

  // Guardrail: no path traversal, no subdirectories — we only operate on files
  // directly inside src/projectadd/.
  if (filename.includes('/') || filename.includes('..')) {
    await sendMessage(chatId, `Filename must be a plain filename, no slashes.`);
    return;
  }

  const sha = await ghGetSha(filename);
  if (!sha) {
    await sendMessage(chatId, `Not found: ${filename}\n\nNothing to delete.`);
    return;
  }

  await axios.delete(ghContentsUrl(filename), {
    headers: ghHeaders(),
    // GitHub requires the delete body under `data` when using axios.
    data: {
      message: `Remove project image: ${filename}`,
      sha,
      branch: GITHUB_BRANCH,
    },
  });

  await sendMessage(chatId,
    `Deleted ${filename}.\n\n` +
    `Vercel is deploying now — the card will disappear from the site in ~60 seconds.`
  );
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

// Returns the blob sha for an existing file, or undefined if not present.
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
