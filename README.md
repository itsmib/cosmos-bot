# cosmos-bot

Telegram bot, deployed as a **Vercel serverless function**, that adds and deletes project images in the Cosmos showcase repo (`src/projectadd/`).

No always-on server — just a single function at `/api/webhook` that Telegram POSTs to.

## Commands

- **Send a file/document** (image sent as *File*, not *Photo*)
  Filename must follow: `PropertyName_Type_OptionalDetail.ext`
  Example: `RubyGarden_Karaikal_42Plots.jpg`

- **`/delete`**
  Sends an inline-button list of every live property — tap one, confirm, done.
  `/delete Filename.jpg` still works as a direct shortcut.

## Deploy

1. Push this folder to a new GitHub repo.
2. Import the repo into Vercel.
3. In Vercel → Project → Settings → Environment Variables, add:

   | Name | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | from @BotFather |
   | `GITHUB_TOKEN` | PAT with `contents:write` on target repo |
   | `GITHUB_OWNER` | e.g. `noorul-misbah` |
   | `GITHUB_REPO` | e.g. `karaikal-showcase-web` |
   | `GITHUB_BRANCH` | e.g. `main` (optional, defaults to `main`) |

4. After deploy, set the Telegram webhook:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-project>.vercel.app/api/webhook"
   ```

5. Verify:

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
   ```

## Local dev

```bash
npm install
npx vercel dev
```

This runs the function locally at `http://localhost:3000/api/webhook`. Use a tunnel (ngrok, cloudflared) to expose it to Telegram during testing, and temporarily repoint the webhook.
