# Contract Signer

A small e-signature app that runs as a **Cloudflare Worker** from a **GitHub repository**.

1. You log in, upload a purchase agreement (PDF or Word), and enter the recipient's name and email and the email where *your* signed copy should go.
2. You click to place signature/date boxes on the pages. Your signature, printed name and today's date are stamped on automatically.
3. The recipient gets an email with a private link, reviews the document, types their name, draws (or types) a signature and submits. Their date is stamped automatically.
4. A signed PDF (with a Certificate of Completion page) is emailed to **you** and to the **recipient**, saved in R2 storage, and available to download from your dashboard or from the recipient's confirmation screen.

> Not legal advice. E-signatures are generally valid for contracts under the U.S. ESIGN Act and UETA, but real-estate documents can have state-specific rules (deeds and notarized documents usually need more). Check with your attorney or title company before relying on this for a closing.

## What's in the box

| Path | What it does |
| --- | --- |
| `src/index.js` | Worker: routes, login, upload, send, sign, dashboard APIs |
| `src/pdf.js` | Stamps signatures/dates, adds signature page and certificate (pdf-lib) |
| `src/docx.js` | Basic Word → PDF conversion |
| `src/email.js` | Email via Resend |
| `public/` | Owner dashboard (`/admin`) and signing page (`/sign/<token>`) |
| `wrangler.jsonc` | Cloudflare config (KV + R2 bindings, variables) |

## Deploy (GitHub → Cloudflare Workers)

### 1. Put the code on GitHub
Create a repository and upload the contents of this folder (keep the `src` and `public` folders). You don't need `node_modules`.

### 2. Edit two lines in `wrangler.jsonc`
- `FROM_EMAIL` — an address on a domain you've verified in Resend (step 4).
- `TIMEZONE` — the time zone used for the date stamps (default `America/Chicago`).

### 3. Create the Worker from the repo
Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** (Workers Builds) → pick this repo. Build/deploy commands: leave the defaults, or use `npx wrangler deploy` as the deploy command.

The first deploy creates the KV namespace (`DB`) and R2 bucket (`contract-signer-files`) automatically. If your build reports a missing KV id, create a KV namespace in the dashboard and paste its id into `kv_namespaces` in `wrangler.jsonc`.

### 4. Set up email (Resend)
1. Create an account at resend.com and verify your sending domain (add the DNS records Resend shows you in Cloudflare DNS).
2. Create an API key.

Cloudflare's built-in Worker email can only send to addresses you've pre-verified, so it can't email arbitrary recipients — that's why Resend is used.

### 5. Add the two secrets
Worker → **Settings** → **Variables and Secrets** → add as **Secret**:
- `ADMIN_PASSWORD` — the password for your `/admin` page (make it long).
- `RESEND_API_KEY` — the key from Resend.

Redeploy if prompted. Then open `https://<your-worker>.<your-subdomain>.workers.dev/admin`.

### 6. First use
Log in → **My signature**: enter your name, default email and draw (or type) your signature → **New agreement**.

## Things to know

- **Word files** are converted to a simple PDF (text, bold, headings, tables flattened to rows, bullets). Fonts, images, headers/footers and exact layout are not preserved, and characters outside the standard Latin set (e.g. `≥`) become `?`. For a contract where layout matters, export a PDF from Word and upload that.
- **Fonts on generated pages** (signature page, certificate, Word conversion) are Helvetica. Calibri can't be embedded without a licensed font file. Your own PDF keeps its original fonts.
- **Rotated PDF pages** are not handled specially; place boxes and check the result.
- **PDF viewer** (pdf.js) loads from cdnjs.cloudflare.com in the browser. To self-host it, `npm install pdfjs-dist@3.11.174`, copy `build/pdf.min.js` and `build/pdf.worker.min.js` into `public/vendor/`, and update the script tag, `workerSrc` in `public/pdfview.js`, and the CSP in `src/index.js`.
- **Signing links** are 64-character random tokens. Anyone with the link can sign, so the email says not to forward it. Use **Void** on the dashboard to kill a link.
- **Audit trail**: each signed PDF ends with a Certificate of Completion (names, emails, timestamps, IP addresses, browser, consent, and a SHA-256 fingerprint of the document as sent).
- **Local testing**: `npm install`, copy `.dev.vars.example` to `.dev.vars`, then `npm run dev`. With `DEV_NO_EMAIL=true` emails are logged instead of sent.
- Not included yet: multiple recipients/signing order, initials, text-entry fields, a reminder schedule, and email-code verification of the signer.

