# 📄 Payment Verification API

This API provides verification services for payment transactions made through **Commercial Bank of Ethiopia (CBE)**, **Telebirr**, **Dashen Bank**, **Bank of Abyssinia**, **CBE Birr**, and **M-Pesa** mobile payment platforms in Ethiopia.  
It allows applications to verify the authenticity and details of payment receipts by reference numbers or uploaded images.

It ships with a web front end: a landing page with a public verification widget, a Google-authenticated
dashboard where developers issue their own API keys, and an admin console at `/admin`. The service is free —
there are no plans, credits or billing.

> ⚠️ **Disclaimer**: This is **not an official API**. I am **not affiliated with Ethio Telecom, Telebirr, or Commercial Bank of Ethiopia (CBE)**. This tool is built for personal and developer utility purposes only and scrapes publicly available data.

---

## ✅ Features

### 🚀 Universal Verification (Smart Router)

- **One endpoint to rule them all:** Verifies transactions from multiple providers (CBE, Telebirr, Dashen, Bank of Abyssinia, CBE Birr) using a single, intelligent endpoint (`POST /verify`). _Note: M-Pesa is currently supported via its dedicated endpoint only._
- Automatically detects the provider based on the format of the provided `reference` number and accompanying JSON payload.
- Strictly validates payloads and intelligently delegates to the correct backend service.

### 🔷 CBE Payment Verification

- Verifies CBE bank transfers using reference number and account suffix
- Extracts key payment details:
  - Payer name and account
  - Receiver name and account
  - Transaction amount
  - Payment date and time
  - Reference number
  - Payment description/reason

### 🔶 Telebirr Payment Verification

- Verifies Telebirr mobile money transfers using a reference number
- Extracts key transaction details:
  - Payer name and Telebirr number
  - Credited party name and account
  - Bank name (if the transaction was made to another bank)
  - Transaction status
  - Receipt number
  - Payment date
  - Settled amount
  - Service fees and VAT
  - Total paid amount

### 🔷 Dashen Bank Payment Verification

- Verifies Dashen bank transfers using reference number
- Extracts comprehensive transaction details:
  - Sender name and account number
  - Transaction channel and service type
  - Narrative/description
  - Receiver name and phone number
  - Institution name
  - Transaction and transfer references
  - Transaction date and amount
  - Service charges, taxes, and fees breakdown
  - Total amount

### 🔶 Bank of Abyssinia Payment Verification

- Verifies Bank of Abyssinia transfers using reference number and 5-digit suffix
- Extracts key transaction details:
  - Transaction reference and details
  - Account information
  - Payment amounts and dates
  - Verification status

### 🔷 M-Pesa Payment Verification

- Verifies M-Pesa mobile money transfers using receipt reference
- Extracts transaction details from the generated receipt PDFs

### 🔷 CBE Birr Payment Verification

- Verifies CBE Birr mobile money transfers using receipt number and phone number
- Extracts transaction details:
  - Receipt and transaction information
  - Payer and receiver details
  - Transaction amounts and fees
  - Payment status and timestamps
  - Ethiopian phone number validation (251 format)

### 🔷 Image-based Payment Verification

- Verifies payments by analyzing uploaded receipt images
- Uses **Mistral AI** to detect receipt type and extract transaction details
- Supports both **CBE** and **Telebirr** receipt screenshots

---

## 🌐 Hosting Limitations for `verify-telebirr` and `verify-mpesa`

Due to **regional restrictions** by the Telebirr system and Safaricom M-Pesa, hosting these endpoints outside of Ethiopia/Kenya (e.g., on a foreign VPS like Hetzner or AWS) may result in failed receipt verification. Specifically:

- Telebirr’s receipt pages (`https://transactioninfo.ethiotelecom.et/receipt/[REFERENCE]`) often **block or timeout** requests made from foreign IP addresses.
- Safaricom's M-Pesa API (`https://m-pesabusiness.safaricom.et/api/receipt/getReceipt`) strictly blocks connections from foreign data centers, resulting in `504 Gateway Timeout` or `500 Internal Server Errors`.

### ❌ Affected:

- VPS or cloud servers located outside Ethiopia/Kenya

### ✅ Works Best On:

- Ethiopian-hosted servers (e.g., Ethio Telecom web hosting, TeleCloud VPS)
- Developers self-hosting the code on infrastructure based in Ethiopia

#### 🛠 Proxy Support:

This project supports secondary fallback verification relays hosted inside Ethiopia. When the primary `verify-telebirr` or `verify-mpesa` fetch fails on your foreign VPS, the server can **fallback to our proxy** to complete the verification.
A standalone `mpesa.php` file is included in the `.github` / repository root which can be easily hosted on any cheap generic cPanel host inside Ethiopia to act as your own private proxy.

For best results and full control, clone the repository and **self-host the main Node.js application from inside Ethiopia**.

---

### 🔁 Skip Primary Verifier (For VPS Users)

If you know your environment cannot access the primary endpoint, set the following in your `.env`:

```env
SKIP_PRIMARY_VERIFICATION=true
```

