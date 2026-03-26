# BGAT API Gateway

**Black Gold Asset Technologies -- Permian Basin Water Intelligence Platform**

Cloudflare Worker providing a REST API for water quality analysis, well management, invoicing, and QuickBooks integration. Purpose-built for Permian Basin water treatment and disposal operations.

## Features

- **Water Sample Analysis** -- Parse DownHole SAT (Sample Analysis Test) reports from PDF uploads. Extracts 20+ ion concentrations (chloride, sulfate, barium, calcium, etc.), calculates ion balance, and detects scale potential (calcite, barite, iron)
- **Well Management** -- CRUD operations for wells with location data, API numbers, formation, and operational status
- **Invoice System** -- Generate, track, and manage invoices for water services
- **Customer Management** -- Customer database with contact and billing information
- **Expense Tracking** -- Log and categorize operational expenses
- **Alert System** -- Threshold-based alerts for water quality exceedances
- **Estimate Generation** -- Create service estimates for prospective work
- **QuickBooks Integration** -- Full OAuth 2.0 flow for syncing invoices to QuickBooks Online (auth, callback, sync-invoice, disconnect)
- **Lightweight PDF Parsing** -- Custom text extraction from PDF uploads without external library dependencies

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with version and binding status |
| `GET` | `/api/v1/wells` | List all wells |
| `POST` | `/api/v1/wells` | Create a new well |
| `GET` | `/api/v1/samples` | List water samples |
| `POST` | `/api/v1/samples/upload` | Upload and parse a DownHole SAT PDF report |
| `GET` | `/api/v1/invoices` | List invoices |
| `POST` | `/api/v1/invoices` | Create an invoice |
| `GET` | `/api/v1/customers` | List customers |
| `POST` | `/api/v1/customers` | Create a customer |
| `GET` | `/api/v1/alerts` | List active alerts |
| `POST` | `/api/v1/alerts` | Create an alert |
| `GET` | `/api/v1/estimates` | List estimates |
| `POST` | `/api/v1/estimates` | Create an estimate |
| `GET` | `/api/v1/expenses` | List expenses |
| `POST` | `/api/v1/expenses` | Log an expense |
| `GET` | `/api/v1/quickbooks/auth` | Initiate QuickBooks OAuth 2.0 flow |
| `GET` | `/api/v1/quickbooks/callback` | QuickBooks OAuth callback handler |
| `POST` | `/api/v1/quickbooks/sync-invoice` | Sync an invoice to QuickBooks |
| `POST` | `/api/v1/quickbooks/disconnect` | Disconnect QuickBooks integration |

## Configuration

### wrangler.toml

```toml
name = "bgat-api-gateway"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
```

### Bindings

| Type | Binding | Resource |
|------|---------|----------|
| D1 | `DB` | `bgat-alerts-db` |
| KV | `CACHE` | KV namespace for caching |
| R2 | `MEDIA` | `bgat-media` bucket for PDF/media storage |
| Service | `ECHO_CHAT` | `echo-chat` (AI responses) |
| Service | `SHARED_BRAIN` | `echo-shared-brain` (memory) |
| Service | `ENGINE_RUNTIME` | `echo-engine-runtime` (domain engines) |

### Secrets

| Name | Description |
|------|-------------|
| `ECHO_API_KEY` | Echo Prime API authentication key |
| `QB_CLIENT_ID` | QuickBooks OAuth client ID |
| `QB_CLIENT_SECRET` | QuickBooks OAuth client secret |
| `QB_REDIRECT_URI` | QuickBooks OAuth redirect URI |
| `QB_ENVIRONMENT` | QuickBooks environment (`sandbox` or `production`) |

### Cron Triggers

| Schedule | Description |
|----------|-------------|
| `0 */6 * * *` | Every 6 hours -- periodic maintenance |

## Deployment

```bash
cd WORKERS/bgat-api-gateway
npx wrangler deploy
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Storage**: Cloudflare R2
- **PDF Parsing**: Custom lightweight parser (no external deps)
- **Accounting**: QuickBooks Online API (OAuth 2.0)
- **Source**: `src/index.ts` (1,057 lines)
