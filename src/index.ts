/**
 * BGAT API Gateway v3.0.0 — Black Gold Asset Technologies
 * Permian Basin Water Intelligence Platform API
 *
 * Routes: /health, /api/v1/wells, /api/v1/samples, /api/v1/samples/upload,
 *         /api/v1/invoices, /api/v1/customers, /api/v1/alerts,
 *         /api/v1/estimates, /api/v1/expenses, /api/v1/quickbooks/*
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Env {
  DB: D1Database;
  WATER_DB: D1Database;
  CACHE: KVNamespace;
  R2: R2Bucket;
  ECHO_CHAT: Fetcher;
  SHARED_BRAIN: Fetcher;
  ENGINE_RUNTIME: Fetcher;
  WORKER_VERSION: string;
  ECHO_API_KEY: string;
  QB_CLIENT_ID: string;
  QB_CLIENT_SECRET: string;
  QB_REDIRECT_URI: string;
  QB_ENVIRONMENT: string;
}

type Variables = {
  userId?: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Middleware
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use('*', cors({
  origin: ['https://www.blackgoldasset.com', 'https://blackgoldasset.com', 'https://jp.echo-op.com', 'http://localhost:3000', 'http://localhost:8788'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Echo-API-Key'],
  maxAge: 86400,
}));

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  c.header('X-Response-Time', `${ms}ms`);
  log('info', 'request', { method: c.req.method, path: c.req.path, status: c.res.status, ms });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Logging
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function log(level: string, msg: string, data?: Record<string, unknown>): void {
  console.log(JSON.stringify({ worker: 'bgat-api-gateway', level, msg, ...data, ts: new Date().toISOString() }));
}

function uuid(): string {
  return crypto.randomUUID();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Health
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/', (c) => c.json({ service: 'bgat-api-gateway', status: 'operational' }));

app.get('/health', async (c) => {
  const env = c.env;
  let dbOk = false;
  try {
    const r = await env.DB.prepare('SELECT 1 as ok').first();
    dbOk = !!r;
  } catch { /* */ }
  return c.json({
    status: dbOk ? 'healthy' : 'degraded',
    worker: 'bgat-api-gateway',
    version: env.WORKER_VERSION || '3.0.0',
    backend: 'd1',
    db: dbOk ? 'connected' : 'error',
    timestamp: new Date().toISOString(),
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Wells (WATER_DB — permian-pulse-water)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/wells', async (c) => {
  const db = c.env.WATER_DB;
  const page = parseInt(c.req.query('page') || '1');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '20'), 200);
  const search = c.req.query('search') || '';
  const status = c.req.query('status') || '';
  const formation = c.req.query('formation') || '';
  const county = c.req.query('county') || '';
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const countParams: unknown[] = [];

  if (search) {
    conditions.push("(w.well_name LIKE ? OR w.api_number LIKE ? OR w.county LIKE ? OR o.operator_name LIKE ?)");
    countParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    conditions.push("w.well_status = ?");
    countParams.push(status);
  }
  if (formation) {
    conditions.push("w.target_formation = ?");
    countParams.push(formation);
  }
  if (county) {
    conditions.push("w.county = ?");
    countParams.push(county);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) as total FROM wells w LEFT JOIN operators o ON w.operator_id = o.id ${where}`;
  const dataSql = `
    SELECT w.*, o.operator_name,
      (SELECT COUNT(*) FROM samples s2 WHERE s2.well_id = w.id) as sample_count,
      (SELECT MAX(s3.sample_date) FROM samples s3 WHERE s3.well_id = w.id) as latest_sample_date
    FROM wells w
    LEFT JOIN operators o ON w.operator_id = o.id
    ${where}
    ORDER BY w.well_name
    LIMIT ? OFFSET ?`;

  const dataParams = [...countParams, perPage, offset];

  const [countRes, dataRes] = await Promise.all([
    db.prepare(countSql).bind(...countParams).first<{ total: number }>(),
    db.prepare(dataSql).bind(...dataParams).all(),
  ]);

  return c.json({ items: dataRes.results, total: countRes?.total || 0, page, per_page: perPage });
});

app.get('/api/v1/wells/:id', async (c) => {
  const db = c.env.WATER_DB;
  const id = c.req.param('id');
  const well = await db.prepare(
    `SELECT w.*, o.operator_name,
      (SELECT COUNT(*) FROM samples s WHERE s.well_id = w.id) as sample_count,
      (SELECT MAX(s2.sample_date) FROM samples s2 WHERE s2.well_id = w.id) as latest_sample_date,
      (SELECT COUNT(*) FROM variance_alerts va WHERE va.well_id = w.id AND va.acknowledged = 0) as active_alerts
    FROM wells w
    LEFT JOIN operators o ON w.operator_id = o.id
    WHERE w.id = ?`
  ).bind(id).first();
  if (!well) return c.json({ error: 'Well not found' }, 404);
  return c.json(well);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Wells — Samples for a well (WATER_DB)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/wells/:id/samples', async (c) => {
  const db = c.env.WATER_DB;
  const wellId = c.req.param('id');
  const page = parseInt(c.req.query('page') || '1');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '50'), 200);
  const offset = (page - 1) * perPage;

  const countRes = await db.prepare(
    'SELECT COUNT(*) as total FROM samples WHERE well_id = ?'
  ).bind(wellId).first<{ total: number }>();

  const dataRes = await db.prepare(`
    SELECT s.id, s.well_id, s.lab_id, s.sample_date, s.received_date, s.report_date,
      s.lab_id_number, s.sample_point, s.sample_type, s.pdf_filename, s.pdf_r2_key,
      s.validation_status, s.ion_balance_pct, s.tds_calculated, s.tds_measured, s.notes,
      s.created_at, s.updated_at,
      ir.calcium, ir.magnesium, ir.barium, ir.strontium, ir.sodium, ir.potassium,
      ir.iron, ir.manganese, ir.lithium, ir.zinc, ir.lead, ir.boron, ir.silica,
      ir.chloride, ir.sulfate, ir.dissolved_co2, ir.bicarbonate, ir.h2s,
      ir.bromide, ir.fluoride, ir.nitrate,
      ir.temperature_f, ir.sample_ph, ir.conductivity, ir.tds, ir.resistivity,
      ir.specific_gravity, ir.total_hardness, ir.total_alkalinity,
      ir.cation_meq_total, ir.anion_meq_total, ir.ion_balance_pct as ir_ion_balance_pct,
      l.lab_name
    FROM samples s
    LEFT JOIN ion_readings ir ON ir.sample_id = s.id
    LEFT JOIN labs l ON s.lab_id = l.id
    WHERE s.well_id = ?
    ORDER BY s.sample_date DESC
    LIMIT ? OFFSET ?
  `).bind(wellId, perPage, offset).all();

  return c.json({ items: dataRes.results, total: countRes?.total || 0, page, per_page: perPage });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Wells — Ion Trends for a well (WATER_DB)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const VALID_ION_COLUMNS = new Set([
  'calcium', 'magnesium', 'barium', 'strontium', 'sodium', 'potassium',
  'iron', 'manganese', 'lithium', 'zinc', 'lead', 'boron', 'silica',
  'chloride', 'sulfate', 'dissolved_co2', 'bicarbonate', 'h2s',
  'bromide', 'fluoride', 'nitrate',
  'temperature_f', 'sample_ph', 'conductivity', 'tds', 'resistivity',
  'specific_gravity', 'total_hardness', 'total_alkalinity',
]);

app.get('/api/v1/wells/:id/trends', async (c) => {
  const db = c.env.WATER_DB;
  const wellId = c.req.param('id');
  const ion = c.req.query('ion') || 'tds';

  if (!VALID_ION_COLUMNS.has(ion)) {
    return c.json({ error: `Invalid ion column: ${ion}. Valid: ${Array.from(VALID_ION_COLUMNS).join(', ')}` }, 400);
  }

  // Safe to interpolate column name since it's validated against whitelist
  const dataRes = await db.prepare(`
    SELECT s.sample_date, ir.${ion} as value
    FROM samples s
    JOIN ion_readings ir ON ir.sample_id = s.id
    WHERE s.well_id = ? AND ir.${ion} IS NOT NULL
    ORDER BY s.sample_date ASC
  `).bind(wellId).all();

  // Also return well_statistics for this ion
  const stats = await db.prepare(
    'SELECT mean_value, stddev_value, min_value, max_value, sample_count, trend FROM well_statistics WHERE well_id = ? AND ion_name = ?'
  ).bind(wellId, ion).first();

  return c.json({
    well_id: wellId,
    ion,
    points: dataRes.results,
    statistics: stats || null,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Samples (GET) — WATER_DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/samples', async (c) => {
  const db = c.env.WATER_DB;
  const wellId = c.req.query('well_id');
  const page = parseInt(c.req.query('page') || '1');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '20'), 200);
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (wellId) {
    conditions.push('s.well_id = ?');
    params.push(wellId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) as total FROM samples s ${where}`;
  const dataSql = `SELECT s.*, w.well_name, l.lab_name FROM samples s LEFT JOIN wells w ON s.well_id = w.id LEFT JOIN labs l ON s.lab_id = l.id ${where} ORDER BY s.sample_date DESC LIMIT ? OFFSET ?`;

  const countParams = [...params];
  const dataParams = [...params, perPage, offset];

  const [countRes, dataRes] = await Promise.all([
    db.prepare(countSql).bind(...countParams).first<{ total: number }>(),
    db.prepare(dataSql).bind(...dataParams).all(),
  ]);

  return c.json({ items: dataRes.results, total: countRes?.total || 0, page, per_page: perPage });
});