This will skip the primary Telebirr receipt fetch entirely and go straight to the fallback proxy — only for your local use case. Other users can still benefit from both layers.

---

## ⚙️ Installation

```bash
git clone https://github.com/Vixen878/verifier-api
cd verifier-api
npm install
cp .env.example .env
```

Fill in `DATABASE_URL`, `SESSION_SECRET`, `APP_URL` and the Google credentials, then apply the schema:

```bash
npx prisma migrate deploy
```

---

## 🧪 Usage

### 🛠 Development

```bash
npm run dev
```

Without Google credentials, `/auth/dev-login` signs you in as `DEV_LOGIN_EMAIL` so the dashboard is usable
locally. It is disabled whenever `NODE_ENV=production`.

### 🚀 Production Build

```bash
npm run deploy   # prisma migrate deploy && prisma generate && tsc
npm start
```

---

## 🔐 Accounts, keys and quotas

The API is free but not anonymous: callers sign in with Google and issue their own keys.

| Surface | Path | Who can reach it |
| --- | --- | --- |
| Landing page and public widget | `/` | Anyone, rate-limited per IP |
| Documentation | `/docs` | Anyone |
| Dashboard | `/dashboard` | Signed-in users |
| Admin console | `/admin` | Users with the `ADMIN` role |

Send the key in the `x-veripay-key` header. `x-api-key` and `Authorization: Bearer` are accepted as the same key.

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify \
  -H 'content-type: application/json' \
  -H 'x-veripay-key: vp_live_…' \
  -d '{"reference":"FT25123ABCD","suffix":"12345678"}'
```

Keys are stored as SHA-256 hashes and shown once at creation. Ordinary accounts receive `X-RateLimit-*` and
`X-Quota-*` headers, and a `429` when they pass the per-minute limit or the monthly quota. Keys owned by an
administrator are not rate limited and have no monthly quota, so those headers are omitted.

`ADMIN_EMAILS` grants the administrator role only on first signup. If that list is empty, only the first
account on a fresh database becomes an administrator. Signing in again does not change a role; promote and
demote from `/admin`. From `/admin/settings` an administrator can change the default monthly quota, the
per-minute rate limit, the public widget allowance, batch limits, and whether new signups are accepted —
all without a redeploy.

---

## 🚢 Deploying to Plesk

1. **Create the database.** In Plesk, add a MySQL database and user, then set `DATABASE_URL`.
2. **Set the Node.js application.** Application root is the repository, application startup file is
   `dist/index.js`, application mode is `production`.
3. **Add environment variables** from `.env.example` through the Node.js extension UI. `SESSION_SECRET`,
   `DATABASE_URL`, `APP_URL` and the Google credentials are all required — the app refuses to start without
   the first three.
4. **Register the OAuth redirect URI** in Google Cloud Console as
   `https://veripay-1.app.aletcloud.com/auth/google/callback`. It must match `APP_URL` exactly.
5. **Run the build**: `npm run deploy`, then restart the application.

Two Plesk-specific details matter:

**Timeouts.** Legacy CBE receipts are fetched as PDFs and can take 30 seconds. Add these directives under
Apache & nginx Settings → Additional nginx directives:

```nginx
proxy_read_timeout 120s;
proxy_send_timeout 120s;
client_max_body_size 12m;
```

**Passenger instances.** The rate limiter keeps its counters in process memory, so running several
instances multiplies the effective limit. The monthly quota lives in the database and stays exact either
way. Pin the application to a single instance if you want the rate limit to be precise.

---

## 📡 API Endpoints

### 🚀 Universal Verification (Smart Router)

#### `POST /verify`

Verify a payment from multiple providers using a single endpoint. The API automatically detects the provider based on the reference format and accompanying payload.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "REQUIRED_REFERENCE_STRING",
  "suffix": "OPTIONAL_SUFFIX_FOR_CBE_OR_ABYSSINIA",
  "phoneNumber": "OPTIONAL_PHONE_FOR_CBEBIRR"
}
```

**Sorting Rules:**

- **Dashen Bank**: `reference` must be 16 chars starting with 3 digits. No extra params.
- **CBE**: `reference` must be 12 chars starting with `FT`. Requires 8-digit `suffix`.
- **Bank of Abyssinia**: `reference` must be 12 chars starting with `FT`. Requires 5-digit `suffix`.
- **CBE Birr**: `reference` must be 10 alphanumeric chars. Requires `phoneNumber` in `251XXXXXXXXX` form. Same API key as the other providers.
- **Telebirr**: `reference` must be 10 alphanumeric chars. No extra params.

---

### ✅ CBE Verification

#### `POST /verify-cbe`

Verify a CBE payment using a reference number and account suffix.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "REFERENCE_NUMBER",
  "accountSuffix": "ACCOUNT_SUFFIX"
}
```

---

### ✅ Telebirr Verification

#### `POST /verify-telebirr`

Verify a Telebirr payment using a reference number.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "REFERENCE_NUMBER"
}
```

---

### ✅ Dashen Bank Verification

#### `POST /verify-dashen`

Verify a Dashen bank payment using a reference number.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "DASHEN_REFERENCE_NUMBER"
}
```

**Response:**