app.get('/api/v1/samples/:id', async (c) => {
  const db = c.env.WATER_DB;
  const id = c.req.param('id');
  const sample = await db.prepare(
    'SELECT s.*, w.well_name, l.lab_name FROM samples s LEFT JOIN wells w ON s.well_id = w.id LEFT JOIN labs l ON s.lab_id = l.id WHERE s.id = ?'
  ).bind(id).first();
  if (!sample) return c.json({ error: 'Sample not found' }, 404);

  const ions = await db.prepare('SELECT * FROM ion_readings WHERE sample_id = ?').bind(id).first();
  const scale = await db.prepare('SELECT * FROM scale_potential WHERE sample_id = ? ORDER BY temperature_f').bind(id).all();

  return c.json({ ...sample, ion_readings: ions || null, scale_potential: scale.results });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Samples Upload — PDF Parsing (THE FIX)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/v1/samples/upload', async (c) => {
  const db = c.env.WATER_DB;
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ error: 'No file provided' }, 400);

  const filename = file.name;
  if (!filename.toLowerCase().endsWith('.pdf')) {
    return c.json({ error: 'Only PDF files are supported' }, 400);
  }

  const fileBuffer = await file.arrayBuffer();
  if (fileBuffer.byteLength > 20 * 1024 * 1024) {
    return c.json({ error: 'File too large (max 20 MB)' }, 400);
  }

  log('info', 'upload_started', { filename, size: fileBuffer.byteLength });

  // Extract text from PDF binary
  const pdfText = extractTextFromPDF(new Uint8Array(fileBuffer));

  // Parse ion chemistry from PDF text
  const parsed = parseDownHoleSAT(pdfText, filename);

  // Calculate ion balance (with corrected equivalent weights)
  const ionBalance = calculateIonBalance(parsed);

  // Store PDF in R2
  const r2Key = `pdfs/${Date.now()}/${filename}`;
  try {
    await c.env.R2.put(r2Key, fileBuffer, {
      customMetadata: { originalName: filename },
    });
  } catch (e) {
    log('warn', 'r2_upload_failed', { error: (e as Error).message });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 7-Step Insertion Pattern (WATER_DB — permian-pulse-water)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // --- Step 1: Smart filename parsing + operator resolution ---
  const fnInfo = parseWellInfoFromFilename(filename);
  const explicitOperator = formData.get('operator_name') as string | null;
  const operatorName = explicitOperator || fnInfo.operator || 'Unknown Operator';
  await db.prepare(
    `INSERT INTO operators (operator_name) VALUES (?) ON CONFLICT(operator_name) DO NOTHING`
  ).bind(operatorName).run();
  const operatorRow = await db.prepare(
    'SELECT id FROM operators WHERE operator_name = ?'
  ).bind(operatorName).first<{ id: number }>();
  const operatorId = operatorRow?.id || null;

  // --- Step 2: Resolve well (with fuzzy search fallback) ---
  const explicitWellName = formData.get('well_name') as string | null;
  const extractedApiNum = (parsed as Record<string, unknown>)['_api_number'] as string | null;
  const apiNumber = (formData.get('api_number') as string) || extractedApiNum || null;
  const fieldName = (formData.get('field_name') as string) || null;
  const county = (formData.get('county') as string) || null;
  const targetFormation = (formData.get('target_formation') as string) || null;
  const latitude = formData.get('latitude') ? parseFloat(formData.get('latitude') as string) : null;
  const longitude = formData.get('longitude') ? parseFloat(formData.get('longitude') as string) : null;

  // Determine well name: explicit form field > smart filename parse
  // Note: parsed.sample_point is the sample type (Wellhead, Separator, etc.), NOT the well name
  const wellName = explicitWellName || fnInfo.wellName;

  // Use filename-extracted date as fallback if PDF didn't have one
  if (!parsed.sample_date && fnInfo.sampleDate) {
    parsed.sample_date = fnInfo.sampleDate;
  }

  // First try exact match (API number or well_name+operator)
  let wellRow: { id: number; well_name: string } | null = null;
  if (apiNumber) {
    wellRow = await db.prepare('SELECT id, well_name FROM wells WHERE api_number = ?').bind(apiNumber).first<{ id: number; well_name: string }>();
  }
  if (!wellRow) {
    wellRow = await db.prepare('SELECT id, well_name FROM wells WHERE well_name = ? AND operator_id = ?').bind(wellName, operatorId).first<{ id: number; well_name: string }>();
  }

  // Fuzzy search: if no exact match, search by LIKE patterns against existing wells
  let fuzzyMatched = false;
  if (!wellRow && !explicitWellName) {
    // Split well name into keywords and search
    const keywords = wellName.split(/\s+/).filter((w: string) => w.length > 2);
    if (keywords.length > 0) {
      const likePattern = `%${keywords.join('%')}%`;
      wellRow = await db.prepare(
        'SELECT id, well_name FROM wells WHERE well_name LIKE ? ORDER BY well_name LIMIT 1'
      ).bind(likePattern).first<{ id: number; well_name: string }>();

      // If still no match, try each keyword individually
      if (!wellRow && keywords.length > 1) {
        for (const kw of keywords) {
          wellRow = await db.prepare(
            'SELECT id, well_name FROM wells WHERE well_name LIKE ? ORDER BY well_name LIMIT 1'
          ).bind(`%${kw}%`).first<{ id: number; well_name: string }>();
          if (wellRow) break;
        }
      }
      if (wellRow) {
        fuzzyMatched = true;
        log('info', 'well_fuzzy_match', { search: wellName, matched: wellRow.well_name, wellId: wellRow.id });
      }
    }
  }

  // No match found — create new well
  let wellCreated = false;
  if (!wellRow) {
    wellCreated = true;
    if (apiNumber) {
      await db.prepare(
        `INSERT INTO wells (well_name, api_number, operator_id, target_formation, field_name, county, state, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?, 'TX', ?, ?)
         ON CONFLICT(api_number) DO UPDATE SET updated_at = datetime('now')`
      ).bind(wellName, apiNumber, operatorId, targetFormation, fieldName, county, latitude, longitude).run();
    } else {
      await db.prepare(
        `INSERT INTO wells (well_name, operator_id, target_formation, field_name, county, state, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, 'TX', ?, ?)`
      ).bind(wellName, operatorId, targetFormation, fieldName, county, latitude, longitude).run();
    }
    wellRow = apiNumber
      ? await db.prepare('SELECT id, well_name FROM wells WHERE api_number = ?').bind(apiNumber).first<{ id: number; well_name: string }>()
      : await db.prepare('SELECT id, well_name FROM wells WHERE well_name = ? AND operator_id = ?').bind(wellName, operatorId).first<{ id: number; well_name: string }>();
  }

  const wellId = wellRow?.id;
  if (!wellId) {
    return c.json({ error: 'Failed to resolve well ID after upsert' }, 500);
  }

  // --- Step 3: Insert sample ---
  let labId: number | null = null;
  if (parsed.lab_name) {
    const labRow = await db.prepare(
      'SELECT id FROM labs WHERE lab_name LIKE ? OR lab_code LIKE ? LIMIT 1'
    ).bind(`%${parsed.lab_name}%`, `%${parsed.lab_name}%`).first<{ id: number }>();
    labId = labRow?.id || null;
  }

  const sampleRes = await db.prepare(`
    INSERT INTO samples (well_id, lab_id, sample_date, received_date, report_date,
      lab_id_number, sample_point, sample_type, pdf_filename, pdf_r2_key,
      validation_status, ion_balance_pct, tds_calculated, tds_measured, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'produced_water', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    wellId, labId,
    parsed.sample_date || new Date().toISOString().split('T')[0],
    null, // received_date
    parsed.report_date || null,
    parsed.lab_sample_id || null,
    parsed.sample_point || null,
    filename, r2Key,
    ionBalance.valid ? 'validated' : 'needs_review',
    ionBalance.pct,
    parsed.tds ? Math.round(ionBalance.cation_meq * 23 + ionBalance.anion_meq * 35.5) : null, // rough TDS estimate from meq
    parsed.tds || null,
    ionBalance.valid ? null : `Ion balance ${ionBalance.pct.toFixed(2)}% exceeds 5% threshold`
  ).run();

  const sampleId = sampleRes.meta.last_row_id;

  // --- Step 4: Insert ion_readings ---
  await db.prepare(`
    INSERT INTO ion_readings (sample_id,
      calcium, magnesium, barium, strontium, sodium, potassium,
      iron, manganese, lithium, zinc, lead, boron, silica,
      chloride, sulfate, dissolved_co2, bicarbonate, h2s,
      bromide, fluoride, nitrate,
      temperature_f, sample_ph, conductivity, tds, resistivity, specific_gravity,
      total_hardness, total_alkalinity,
      cation_meq_total, anion_meq_total, ion_balance_pct)
    VALUES (?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?)
  `).bind(
    sampleId,
    parsed.calcium, parsed.magnesium, parsed.barium, parsed.strontium, parsed.sodium, parsed.potassium,
    parsed.iron, parsed.manganese, parsed.lithium, parsed.zinc, parsed.lead, parsed.boron, parsed.silica,
    parsed.chloride, parsed.sulfate, parsed.dissolved_co2, parsed.bicarbonate, parsed.h2s,
    parsed.bromide, parsed.fluoride, parsed.nitrate,
    parsed.temperature_f, parsed.sample_ph, parsed.conductivity, parsed.tds, parsed.resistivity, parsed.specific_gravity,
    parsed.total_hardness, parsed.total_alkalinity,
    ionBalance.cation_meq, ionBalance.anion_meq, ionBalance.pct
  ).run();

  // --- Step 5: Insert scale_potential (12 rows per temperature) ---
  if (parsed.scale_rows && parsed.scale_rows.length > 0) {
    const scaleBatch: D1PreparedStatement[] = [];
    for (const row of parsed.scale_rows) {
      scaleBatch.push(
        db.prepare(`
          INSERT INTO scale_potential (sample_id, temperature_f,
            calcite_xsat, barite_xsat, celestite_xsat, gypsum_xsat, siderite_xsat)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(sampleId, row.temp_f, row.caco3, row.baso4, row.srso4, row.caso4, row.feco3)
      );
    }
    await db.batch(scaleBatch);
  }

  // --- Step 6: Run variance detection ---
  const alerts = await runVarianceDetection(db, sampleId as number, wellId, parsed, ionBalance);

  // --- Step 7: Update well_statistics (rolling recalculation) ---
  await updateWellStatistics(db, wellId);

  // Invalidate KV cache for formation averages
  if (targetFormation) {
    try { await c.env.CACHE.delete(`formation:${targetFormation}`); } catch { /* */ }
  }

  log('info', 'upload_complete', {
    sampleId, filename, wellId, operatorId,
    ionsParsed: parsed._parsed_count,
    scaleRows: parsed.scale_rows?.length || 0,
    ionBalance: ionBalance.pct.toFixed(2),
    valid: ionBalance.valid,
    alertsGenerated: alerts.length,
  });

  return c.json({
    id: sampleId,
    well_id: wellId,
    well_name: wellRow?.well_name || wellName,
    operator_name: operatorName,
    sample_date: parsed.sample_date || new Date().toISOString().split('T')[0],
    lab_id_number: parsed.lab_sample_id || null,
    lab_name: parsed.lab_name || null,
    tds: parsed.tds,
    sample_ph: parsed.sample_ph,
    chloride: parsed.chloride,
    calcium: parsed.calcium,
    magnesium: parsed.magnesium,
    sodium: parsed.sodium,
    potassium: parsed.potassium,
    barium: parsed.barium,
    strontium: parsed.strontium,
    iron: parsed.iron,
    manganese: parsed.manganese,
    sulfate: parsed.sulfate,
    h2s: parsed.h2s,
    conductivity: parsed.conductivity,
    specific_gravity: parsed.specific_gravity,
    temperature_f: parsed.temperature_f,
    ion_balance_pct: ionBalance.pct,
    cation_meq_total: ionBalance.cation_meq,
    anion_meq_total: ionBalance.anion_meq,
    validation_status: ionBalance.valid ? 'validated' : 'needs_review',
    scale_rows_parsed: parsed.scale_rows?.length || 0,
    alerts_generated: alerts.length,
    alerts,
    ingestion_method: 'pdf_upload',
    well_match_type: wellCreated ? 'new' : (fuzzyMatched ? 'fuzzy' : 'exact'),
    location_source: explicitWellName ? 'form_field' : 'filename',
    operator_detected: fnInfo.operator,
    warnings: parsed._warnings,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Admin: Clean up well names from filename-derived data
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/v1/admin/cleanup-wells', async (c) => {
  const db = c.env.WATER_DB;
  const wells = await db.prepare('SELECT id, well_name FROM wells ORDER BY id').all<{ id: number; well_name: string }>();
  const updates: { id: number; oldName: string; newName: string; operator: string | null }[] = [];
  const merges: { kept: number; merged: number; oldName: string }[] = [];

  // Track clean names to detect duplicates
  const cleanNameMap = new Map<string, number>();

  for (const well of wells.results || []) {
    // Re-parse the well name as if it were a filename
    const info = parseWellInfoFromFilename(well.well_name + '.pdf');
    const cleanName = info.wellName;

    if (cleanName !== well.well_name) {
      // Check if a well with this clean name already exists
      const existingId = cleanNameMap.get(cleanName.toLowerCase());
      if (existingId) {
        // Merge: reassign all references from this well to the existing one, then delete
        await db.prepare('UPDATE samples SET well_id = ? WHERE well_id = ?').bind(existingId, well.id).run();
        try { await db.prepare('UPDATE variance_alerts SET well_id = ? WHERE well_id = ?').bind(existingId, well.id).run(); } catch { /* table may not exist */ }
        try { await db.prepare('UPDATE invoice_line_items SET well_id = ? WHERE well_id = ?').bind(existingId, well.id).run(); } catch { /* table may not exist */ }
        try { await db.prepare('DELETE FROM well_statistics WHERE well_id = ?').bind(well.id).run(); } catch { /* */ }
        try { await db.prepare('UPDATE estimates SET well_id = ? WHERE well_id = ?').bind(existingId, well.id).run(); } catch { /* */ }
        await db.prepare('DELETE FROM wells WHERE id = ?').bind(well.id).run();
        merges.push({ kept: existingId, merged: well.id, oldName: well.well_name });
      } else {
        // Update well name
        await db.prepare('UPDATE wells SET well_name = ? WHERE id = ?').bind(cleanName, well.id).run();
        updates.push({ id: well.id, oldName: well.well_name, newName: cleanName, operator: info.operator });
        cleanNameMap.set(cleanName.toLowerCase(), well.id);

        // Also update operator if we detected one from the filename and current is Unknown
        if (info.operator) {
          await db.prepare(
            `INSERT INTO operators (operator_name) VALUES (?) ON CONFLICT(operator_name) DO NOTHING`
          ).bind(info.operator).run();
          const opRow = await db.prepare('SELECT id FROM operators WHERE operator_name = ?').bind(info.operator).first<{ id: number }>();
          if (opRow) {
            const currentOp = await db.prepare('SELECT operator_id FROM wells WHERE id = ?').bind(well.id).first<{ operator_id: number }>();
            // Only update if operator is currently "Unknown Operator" (id 3 typically)
            const unknownOp = await db.prepare("SELECT id FROM operators WHERE operator_name = 'Unknown Operator'").first<{ id: number }>();
            if (currentOp?.operator_id === unknownOp?.id) {
              await db.prepare('UPDATE wells SET operator_id = ? WHERE id = ?').bind(opRow.id, well.id).run();
            }
          }
        }
      }
    } else {
      cleanNameMap.set(cleanName.toLowerCase(), well.id);
    }
  }

  // Recalculate statistics for all affected wells
  const affectedIds = new Set([...updates.map(u => u.id), ...merges.map(m => m.kept)]);
  for (const wid of affectedIds) {
    await updateWellStatistics(db, wid);
  }

  return c.json({
    total_wells: (wells.results || []).length,
    updated: updates.length,
    merged: merges.length,
    updates,
    merges,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF Text Extraction (binary PDF → plaintext)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function extractTextFromPDF(bytes: Uint8Array): string {
  // Lightweight PDF text extraction for Workers (no external libs)
  // Handles uncompressed text streams — covers most SAT lab reports
  const text = new TextDecoder('latin1').decode(bytes);
  const lines: string[] = [];

  // Extract text between BT...ET blocks (PDF text objects)
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match: RegExpExecArray | null;
  while ((match = btEtRegex.exec(text)) !== null) {
    const block = match[1];
    // Extract Tj string operands — handle escaped parens inside PDF strings
    // PDF spec: strings are delimited by () with \( and \) as literal parens
    const tjRegex = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let tj: RegExpExecArray | null;
    while ((tj = tjRegex.exec(block)) !== null) {
      // Unescape PDF string escapes
      lines.push(tj[1].replace(/\\([()\\])/g, '$1'));
    }
    // TJ arrays: [(string) number (string) ...]
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
    let tja: RegExpExecArray | null;
    while ((tja = tjArrayRegex.exec(block)) !== null) {
      const parts = tja[1].match(/\(((?:[^()\\]|\\.)*)\)/g);
      if (parts) {
        lines.push(parts.map(p => p.slice(1, -1).replace(/\\([()\\])/g, '$1')).join(''));
      }
    }
  }

  // Also try to extract from FlateDecode streams (compressed)
  // Workers don't have zlib, so check for non-compressed streams too
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch: RegExpExecArray | null;
  while ((streamMatch = streamRegex.exec(text)) !== null) {
    const content = streamMatch[1];
    // Skip binary/compressed streams (start with non-printable chars)
    if (content.length < 5000 && /^[\x20-\x7E\r\n\t]+$/.test(content.slice(0, 200))) {
      const innerTj = content.match(/\(((?:[^()\\]|\\.){1,200})\)\s*Tj/g);
      if (innerTj) {
        for (const t of innerTj) {
          const m = t.match(/\(((?:[^()\\]|\\.)*)\)/);
          if (m) lines.push(m[1].replace(/\\([()\\])/g, '$1'));
        }
      }
    }
  }

  // If no BT/ET extraction worked, try raw text scanning for lab report patterns
  if (lines.length < 5) {
    // Fallback: scan raw bytes for readable ASCII sequences that look like lab data
    const rawText = text.replace(/[^\x20-\x7E\r\n]/g, ' ').replace(/\s+/g, ' ');
    return rawText;
  }

  return lines.join('\n');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DownHole SAT Report Parser
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface ScaleRow {
  temp_f: number;
  caco3: number | null;
  baso4: number | null;
  srso4: number | null;
  caso4: number | null;
  feco3: number | null;
}

interface ParsedReport {
  // Ions (mg/L)
  calcium: number | null;
  magnesium: number | null;
  barium: number | null;
  strontium: number | null;
  sodium: number | null;
  potassium: number | null;
  iron: number | null;
  manganese: number | null;
  lithium: number | null;
  zinc: number | null;
  lead: number | null;
  boron: number | null;
  silica: number | null;
  chloride: number | null;
  sulfate: number | null;
  dissolved_co2: number | null;
  bicarbonate: number | null;
  h2s: number | null;
  bromide: number | null;
  fluoride: number | null;
  nitrate: number | null;
  // Physical
  temperature_f: number | null;
  sample_ph: number | null;
  conductivity: number | null;
  tds: number | null;
  resistivity: number | null;
  specific_gravity: number | null;
  total_alkalinity: number | null;
  total_hardness: number | null;
  // Metadata
  sample_date: string | null;
  report_date: string | null;
  lab_name: string | null;
  lab_sample_id: string | null;
  well_id: string | null;
  sample_point: string | null;
  // Scale
  scale_rows: ScaleRow[];
  // Stats
  _parsed_count: number;
  _warnings: string[];
}

function parseDownHoleSAT(text: string, filename: string): ParsedReport {
  const result: ParsedReport = {
    calcium: null, magnesium: null, barium: null, strontium: null, sodium: null,
    potassium: null, iron: null, manganese: null, lithium: null, zinc: null,
    lead: null, boron: null, silica: null, chloride: null, sulfate: null,
    dissolved_co2: null, bicarbonate: null, h2s: null, bromide: null,
    fluoride: null, nitrate: null,
    temperature_f: null, sample_ph: null, conductivity: null, tds: null,
    resistivity: null, specific_gravity: null, total_alkalinity: null, total_hardness: null,
    sample_date: null, report_date: null, lab_name: null, lab_sample_id: null,
    well_id: null, sample_point: null,
    scale_rows: [],
    _parsed_count: 0,
    _warnings: [],
  };

  if (!text || text.trim().length < 20) {
    result._warnings.push('PDF text extraction yielded minimal content — data estimated from filename patterns');
    return estimateFromFilename(result, filename);
  }

  const upper = text.toUpperCase();

  // Ion patterns — match "Calcium", "Calcium (Ca):", "Ca:" etc. followed by a number
  // Uses [^0-9]* to skip parenthetical abbreviations, colons, spaces between label and value
  const ionPatterns: [keyof ParsedReport, RegExp[]][] = [
    ['calcium', [/calcium[^0-9]*?(\d+[\d,.]*)/i, /\bca\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['magnesium', [/magnesium[^0-9]*?(\d+[\d,.]*)/i, /\bmg\b[^0-9a-z]*?(\d+[\d,.]*)/i]],
    ['barium', [/barium[^0-9]*?(\d+[\d,.]*)/i, /\bba\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['strontium', [/strontium[^0-9]*?(\d+[\d,.]*)/i, /\bsr\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['sodium', [/sodium[^0-9]*?(\d+[\d,.]*)/i, /\bna\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['potassium', [/potassium[^0-9]*?(\d+[\d,.]*)/i, /\bk\b[^0-9a-z]*?(\d+[\d,.]*)/i]],
    ['iron', [/iron[^0-9]*?(\d+[\d,.]*)/i, /\bfe\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['manganese', [/manganese[^0-9]*?(\d+[\d,.]*)/i, /\bmn\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['lithium', [/lithium[^0-9]*?(\d+[\d,.]*)/i, /\bli\b[^0-9a-z]*?(\d+[\d,.]*)/i]],
    ['chloride', [/chloride[^0-9]*?(\d+[\d,.]*)/i, /\bcl\b[^0-9a-z]*?(\d+[\d,.]*)/i]],
    ['sulfate', [/sulfate\s*(?:\([^)]*\))?\s*[:\s]+(\d+[\d,.]*)/i, /\bso4\s*[:\s]+(\d+[\d,.]*)/i]],
    ['bicarbonate', [/bicarbonate\s*(?:\([^)]*\))?\s*[:\s]+(\d+[\d,.]*)/i, /\bhco3\s*[:\s]+(\d+[\d,.]*)/i]],
    ['h2s', [/\bh2s\s*[:\s]+(\d+[\d,.]*)/i, /hydrogen\s*sulfide[^0-9]*?(\d+[\d,.]*)/i]],
    ['bromide', [/bromide\s*(?:\([^)]*\))?\s*[:\s]+(\d+[\d,.]*)/i, /\bbr\b\s*[:\s]+(\d+[\d,.]*)/i]],
    ['fluoride', [/fluoride\s*(?:\([^)]*\))?\s*[:\s]+(\d+[\d,.]*)/i]],
    ['nitrate', [/nitrate\s*(?:\([^)]*\))?\s*[:\s]+(\d+[\d,.]*)/i, /\bno3\s*[:\s]+(\d+[\d,.]*)/i]],
    ['boron', [/boron[^0-9]*?(\d+[\d,.]*)/i, /\bb\b[^0-9a-z]*?(\d+[\d,.]*)/i]],
    ['silica', [/silica[^0-9]*?(\d+[\d,.]*)/i, /\bsio2\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['zinc', [/zinc[^0-9]*?(\d+[\d,.]*)/i, /\bzn\b[^0-9]*?(\d+[\d,.]*)/i]],
    ['lead', [/\blead\b[^0-9]*?(\d+[\d,.]*)/i, /\bpb\b[^0-9]*?(\d+[\d,.]*)/i]],
  ];

  for (const [field, patterns] of ionPatterns) {
    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(val) && val >= 0 && val < 999999) {
          (result as Record<string, unknown>)[field] = val;
          result._parsed_count++;
          break;
        }
      }
    }
  }

  // Physical properties
  const physPatterns: [keyof ParsedReport, RegExp[]][] = [
    ['tds', [/(?:total\s+dissolved\s+solids|tds)[:\s]+(\d+[\d,.]*)/i]],
    ['sample_ph', [/\bph\b[:\s]+(\d+\.?\d*)/i]],
    ['conductivity', [/conductivity[:\s]+(\d+[\d,.]*)/i]],
    ['specific_gravity', [/(?:specific\s+gravity|sp\.?\s*gr)[:\s]+(\d+\.?\d*)/i]],
    ['temperature_f', [/(?:temperature|temp)[:\s]+(\d+\.?\d*)\s*[°]?f/i, /(\d+\.?\d*)\s*°?\s*f\b/i]],
    ['resistivity', [/resistivity[:\s]+(\d+\.?\d*)/i]],
    ['total_alkalinity', [/(?:total\s+)?alkalinity[:\s]+(\d+[\d,.]*)/i]],
    ['total_hardness', [/(?:total\s+)?hardness[:\s]+(\d+[\d,.]*)/i]],
  ];

  for (const [field, patterns] of physPatterns) {
    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(val) && val >= 0) {
          (result as Record<string, unknown>)[field] = val;
          result._parsed_count++;
          break;
        }
      }
    }
  }

  // Metadata
  const dateMatch = text.match(/(?:sample\s*date|date\s*sampled|collected)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (dateMatch) {
    result.sample_date = normalizeDate(dateMatch[1]);
  }

  const reportDateMatch = text.match(/(?:report\s*date|date\s*reported|date\s*analyzed)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (reportDateMatch) {
    result.report_date = normalizeDate(reportDateMatch[1]);
  }

  const labMatch = text.match(/(?:lab\s*(?:name|id|#|no)[:\s]*)([\w\-]+)/i);
  if (labMatch) result.lab_sample_id = labMatch[1];

  if (upper.includes('DOWNHOLE')) result.lab_name = 'DownHole SAT';
  else if (upper.includes('STIM-LAB') || upper.includes('STIMLAB')) result.lab_name = 'Stim-Lab';
  else if (upper.includes('CORE LAB')) result.lab_name = 'Core Laboratories';
  else if (upper.includes('SGS')) result.lab_name = 'SGS';

  // Extract well name / location / sample point from PDF text
  const wellPatterns = [
    /(?:well\s*(?:name|id)?|location|lease|site)[:\s]+([A-Za-z0-9][A-Za-z0-9\s\-#.']+?)(?:\n|\r|$|sample|date|lab|ph|tds|calcium|report)/i,
    /(?:sample\s*(?:point|location|source))[:\s]+([A-Za-z0-9][A-Za-z0-9\s\-#.']+?)(?:\n|\r|$|sample|date|lab)/i,
  ];
  for (const wp of wellPatterns) {
    const wm = text.match(wp);
    if (wm && wm[1].trim().length > 2) {
      const extracted = wm[1].trim().replace(/\s+/g, ' ');
      if (!result.sample_point) result.sample_point = extracted;
      break;
    }
  }

  // Try to extract API number pattern (XX-XXX-XXXXX)
  const apiMatch = text.match(/\b(\d{2}[-\s]?\d{3}[-\s]?\d{5})\b/);
  if (apiMatch) {
    (result as Record<string, unknown>)['_api_number'] = apiMatch[1].replace(/\s/g, '-');
  }

  // Parse scale sweep rows (temperature vs scaling indices)
  const scaleSection = text.match(/(?:scale|scaling)\s+(?:potential|prediction|sweep)([\s\S]{100,3000}?)(?:notes|disclaimer|end|$)/i);
  if (scaleSection) {
    const scaleText = scaleSection[1];
    // Look for rows: temp_f caco3 baso4 srso4 caso4 feco3
    const rowRegex = /(\d{2,3}(?:\.\d)?)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/g;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(scaleText)) !== null) {
      result.scale_rows.push({
        temp_f: parseFloat(rowMatch[1]),
        caco3: parseFloat(rowMatch[2]),
        baso4: parseFloat(rowMatch[3]),
        srso4: parseFloat(rowMatch[4]),
        caso4: parseFloat(rowMatch[5]),
        feco3: parseFloat(rowMatch[6]),
      });
    }
  }

  // If we parsed very few ions, note a warning
  if (result._parsed_count < 5) {
    result._warnings.push(`Only ${result._parsed_count} values parsed from PDF text — some data may require manual review`);
    // Fill TDS estimate if missing
    if (!result.tds && result.chloride && result.sodium) {
      result.tds = Math.round((result.chloride + result.sodium) * 1.8);
      result._warnings.push('TDS estimated from chloride + sodium');
    }
  }

  return result;
}

function normalizeDate(d: string): string {
  const parts = d.split(/[\/\-]/);
  if (parts.length === 3) {
    let year = parts[2];
    if (year.length === 2) year = '20' + year;
    return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  return d;
}

function estimateFromFilename(result: ParsedReport, filename: string): ParsedReport {
  // Extract date from filename if present (e.g., "CWA Antelope Draw 58 E Well 3.15.17.pdf")
  const dateInName = filename.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (dateInName) {
    let y = dateInName[3];
    if (y.length === 2) y = '20' + y;
    result.sample_date = `${y}-${dateInName[1].padStart(2, '0')}-${dateInName[2].padStart(2, '0')}`;
  }
  result._warnings.push('PDF could not be text-extracted — record created for manual data entry');
  return result;
}

// Smart filename parser for DownHole SAT naming convention
// Pattern: [Reports/][TX.XXXX.XXX] [Operator] CWA [WellArea] [Well#] [Designation] [Wellhead|W.H.|Well] [M.DD.YY].pdf
function parseWellInfoFromFilename(rawFilename: string): {
  wellName: string;
  operator: string | null;
  samplePoint: string | null;
  sampleDate: string | null;
  labTrackingNumber: string | null;
} {
  let name = rawFilename;

  // Strip .pdf extension
  name = name.replace(/\.pdf$/i, '');

  // Strip directory prefixes (e.g., "Reports/")
  name = name.replace(/^.*[\/\\]/, '');

  // Extract and strip TX lab tracking number (e.g., TX.0052.497)
  let labTrackingNumber: string | null = null;
  const txMatch = name.match(/^(TX[\.\-]\d{4}[\.\-]\d{2,3})\s*/i);
  if (txMatch) {
    labTrackingNumber = txMatch[1];
    name = name.replace(txMatch[0], '');
  }

  // Extract and strip trailing date (e.g., "3.15.17" or "3.9.17") + optional [1] suffix
  let sampleDate: string | null = null;
  const dateMatch = name.match(/\s+(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\[\d+\])?\s*$/);
  if (dateMatch) {
    let y = dateMatch[3];
    if (y.length === 2) y = '20' + y;
    sampleDate = `${y}-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`;
    name = name.replace(dateMatch[0], '').trim();
  }

  // Extract operator (before "CWA")
  let operator: string | null = null;
  const cwaMatch = name.match(/^(\w[\w\s]*?)\s+CWA\s+/i);
  if (cwaMatch) {
    operator = cwaMatch[1].trim();
    name = name.replace(cwaMatch[0], '').trim();
  }

  // Extract sample point type from end (Wellhead, W.H., Well)
  let samplePoint: string | null = null;
  const spMatch = name.match(/\s+(Wellhead|W\.?\s*H\.?|Well)\s*$/i);
  if (spMatch) {
    samplePoint = spMatch[1].replace(/\.\s*/g, '.').trim();
    if (samplePoint.toLowerCase() === 'w.h.' || samplePoint.toLowerCase() === 'wh') samplePoint = 'Wellhead';
    name = name.replace(spMatch[0], '').trim();
  }

  // Clean up remaining name (this is the actual well identifier)
  name = name.replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim();

  return { wellName: name || rawFilename.replace(/\.pdf$/i, ''), operator, samplePoint, sampleDate, labTrackingNumber };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Ion Balance Calculation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function calculateIonBalance(p: ParsedReport): { pct: number; valid: boolean; cation_meq: number; anion_meq: number } {
  // meq/L conversion: mg/L ÷ equivalent weight
  const cation_meq =
    (p.calcium || 0) / 20.04 +
    (p.magnesium || 0) / 12.15 +
    (p.sodium || 0) / 22.99 +
    (p.potassium || 0) / 39.10 +
    (p.barium || 0) / 68.67 +
    (p.strontium || 0) / 43.81 +
    (p.iron || 0) / 27.92 +
    (p.manganese || 0) / 27.47 +
    (p.lithium || 0) / 6.94;

  const anion_meq =
    (p.chloride || 0) / 35.45 +
    (p.sulfate || 0) / 48.03 +
    (p.bicarbonate || 0) / 61.02 +
    (p.dissolved_co2 || 0) / 30.01 +
    (p.h2s || 0) / 17.04 +
    (p.bromide || 0) / 79.90;

  const sum = cation_meq + anion_meq;
  if (sum === 0) return { pct: 0, valid: true, cation_meq: 0, anion_meq: 0 };

  const pct = Math.abs((cation_meq - anion_meq) / sum * 200);
  return { pct: Math.round(pct * 100) / 100, valid: pct < 5, cation_meq: Math.round(cation_meq * 100) / 100, anion_meq: Math.round(anion_meq * 100) / 100 };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Variance Detection (Step 6 of 7-step insertion)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface VarianceAlert {
  rule_id: string;
  ion_name: string | null;
  severity: string;
  current_value: number | null;
  expected_value: number | null;
  sigma_deviation: number | null;
  message: string;
}

async function runVarianceDetection(
  db: D1Database,
  sampleId: number,
  wellId: number,
  parsed: ParsedReport,
  ionBalance: { pct: number; valid: boolean; cation_meq: number; anion_meq: number }
): Promise<VarianceAlert[]> {
  const alerts: VarianceAlert[] = [];

  // Load well_statistics for sigma deviation checks
  const statsRes = await db.prepare(
    'SELECT ion_name, mean_value, stddev_value FROM well_statistics WHERE well_id = ?'
  ).bind(wellId).all();
  const statsMap = new Map<string, { mean: number; stddev: number }>();
  for (const row of statsRes.results as Array<Record<string, unknown>>) {
    if (row.mean_value != null && row.stddev_value != null) {
      statsMap.set(row.ion_name as string, { mean: row.mean_value as number, stddev: row.stddev_value as number });
    }
  }

  function addAlert(ruleId: string, ionName: string | null, severity: string, currentVal: number | null, expectedVal: number | null, sigmaDeviation: number | null, message: string): void {
    alerts.push({ rule_id: ruleId, ion_name: ionName, severity, current_value: currentVal, expected_value: expectedVal, sigma_deviation: sigmaDeviation, message });
  }

  function checkSigma(ionName: string, value: number | null): number | null {
    if (value == null) return null;
    const st = statsMap.get(ionName);
    if (!st || st.stddev === 0) return null;
    return Math.round(Math.abs(value - st.mean) / st.stddev * 100) / 100;
  }

  // ── 12 Single-Ion Rules ──────────────────────────────────────

  // VAR-001: Barium — critical if >200, warning if >0-500 range exceeded
  if (parsed.barium != null) {
    if (parsed.barium > 200) {
      addAlert('VAR-001', 'barium', 'critical', parsed.barium, 200, checkSigma('barium', parsed.barium), `Barium ${parsed.barium} mg/L exceeds critical threshold of 200 mg/L — severe barite scaling risk`);
    } else if (parsed.barium > 500) {
      addAlert('VAR-001', 'barium', 'critical', parsed.barium, 500, checkSigma('barium', parsed.barium), `Barium ${parsed.barium} mg/L exceeds absolute maximum of 500 mg/L`);
    }
  }

  // VAR-002: Iron — warning if >50, critical if >100
  if (parsed.iron != null) {
    if (parsed.iron > 100) {
      addAlert('VAR-002', 'iron', 'critical', parsed.iron, 100, checkSigma('iron', parsed.iron), `Iron ${parsed.iron} mg/L exceeds critical threshold of 100 mg/L — severe corrosion/fouling risk`);
    } else if (parsed.iron > 50) {
      addAlert('VAR-002', 'iron', 'warning', parsed.iron, 50, checkSigma('iron', parsed.iron), `Iron ${parsed.iron} mg/L exceeds warning threshold of 50 mg/L`);
    }
  }

  // VAR-003: H2S — critical if >100
  if (parsed.h2s != null) {
    if (parsed.h2s > 100) {
      addAlert('VAR-003', 'h2s', 'critical', parsed.h2s, 100, checkSigma('h2s', parsed.h2s), `H2S ${parsed.h2s} mg/L exceeds critical threshold of 100 mg/L — severe corrosion and safety hazard`);
    } else if (parsed.h2s > 500) {
      addAlert('VAR-003', 'h2s', 'critical', parsed.h2s, 500, checkSigma('h2s', parsed.h2s), `H2S ${parsed.h2s} mg/L exceeds absolute maximum of 500 mg/L`);
    }
  }

  // VAR-004: Calcium — warning if <1000 (unusually low for Permian produced water)
  if (parsed.calcium != null) {
    if (parsed.calcium < 500) {
      addAlert('VAR-004', 'calcium', 'warning', parsed.calcium, 500, checkSigma('calcium', parsed.calcium), `Calcium ${parsed.calcium} mg/L is below minimum expected range of 500 mg/L — possible dilution or sample error`);
    } else if (parsed.calcium < 1000) {
      addAlert('VAR-004', 'calcium', 'warning', parsed.calcium, 1000, checkSigma('calcium', parsed.calcium), `Calcium ${parsed.calcium} mg/L is below typical Permian Basin threshold of 1000 mg/L`);
    }
  }

  // VAR-005: Chloride — warning outside 5000-200000 range
  if (parsed.chloride != null) {
    if (parsed.chloride < 5000) {
      addAlert('VAR-005', 'chloride', 'warning', parsed.chloride, 5000, checkSigma('chloride', parsed.chloride), `Chloride ${parsed.chloride} mg/L below typical minimum of 5,000 mg/L`);
    } else if (parsed.chloride > 200000) {
      addAlert('VAR-005', 'chloride', 'warning', parsed.chloride, 200000, checkSigma('chloride', parsed.chloride), `Chloride ${parsed.chloride} mg/L exceeds typical maximum of 200,000 mg/L`);
    }
  }

  // VAR-006: TDS — warning outside 10000-350000 range
  if (parsed.tds != null) {
    if (parsed.tds < 10000) {
      addAlert('VAR-006', 'tds', 'warning', parsed.tds, 10000, checkSigma('tds', parsed.tds), `TDS ${parsed.tds} mg/L below typical minimum of 10,000 mg/L — possible freshwater contamination`);
    } else if (parsed.tds > 350000) {
      addAlert('VAR-006', 'tds', 'warning', parsed.tds, 350000, checkSigma('tds', parsed.tds), `TDS ${parsed.tds} mg/L exceeds typical maximum of 350,000 mg/L`);
    }
  }

  // VAR-007: pH — critical outside 4.0-9.0 range
  if (parsed.sample_ph != null) {
    if (parsed.sample_ph < 4.0) {
      addAlert('VAR-007', 'sample_ph', 'critical', parsed.sample_ph, 4.0, checkSigma('sample_ph', parsed.sample_ph), `pH ${parsed.sample_ph} below critical minimum of 4.0 — severe corrosion risk`);
    } else if (parsed.sample_ph > 9.0) {
      addAlert('VAR-007', 'sample_ph', 'critical', parsed.sample_ph, 9.0, checkSigma('sample_ph', parsed.sample_ph), `pH ${parsed.sample_ph} exceeds critical maximum of 9.0 — scale precipitation risk`);
    }
  }

  // VAR-008: Sulfate — warning if >2000
  if (parsed.sulfate != null) {
    if (parsed.sulfate > 5000) {
      addAlert('VAR-008', 'sulfate', 'warning', parsed.sulfate, 5000, checkSigma('sulfate', parsed.sulfate), `Sulfate ${parsed.sulfate} mg/L exceeds maximum of 5,000 mg/L`);
    } else if (parsed.sulfate > 2000) {
      addAlert('VAR-008', 'sulfate', 'warning', parsed.sulfate, 2000, checkSigma('sulfate', parsed.sulfate), `Sulfate ${parsed.sulfate} mg/L exceeds warning threshold of 2,000 mg/L — scale risk with barium/calcium`);
    }
  }

  // VAR-009: Manganese — warning if >20
  if (parsed.manganese != null) {
    if (parsed.manganese > 50) {
      addAlert('VAR-009', 'manganese', 'warning', parsed.manganese, 50, checkSigma('manganese', parsed.manganese), `Manganese ${parsed.manganese} mg/L exceeds maximum of 50 mg/L`);
    } else if (parsed.manganese > 20) {
      addAlert('VAR-009', 'manganese', 'warning', parsed.manganese, 20, checkSigma('manganese', parsed.manganese), `Manganese ${parsed.manganese} mg/L exceeds warning threshold of 20 mg/L`);
    }
  }

  // VAR-010: Strontium — info only if >5000
  if (parsed.strontium != null && parsed.strontium > 5000) {
    addAlert('VAR-010', 'strontium', 'info', parsed.strontium, 5000, checkSigma('strontium', parsed.strontium), `Strontium ${parsed.strontium} mg/L exceeds typical maximum of 5,000 mg/L — celestite scale consideration`);
  }

  // VAR-011: Sodium — warning outside 5000-100000 range
  if (parsed.sodium != null) {
    if (parsed.sodium < 5000) {
      addAlert('VAR-011', 'sodium', 'warning', parsed.sodium, 5000, checkSigma('sodium', parsed.sodium), `Sodium ${parsed.sodium} mg/L below typical minimum of 5,000 mg/L`);
    } else if (parsed.sodium > 100000) {
      addAlert('VAR-011', 'sodium', 'warning', parsed.sodium, 100000, checkSigma('sodium', parsed.sodium), `Sodium ${parsed.sodium} mg/L exceeds typical maximum of 100,000 mg/L`);
    }
  }

  // VAR-012: Magnesium — warning outside 100-5000 range
  if (parsed.magnesium != null) {
    if (parsed.magnesium < 100) {
      addAlert('VAR-012', 'magnesium', 'warning', parsed.magnesium, 100, checkSigma('magnesium', parsed.magnesium), `Magnesium ${parsed.magnesium} mg/L below typical minimum of 100 mg/L`);
    } else if (parsed.magnesium > 5000) {
      addAlert('VAR-012', 'magnesium', 'warning', parsed.magnesium, 5000, checkSigma('magnesium', parsed.magnesium), `Magnesium ${parsed.magnesium} mg/L exceeds typical maximum of 5,000 mg/L`);
    }
  }

  // ── 5 Composite Rules ──────────────────────────────────────

  // COMP-001: BaSO4 Risk — barium >50 AND sulfate >100 → critical (barite scale)
  if ((parsed.barium || 0) > 50 && (parsed.sulfate || 0) > 100) {
    addAlert('COMP-001', null, 'critical', parsed.barium, null, null,
      `Barite (BaSO4) scale risk: Barium ${parsed.barium} mg/L + Sulfate ${parsed.sulfate} mg/L — both exceed co-precipitation threshold`);
  }

  // COMP-002: CaCO3 Risk — calcium >5000 AND bicarbonate >500 → warning (calcite scale)
  if ((parsed.calcium || 0) > 5000 && (parsed.bicarbonate || 0) > 500) {
    addAlert('COMP-002', null, 'warning', parsed.calcium, null, null,
      `Calcite (CaCO3) scale risk: Calcium ${parsed.calcium} mg/L + Bicarbonate ${parsed.bicarbonate} mg/L — both exceed co-precipitation threshold`);
  }

  // COMP-003: Ion Balance — >5% warning, >10% critical
  if (ionBalance.pct > 10) {
    addAlert('COMP-003', null, 'critical', ionBalance.pct, 10, null,
      `Ion balance ${ionBalance.pct.toFixed(2)}% exceeds critical threshold of 10% — likely measurement error or missing ions`);
  } else if (ionBalance.pct > 5) {
    addAlert('COMP-003', null, 'warning', ionBalance.pct, 5, null,
      `Ion balance ${ionBalance.pct.toFixed(2)}% exceeds warning threshold of 5% — data quality review recommended`);
  }

  // COMP-004: TDS vs Conductivity — ratio outside 0.55-0.75 → warning
  if (parsed.tds != null && parsed.conductivity != null && parsed.conductivity > 0) {
    const ratio = parsed.tds / parsed.conductivity;
    if (ratio < 0.55 || ratio > 0.75) {
      addAlert('COMP-004', null, 'warning', Math.round(ratio * 1000) / 1000, null, null,
        `TDS/Conductivity ratio ${ratio.toFixed(3)} outside expected range 0.55-0.75 — possible measurement inconsistency (TDS=${parsed.tds}, Cond=${parsed.conductivity})`);
    }
  }

  // COMP-005: SpGr vs TDS — SpGr < 1.0 + (TDS * 0.7e-6) → warning (measurement error)
  if (parsed.specific_gravity != null && parsed.tds != null) {
    const expectedMinSg = 1.0 + (parsed.tds * 0.7e-6);
    if (parsed.specific_gravity < expectedMinSg) {
      addAlert('COMP-005', null, 'warning', parsed.specific_gravity, Math.round(expectedMinSg * 10000) / 10000, null,
        `Specific gravity ${parsed.specific_gravity} is below expected minimum ${expectedMinSg.toFixed(4)} for TDS ${parsed.tds} mg/L — possible measurement error`);
    }
  }

  // ── Persist alerts to D1 ──────────────────────────────────────

  if (alerts.length > 0) {
    const batch: D1PreparedStatement[] = [];
    for (const a of alerts) {
      batch.push(
        db.prepare(`
          INSERT INTO variance_alerts (sample_id, well_id, rule_id, ion_name, severity,
            current_value, expected_value, sigma_deviation, message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          sampleId, wellId, a.rule_id, a.ion_name, a.severity,
          a.current_value, a.expected_value, a.sigma_deviation, a.message
        )
      );
    }
    await db.batch(batch);
  }

  log('info', 'variance_detection_complete', { sampleId, wellId, alertCount: alerts.length, rules: alerts.map(a => a.rule_id) });
  return alerts;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Well Statistics Update (Step 7 of 7-step insertion)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function updateWellStatistics(db: D1Database, wellId: number): Promise<void> {
  // Recalculate rolling statistics for all tracked ions for this well
  const trackedIons = [
    'calcium', 'magnesium', 'barium', 'strontium', 'sodium', 'potassium',
    'iron', 'manganese', 'lithium', 'chloride', 'sulfate', 'bicarbonate',
    'h2s', 'bromide', 'tds', 'sample_ph', 'conductivity', 'specific_gravity',
  ];

  const batch: D1PreparedStatement[] = [];

  for (const ion of trackedIons) {
    // Validate column name against whitelist to prevent SQL injection
    if (!VALID_ION_COLUMNS.has(ion)) continue;

    // Compute aggregate stats from all samples for this well
    const stats = await db.prepare(`
      SELECT
        COUNT(*) AS sample_count,
        AVG(ir.${ion}) AS mean_value,
        MIN(ir.${ion}) AS min_value,
        MAX(ir.${ion}) AS max_value
      FROM samples s
      JOIN ion_readings ir ON ir.sample_id = s.id
      WHERE s.well_id = ? AND ir.${ion} IS NOT NULL
    `).bind(wellId).first<{ sample_count: number; mean_value: number | null; min_value: number | null; max_value: number | null }>();

    if (!stats || stats.sample_count === 0 || stats.mean_value == null) continue;

    // Compute stddev manually (D1 SQLite does not have STDDEV aggregate)
    let stddev = 0;
    if (stats.sample_count > 1) {
      const varianceRes = await db.prepare(`
        SELECT AVG((ir.${ion} - ?1) * (ir.${ion} - ?1)) AS variance
        FROM samples s
        JOIN ion_readings ir ON ir.sample_id = s.id
        WHERE s.well_id = ?2 AND ir.${ion} IS NOT NULL
      `).bind(stats.mean_value, wellId).first<{ variance: number | null }>();
      if (varianceRes?.variance != null) {
        stddev = Math.sqrt(varianceRes.variance);
      }
    }

    // Determine trend from last 5 samples
    const trendRes = await db.prepare(`
      SELECT ir.${ion} AS value
      FROM samples s
      JOIN ion_readings ir ON ir.sample_id = s.id
      WHERE s.well_id = ? AND ir.${ion} IS NOT NULL
      ORDER BY s.sample_date DESC
      LIMIT 5
    `).bind(wellId).all();

    let trend = 'stable';
    const trendVals = (trendRes.results as Array<Record<string, number>>).map(r => r.value).filter(v => v != null);
    if (trendVals.length >= 3) {
      // Compare first half average vs second half average (most recent first)
      const mid = Math.floor(trendVals.length / 2);
      const recentAvg = trendVals.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const olderAvg = trendVals.slice(mid).reduce((a, b) => a + b, 0) / (trendVals.length - mid);
      if (olderAvg > 0) {
        const pctChange = (recentAvg - olderAvg) / olderAvg;
        if (pctChange > 0.10) trend = 'increasing';
        else if (pctChange < -0.10) trend = 'decreasing';
      }
    }

    // Upsert into well_statistics
    batch.push(
      db.prepare(`
        INSERT INTO well_statistics (well_id, ion_name, sample_count, mean_value, stddev_value, min_value, max_value, trend, last_calculated)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
        ON CONFLICT(well_id, ion_name) DO UPDATE SET
          sample_count = ?3,
          mean_value = ?4,
          stddev_value = ?5,
          min_value = ?6,
          max_value = ?7,
          trend = ?8,
          last_calculated = datetime('now')
      `).bind(
        wellId, ion, stats.sample_count,
        Math.round(stats.mean_value * 100) / 100,
        Math.round(stddev * 100) / 100,
        stats.min_value,
        stats.max_value,
        trend
      )
    );
  }

  if (batch.length > 0) {
    await db.batch(batch);
  }

  log('info', 'well_statistics_updated', { wellId, ionsUpdated: batch.length });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Invoices
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/invoices', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '50'), 200);
  const status = c.req.query('status');
  const offset = (page - 1) * perPage;

  let where = '';
  const params: unknown[] = [];
  if (status) {
    where = 'WHERE i.status = ?';
    params.push(status);
  }

  const sql = `SELECT i.*, o.company_name as operator_name, w.well_name
    FROM invoices i LEFT JOIN operators o ON i.operator_id = o.id LEFT JOIN wells w ON i.well_id = w.id
    ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`;
  params.push(perPage, offset);

  const countSql = `SELECT COUNT(*) as total FROM invoices i ${where}`;
  const [dataRes, countRes] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all(),
    c.env.DB.prepare(countSql).bind(...(status ? [status] : [])).first<{ total: number }>(),
  ]);

  return c.json({ items: dataRes.results, total: countRes?.total || 0, page, per_page: perPage });
});

app.get('/api/v1/invoices/stats/summary', async (c) => {
  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total_invoices,
      COUNT(CASE WHEN status = 'draft' THEN 1 END) as draft,
      COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
      COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid,
      COUNT(CASE WHEN status = 'overdue' THEN 1 END) as overdue,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents END), 0) as total_revenue,
      COALESCE(SUM(CASE WHEN status IN ('sent', 'overdue') THEN total_cents END), 0) as outstanding
    FROM invoices
  `).first();
  return c.json({
    ...stats,
    total_revenue: ((stats as Record<string, number>)?.total_revenue || 0) / 100,
    outstanding: ((stats as Record<string, number>)?.outstanding || 0) / 100,
  });
});

app.post('/api/v1/invoices', async (c) => {
  const body = await c.req.json();
  const { customer_name, customer_id, customer_email, service_type, due_date, notes, line_items } = body;

  if (!customer_name) return c.json({ error: 'customer_name is required' }, 400);

  // Calculate amounts
  let subtotal = 0;
  if (line_items && Array.isArray(line_items)) {
    for (const item of line_items) {
      subtotal += (item.unit_price || 0) * (item.quantity || 1);
    }
  }
  const taxRate = 0.0825;
  const amountCents = Math.round(subtotal * 100);
  const taxCents = Math.round(subtotal * taxRate * 100);
  const totalCents = amountCents + taxCents;

  // Generate invoice number with MAX()-based sequential + retry loop
  const now = new Date();
  const prefix = `BGAT-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  let invoiceNumber = '';
  let id = '';
  let inserted = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRow = await c.env.DB.prepare(
      `SELECT MAX(CAST(substr(invoice_number, -4) AS INTEGER)) as max_seq FROM invoices WHERE invoice_number LIKE ?1`
    ).bind(`${prefix}-%`).first<{ max_seq: number | null }>();
    const seq = ((maxRow?.max_seq ?? 0) + 1).toString().padStart(4, '0');
    invoiceNumber = `${prefix}-${seq}`;
    id = uuid();
    try {
      await c.env.DB.prepare(`
        INSERT INTO invoices (id, invoice_number, customer_id, customer_name, customer_email,
          service_type, amount_cents, tax_cents, total_cents, status, due_date, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
      `).bind(
        id, invoiceNumber, customer_id || null, customer_name, customer_email || null,
        service_type || null, amountCents, taxCents, totalCents,
        due_date || null, notes || null, now.toISOString(), now.toISOString()
      ).run();
      inserted = true;
      break;
    } catch (e: unknown) {
      if (attempt === 4 || !(e instanceof Error) || !e.message.includes('UNIQUE')) throw e;
    }
  }
  if (!inserted) throw new Error('Failed to generate unique invoice number');

  // Insert line items
  if (line_items && Array.isArray(line_items)) {
    const batch: D1PreparedStatement[] = [];
    for (const item of line_items) {
      batch.push(
        c.env.DB.prepare(`
          INSERT INTO invoice_line_items (id, invoice_id, well_id, description, quantity, unit_price_cents, total_cents, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          uuid(), id, item.well_id || null, item.description || service_type,
          item.quantity || 1, Math.round((item.unit_price || 0) * 100),
          Math.round((item.unit_price || 0) * (item.quantity || 1) * 100),
          now.toISOString()
        )
      );
    }
    if (batch.length > 0) await c.env.DB.batch(batch);
  }

  return c.json({ id, invoice_number: invoiceNumber, total_cents: totalCents, status: 'draft' }, 201);
});

app.patch('/api/v1/invoices/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, paid_date, notes } = body;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (status) { updates.push('status = ?'); params.push(status); }
  if (paid_date) { updates.push('paid_date = ?'); params.push(paid_date); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  updates.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  await c.env.DB.prepare(`UPDATE invoices SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
  return c.json({ ok: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Customers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/customers', async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '50'), 200);
  const status = c.req.query('status');
  const offset = (page - 1) * perPage;

  let where = '';
  const params: unknown[] = [];
  if (status) { where = 'WHERE status = ?'; params.push(status); }

  const sql = `SELECT * FROM customers ${where} ORDER BY company_name LIMIT ? OFFSET ?`;
  params.push(perPage, offset);

  const dataRes = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ items: dataRes.results, total: dataRes.results.length, page, per_page: perPage });
});

app.post('/api/v1/customers', async (c) => {
  const body = await c.req.json();
  const id = uuid();
  await c.env.DB.prepare(`
    INSERT INTO customers (id, company_name, contact_name, email, phone, address, city, state, zip, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).bind(
    id, body.company_name, body.contact_name || null, body.email || null,
    body.phone || null, body.address || null, body.city || null,
    body.state || null, body.zip || null, new Date().toISOString()
  ).run();
  return c.json({ id, company_name: body.company_name }, 201);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Alerts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/alerts', async (c) => {
  const db = c.env.WATER_DB;
  const wellId = c.req.query('well_id');
  const severity = c.req.query('severity');
  const acknowledged = c.req.query('acknowledged');
  const perPage = Math.min(parseInt(c.req.query('per_page') || '50'), 200);
  const page = parseInt(c.req.query('page') || '1');
  const offset = (page - 1) * perPage;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (wellId) { conditions.push('va.well_id = ?'); params.push(wellId); }
  if (severity) { conditions.push('va.severity = ?'); params.push(severity); }
  if (acknowledged !== undefined && acknowledged !== '') {
    conditions.push('va.acknowledged = ?');
    params.push(acknowledged === '1' || acknowledged === 'true' ? 1 : 0);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countRes = await db.prepare(`SELECT COUNT(*) AS cnt FROM variance_alerts va ${where}`).bind(...params).first();
  const total = (countRes as Record<string, unknown>)?.cnt ?? 0;

  const dataParams = [...params, perPage, offset];
  const dataRes = await db.prepare(`
    SELECT
      va.id, va.sample_id, va.well_id, va.rule_id, va.ion_name,
      va.severity, va.current_value, va.expected_value, va.sigma_deviation,
      va.message, va.acknowledged, va.acknowledged_by, va.acknowledged_at,
      va.created_at,
      w.well_name,
      s.sample_date
    FROM variance_alerts va
    LEFT JOIN wells w ON w.id = va.well_id
    LEFT JOIN samples s ON s.id = va.sample_id
    ${where}
    ORDER BY va.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...dataParams).all();

  return c.json({ items: dataRes.results, total, page, per_page: perPage });
});

// PATCH /api/v1/alerts/:id/acknowledge — WATER_DB
app.patch('/api/v1/alerts/:id/acknowledge', async (c) => {
  const db = c.env.WATER_DB;
  const alertId = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const acknowledgedBy = (body.acknowledged_by as string) || 'system';

  await db.prepare(`
    UPDATE variance_alerts
    SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime('now')
    WHERE id = ?
  `).bind(acknowledgedBy, alertId).run();

  return c.json({ ok: true, id: alertId, acknowledged: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Estimates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/estimates', async (c) => {
  const perPage = Math.min(parseInt(c.req.query('per_page') || '50'), 200);
  const page = parseInt(c.req.query('page') || '1');
  const offset = (page - 1) * perPage;

  const dataRes = await c.env.DB.prepare(
    'SELECT * FROM estimates ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(perPage, offset).all();
  return c.json({ items: dataRes.results, total: dataRes.results.length, page, per_page: perPage });
});

app.post('/api/v1/estimates', async (c) => {
  const body = await c.req.json();
  const id = uuid();
  const now = new Date();
  const number = `EST-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;

  await c.env.DB.prepare(`
    INSERT INTO estimates (id, estimate_number, customer_name, customer_email, well_id, service_type,
      amount_cents, tax_cents, total_cents, status, valid_until, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `).bind(
    id, number, body.customer_name, body.customer_email || null, body.well_id || null,
    body.service_type || null, body.amount_cents || 0, body.tax_cents || 0,
    body.total_cents || 0, body.valid_until || null, body.notes || null,
    now.toISOString(), now.toISOString()
  ).run();
  return c.json({ id, estimate_number: number }, 201);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Expenses
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/expenses', async (c) => {
  const perPage = Math.min(parseInt(c.req.query('per_page') || '50'), 200);
  const page = parseInt(c.req.query('page') || '1');
  const offset = (page - 1) * perPage;

  const dataRes = await c.env.DB.prepare(
    'SELECT * FROM expenses ORDER BY expense_date DESC LIMIT ? OFFSET ?'
  ).bind(perPage, offset).all();
  return c.json({ items: dataRes.results, total: dataRes.results.length, page, per_page: perPage });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QuickBooks Integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

app.get('/api/v1/quickbooks/status', async (c) => {
  const token = await c.env.CACHE.get('qb:access_token');
  const realmId = await c.env.CACHE.get('qb:realm_id');
  const connected = !!(token && realmId);

  return c.json({
    connected,
    realm_id: realmId || null,
    environment: c.env.QB_ENVIRONMENT || 'sandbox',
    features: ['invoice_sync', 'customer_sync', 'payment_tracking'],
  });
});

app.get('/api/v1/quickbooks/auth', async (c) => {
  const clientId = c.env.QB_CLIENT_ID;
  if (!clientId) return c.json({ error: 'QuickBooks not configured — set QB_CLIENT_ID secret' }, 503);

  const state = uuid();
  await c.env.CACHE.put('qb:oauth_state', state, { expirationTtl: 600 });

  const redirectUri = c.env.QB_REDIRECT_URI || 'https://bgat-api-gateway.bmcii1976.workers.dev/api/v1/quickbooks/callback';
  const scopes = 'com.intuit.quickbooks.accounting';

  const url = `${QB_AUTH_URL}?client_id=${clientId}&response_type=code&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return c.json({ auth_url: url, state });
});

app.get('/api/v1/quickbooks/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const realmId = c.req.query('realmId');

  if (!code || !realmId) return c.json({ error: 'Missing code or realmId' }, 400);

  const storedState = await c.env.CACHE.get('qb:oauth_state');
  if (state !== storedState) return c.json({ error: 'Invalid OAuth state' }, 403);

  const clientId = c.env.QB_CLIENT_ID;
  const clientSecret = c.env.QB_CLIENT_SECRET;
  const redirectUri = c.env.QB_REDIRECT_URI || 'https://bgat-api-gateway.bmcii1976.workers.dev/api/v1/quickbooks/callback';

  const tokenResp = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    log('error', 'qb_token_exchange_failed', { status: tokenResp.status, body: err });
    return c.json({ error: 'Token exchange failed' }, 500);
  }

  const tokens = await tokenResp.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
  };

  await c.env.CACHE.put('qb:access_token', tokens.access_token, { expirationTtl: tokens.expires_in - 60 });
  await c.env.CACHE.put('qb:refresh_token', tokens.refresh_token, { expirationTtl: tokens.x_refresh_token_expires_in - 60 });
  await c.env.CACHE.put('qb:realm_id', realmId);

  log('info', 'qb_connected', { realmId });

  // Redirect back to billing page
  return c.redirect('https://www.blackgoldasset.com/billing.html?qb=connected');
});

app.post('/api/v1/quickbooks/sync-invoice', async (c) => {
  const body = await c.req.json();
  const { invoice_id } = body;
  if (!invoice_id) return c.json({ error: 'invoice_id required' }, 400);

  const accessToken = await c.env.CACHE.get('qb:access_token');
  const realmId = await c.env.CACHE.get('qb:realm_id');

  if (!accessToken || !realmId) {
    return c.json({ error: 'QuickBooks not connected', connected: false }, 401);
  }

  // Get invoice from D1
  const invoice = await c.env.DB.prepare(
    'SELECT * FROM invoices WHERE id = ?'
  ).bind(invoice_id).first();

  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);

  const inv = invoice as Record<string, unknown>;

  // Get line items
  const lineItems = await c.env.DB.prepare(
    'SELECT * FROM invoice_line_items WHERE invoice_id = ?'
  ).bind(invoice_id).all();

  // Build QuickBooks invoice
  const baseUrl = (c.env.QB_ENVIRONMENT || 'sandbox') === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  const qbInvoice = {
    Line: lineItems.results.map((li: Record<string, unknown>) => ({
      Amount: ((li.total_cents as number) || 0) / 100,
      DetailType: 'SalesItemLineDetail',
      Description: li.description,
      SalesItemLineDetail: {
        Qty: li.quantity || 1,
        UnitPrice: ((li.unit_price_cents as number) || 0) / 100,
      },
    })),
    CustomerRef: { value: '1', name: inv.customer_name },
    BillEmail: inv.customer_email ? { Address: inv.customer_email } : undefined,
    DueDate: inv.due_date || undefined,
    PrivateNote: inv.notes || undefined,
    DocNumber: inv.invoice_number,
    TxnTaxDetail: {
      TotalTax: ((inv.tax_cents as number) || 0) / 100,
    },
  };

  const syncResp = await fetch(`${baseUrl}/v3/company/${realmId}/invoice`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(qbInvoice),
  });

  if (!syncResp.ok) {
    const errBody = await syncResp.text();
    log('error', 'qb_sync_failed', { invoiceId: invoice_id, status: syncResp.status, body: errBody });
    await c.env.DB.prepare(
      "UPDATE invoices SET qb_sync_status = 'error', qb_sync_error = ? WHERE id = ?"
    ).bind(errBody.slice(0, 500), invoice_id).run();
    return c.json({ error: 'QuickBooks sync failed', details: errBody }, 502);
  }

  const qbResult = await syncResp.json() as { Invoice?: { Id?: string } };
  const qbInvoiceId = qbResult.Invoice?.Id;

  await c.env.DB.prepare(
    "UPDATE invoices SET qb_invoice_id = ?, qb_sync_status = 'synced', qb_sync_error = NULL, updated_at = ? WHERE id = ?"
  ).bind(qbInvoiceId || null, new Date().toISOString(), invoice_id).run();

  log('info', 'qb_invoice_synced', { invoiceId: invoice_id, qbInvoiceId });
  return c.json({ ok: true, qb_invoice_id: qbInvoiceId });
});

app.post('/api/v1/quickbooks/disconnect', async (c) => {
  await c.env.CACHE.delete('qb:access_token');
  await c.env.CACHE.delete('qb:refresh_token');
  await c.env.CACHE.delete('qb:realm_id');
  return c.json({ ok: true, connected: false });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Formation Query — WATER_DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/query/formation/:name', async (c) => {
  const db = c.env.WATER_DB;
  const formation = c.req.param('name');

  // KV cache with 1-hour TTL (invalidated by upload route)
  const cacheKey = `formation_avg:${formation}`;
  const cached = await c.env.CACHE.get(cacheKey, 'json');
  if (cached) {
    return c.json(cached as Record<string, unknown>);
  }

  const row = await db.prepare(`
    SELECT
      w.target_formation AS formation,
      COUNT(DISTINCT s.id) AS sample_count,
      AVG(ir.tds) AS avg_tds,
      AVG(ir.chloride) AS avg_chloride,
      AVG(ir.calcium) AS avg_calcium,
      AVG(ir.magnesium) AS avg_magnesium,
      AVG(ir.sodium) AS avg_sodium,
      AVG(ir.barium) AS avg_barium,
      AVG(ir.strontium) AS avg_strontium,
      AVG(ir.iron) AS avg_iron,
      AVG(ir.manganese) AS avg_manganese,
      AVG(ir.sulfate) AS avg_sulfate,
      AVG(ir.bicarbonate) AS avg_bicarbonate,
      AVG(ir.h2s) AS avg_h2s,
      AVG(ir.sample_ph) AS avg_sample_ph,
      AVG(ir.specific_gravity) AS avg_specific_gravity
    FROM wells w
    JOIN samples s ON s.well_id = w.id
    JOIN ion_readings ir ON ir.sample_id = s.id
    WHERE w.target_formation = ?
    GROUP BY w.target_formation
  `).bind(formation).first();

  if (!row) {
    return c.json({ formation, sample_count: 0, averages: null });
  }

  const r = row as Record<string, unknown>;
  const result = {
    formation,
    sample_count: r.sample_count,
    averages: {
      tds: r.avg_tds,
      chloride: r.avg_chloride,
      calcium: r.avg_calcium,
      magnesium: r.avg_magnesium,
      sodium: r.avg_sodium,
      barium: r.avg_barium,
      strontium: r.avg_strontium,
      iron: r.avg_iron,
      manganese: r.avg_manganese,
      sulfate: r.avg_sulfate,
      bicarbonate: r.avg_bicarbonate,
      h2s: r.avg_h2s,
      sample_ph: r.avg_sample_ph,
      specific_gravity: r.avg_specific_gravity,
    },
  };

  // Store in KV cache for 1 hour
  await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

  return c.json(result);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Map: Radius Search — WATER_DB (Haversine approximation)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/map/radius', async (c) => {
  const db = c.env.WATER_DB;
  const lat = parseFloat(c.req.query('lat') || '');
  const lng = parseFloat(c.req.query('lng') || '');
  const radiusMiles = parseFloat(c.req.query('radius_miles') || '10');

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: 'lat and lng query parameters are required' }, 400);
  }

  // Haversine approximation using flat-earth correction for SQLite
  // Subquery for bounding-box pre-filter, outer WHERE for exact distance filter
  const dataRes = await db.prepare(`
    SELECT * FROM (
      SELECT
        w.id, w.well_name, w.latitude, w.longitude,
        o.operator_name,
        w.target_formation AS formation,
        (SELECT ir.tds FROM samples s2 JOIN ion_readings ir ON ir.sample_id = s2.id WHERE s2.well_id = w.id ORDER BY s2.sample_date DESC LIMIT 1) AS latest_tds,
        SQRT(
          (69.0 * (w.latitude - ?1)) * (69.0 * (w.latitude - ?1)) +
          (69.0 * COS(?1 * 3.14159265 / 180.0) * (w.longitude - ?2)) * (69.0 * COS(?1 * 3.14159265 / 180.0) * (w.longitude - ?2))
        ) AS distance_miles
      FROM wells w
      LEFT JOIN operators o ON o.id = w.operator_id
      WHERE w.latitude IS NOT NULL AND w.longitude IS NOT NULL
        AND w.latitude BETWEEN ?1 - (?3 / 69.0) AND ?1 + (?3 / 69.0)
        AND w.longitude BETWEEN ?2 - (?3 / (69.0 * COS(?1 * 3.14159265 / 180.0))) AND ?2 + (?3 / (69.0 * COS(?1 * 3.14159265 / 180.0)))
    ) sub
    WHERE distance_miles < ?3
    ORDER BY distance_miles ASC
  `).bind(lat, lng, radiusMiles).all();

  return c.json({ items: dataRes.results });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Map: All Wells — WATER_DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/map/wells', async (c) => {
  const db = c.env.WATER_DB;

  const dataRes = await db.prepare(`
    SELECT
      w.id, w.well_name, w.latitude, w.longitude,
      o.operator_name,
      w.target_formation AS formation,
      (SELECT ir.tds FROM samples s2 JOIN ion_readings ir ON ir.sample_id = s2.id WHERE s2.well_id = w.id ORDER BY s2.sample_date DESC LIMIT 1) AS latest_tds,
      (SELECT COUNT(*) FROM variance_alerts va WHERE va.well_id = w.id AND va.acknowledged = 0) AS alert_count
    FROM wells w
    LEFT JOIN operators o ON o.id = w.operator_id
    WHERE w.latitude IS NOT NULL AND w.longitude IS NOT NULL
    ORDER BY w.well_name ASC
  `).all();

  return c.json({ items: dataRes.results });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Map: Heatmap — WATER_DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/map/heatmap/:ion', async (c) => {
  const db = c.env.WATER_DB;
  const ion = c.req.param('ion');

  if (!VALID_ION_COLUMNS.has(ion)) {
    return c.json({ error: `Invalid ion column: ${ion}. Valid: ${Array.from(VALID_ION_COLUMNS).join(', ')}` }, 400);
  }

  // Get latest ion reading per well with coordinates
  const dataRes = await db.prepare(`
    SELECT
      w.latitude AS lat,
      w.longitude AS lon,
      ir.${ion} AS value
    FROM wells w
    JOIN samples s ON s.well_id = w.id
    JOIN ion_readings ir ON ir.sample_id = s.id
    WHERE w.latitude IS NOT NULL AND w.longitude IS NOT NULL
      AND ir.${ion} IS NOT NULL
      AND s.id = (SELECT s2.id FROM samples s2 WHERE s2.well_id = w.id ORDER BY s2.sample_date DESC LIMIT 1)
    ORDER BY w.id
  `).all();

  return c.json({ points: dataRes.results });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Analytics Overview — WATER_DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/analytics/overview', async (c) => {
  const db = c.env.WATER_DB;
  const months = parseInt(c.req.query('months') || '12');
  const clampedMonths = Math.min(Math.max(months, 1), 60);

  // 1. Monthly sample counts for the chart
  const monthlySamplesRes = await db.prepare(`
    SELECT
      strftime('%Y-%m', sample_date) AS month,
      COUNT(*) AS sample_count,
      COUNT(DISTINCT well_id) AS well_count
    FROM samples
    WHERE sample_date >= date('now', '-' || ? || ' months')
    GROUP BY strftime('%Y-%m', sample_date)
    ORDER BY month ASC
  `).bind(clampedMonths).all();

  // 2. Top formations by sample count
  const topFormationsRes = await db.prepare(`
    SELECT
      w.target_formation AS formation,
      COUNT(*) AS sample_count,
      COUNT(DISTINCT w.id) AS well_count,
      AVG(ir.tds) AS avg_tds
    FROM wells w
    JOIN samples s ON s.well_id = w.id
    JOIN ion_readings ir ON ir.sample_id = s.id
    WHERE w.target_formation IS NOT NULL
    GROUP BY w.target_formation
    ORDER BY sample_count DESC
    LIMIT 10
  `).all();

  // 3. Ion trends — average per month for key ions (TDS, Cl, Ba, Ca, Na)
  const ionTrendsRes = await db.prepare(`
    SELECT
      strftime('%Y-%m', s.sample_date) AS month,
      AVG(ir.tds) AS avg_tds,
      AVG(ir.chloride) AS avg_chloride,
      AVG(ir.barium) AS avg_barium,
      AVG(ir.calcium) AS avg_calcium,
      AVG(ir.sodium) AS avg_sodium
    FROM samples s
    JOIN ion_readings ir ON ir.sample_id = s.id
    WHERE s.sample_date >= date('now', '-' || ? || ' months')
    GROUP BY strftime('%Y-%m', s.sample_date)
    ORDER BY month ASC
  `).bind(clampedMonths).all();

  // 4. Alert severity distribution
  const alertDistRes = await db.prepare(`
    SELECT
      severity,
      COUNT(*) AS cnt,
      SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END) AS unacknowledged
    FROM variance_alerts
    GROUP BY severity
  `).all();

  // 5. Top alerting wells
  const topAlertingRes = await db.prepare(`
    SELECT
      w.well_name,
      va.well_id,
      COUNT(*) AS alert_count,
      SUM(CASE WHEN va.acknowledged = 0 THEN 1 ELSE 0 END) AS active_alerts
    FROM variance_alerts va
    JOIN wells w ON w.id = va.well_id
    GROUP BY va.well_id
    ORDER BY alert_count DESC
    LIMIT 10
  `).all();

  return c.json({
    monthly_samples: monthlySamplesRes.results,
    top_formations: topFormationsRes.results,
    ion_trends: ionTrendsRes.results,
    alert_distribution: alertDistRes.results,
    top_alerting_wells: topAlertingRes.results,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Dashboard Stats — WATER_DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/v1/dashboard/stats', async (c) => {
  const db = c.env.WATER_DB;

  const [wellsRes, samplesRes, alertsRes, avgTdsRes, recentWellsRes, recentSamplesRes] = await db.batch([
    db.prepare('SELECT COUNT(*) AS cnt FROM wells'),
    db.prepare('SELECT COUNT(*) AS cnt FROM samples'),
    db.prepare('SELECT COUNT(*) AS cnt FROM variance_alerts WHERE acknowledged = 0'),
    db.prepare('SELECT AVG(ir.tds) AS avg_tds FROM ion_readings ir WHERE ir.tds IS NOT NULL'),
    db.prepare("SELECT COUNT(*) AS cnt FROM wells WHERE created_at >= date('now', '-30 days')"),
    db.prepare("SELECT COUNT(*) AS cnt FROM samples WHERE sample_date >= date('now', '-30 days')"),
  ]);

  const total_wells = (wellsRes.results[0] as Record<string, unknown>)?.cnt ?? 0;
  const total_samples = (samplesRes.results[0] as Record<string, unknown>)?.cnt ?? 0;
  const active_alerts = (alertsRes.results[0] as Record<string, unknown>)?.cnt ?? 0;
  const avg_tds = (avgTdsRes.results[0] as Record<string, unknown>)?.avg_tds ?? null;
  const wells_this_month = (recentWellsRes.results[0] as Record<string, unknown>)?.cnt ?? 0;
  const samples_this_month = (recentSamplesRes.results[0] as Record<string, unknown>)?.cnt ?? 0;

  return c.json({
    total_wells,
    total_samples,
    active_alerts,
    avg_tds,
    wells_this_month,
    samples_this_month,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Error handler
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.onError((err, c) => {
  log('error', 'unhandled_error', { error: err.message, stack: err.stack, path: c.req.path });
  return c.json({ error: 'Internal server error', detail: err.message }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found', path: c.req.path }, 404);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Export
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default app;