```json
{
  "success": true,
  "senderName": "John Doe",
  "senderAccountNumber": "1234567890",
  "transactionChannel": "Mobile Banking",
  "serviceType": "Fund Transfer",
  "narrative": "Payment for services",
  "receiverName": "Jane Smith",
  "phoneNo": "251912345678",
  "transactionReference": "TXN123456",
  "transactionDate": "2023-06-15T10:30:00Z",
  "transactionAmount": 1000.0,
  "serviceCharge": 5.0,
  "total": 1005.0
}
```

---

### ✅ Bank of Abyssinia Verification

#### `POST /verify-abyssinia`

Verify a Bank of Abyssinia payment using a reference number and 5-digit suffix.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "ABYSSINIA_REFERENCE",
  "suffix": "12345"
}
```

**Note:** The suffix must be exactly 5 digits.

---

### ✅ M-Pesa Verification

#### `POST /verify-mpesa`

Verify an M-Pesa payment using a receipt number (reference).

**Requires API Key**

**Request Body:**

```json
{
  "reference": "RECEIPT_REFERENCE"
}
```

**Note:** The field is `reference`. `receiptNumber` is rejected with `400`. CBE Birr is the endpoint that uses `receiptNumber`.

---

### ✅ CBE Birr Verification

#### `POST /verify-cbebirr`

Verify a CBE Birr payment using receipt number and phone number.

**Requires API Key**

**Request Body:**

```json
{
  "receiptNumber": "RECEIPT_NUMBER",
  "phoneNumber": "251912345678"
}
```

**Note:** Phone number must be in Ethiopian format (251 + 9 digits).

---

### ✅ Image Verification

#### `POST /verify-image`

**Requires an administrator API key.** Regular keys receive `403`. The server also needs `MISTRAL_API_KEY`.

Verify a payment by uploading an image of the receipt. This endpoint supports both CBE and Telebirr screenshots.

**Request Body:**
Multipart form-data with an image file.

- Optional Query Param: `?autoVerify=true`  
  When enabled, the system detects the receipt type and routes it to the correct verification flow automatically.
- **Note**: If the auto-detected receipt is from CBE, the request **must** include your `Suffix` (last 8 digits of your account).

---

## 🧪 Try It (Sample cURL Commands)

The live API is `https://veripay-1.app.aletcloud.com`. Send the dashboard key as `x-veripay-key`. `x-api-key` and `Authorization: Bearer` are accepted as the same key.

### Universal smart router

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "FT253089F68Z", "suffix": "16825193" }'
```

### CBE

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify-cbe \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "FT2513001V2G", "accountSuffix": "39003377" }'
```

### Telebirr

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify-telebirr \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "CE2513001XYT" }'
```

### Dashen Bank

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify-dashen \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "DASHEN_REFERENCE_NUMBER" }'
```

### Bank of Abyssinia

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify-abyssinia \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "FT23062669JJ", "suffix": "12345" }'
```

### CBE Birr

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify-cbebirr \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "receiptNumber": "RECEIPT_NUMBER", "phoneNumber": "251912345678" }'
```

### M-Pesa

```bash
curl -X POST https://veripay-1.app.aletcloud.com/verify-mpesa \
  -H "x-veripay-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "RECEIPT_REFERENCE" }'
```

### Image

Administrator keys only.

```bash
curl -X POST "https://veripay-1.app.aletcloud.com/verify-image?autoVerify=true" \
  -H "x-veripay-key: YOUR_API_KEY" \
  -F "file=@yourfile.jpg" \
  -F "suffix=39003377"
```

### Health check

`GET /health` needs no key.

```bash
curl https://veripay-1.app.aletcloud.com/health
```

```json
{
  "status": "ok",
  "version": "4.0.1",
  "timestamp": "2026-11-19T00:00:00.000Z"
}
```

---

## Pages

`GET /` is the landing page. `GET /docs` is this API's documentation. Signed-in users manage keys at `/dashboard`. Administrators use the session console at `/admin` for accounts, keys, usage, and settings.

---

## Endpoint summary

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| POST | `/verify` | API key | Smart router for CBE, Telebirr, Dashen, Bank of Abyssinia, and CBE Birr |
| POST | `/verify-cbe` | API key | CBE by reference and account suffix |
| POST | `/verify-telebirr` | API key | Telebirr by reference |
| POST | `/verify-dashen` | API key | Dashen by reference |
| POST | `/verify-abyssinia` | API key | Bank of Abyssinia by reference and 5-digit suffix |
| POST | `/verify-cbebirr` | API key | CBE Birr by receipt number and phone |
| POST | `/verify-mpesa` | API key | M-Pesa by `reference` |
| POST | `/verify-image` | Admin API key | Receipt screenshot OCR |
| GET | `/health` | Public | Health check |
| GET | `/docs` | Public | Documentation |

---

## Environment

Copy `.env.example`. Production requires `DATABASE_URL`, `SESSION_SECRET`, and `APP_URL`. Google sign-in needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with the redirect URI set to `{APP_URL}/auth/google/callback`. `MISTRAL_API_KEY` is required for image verification.
