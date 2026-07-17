import fs from "node:fs";
import path from "node:path";

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.trim().startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeWhatsapp(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return (digits.length === 12 || digits.length === 13) && digits.startsWith("55")
    ? digits.slice(2)
    : digits;
}

function findValue(row, aliases) {
  const keys = Object.keys(row);
  const aliasSet = new Set(aliases.map(normalizeKey));
  const key = keys.find((candidate) => aliasSet.has(normalizeKey(candidate)));
  return key ? row[key] : "";
}

async function fetchAllLeads(url, key, orgId) {
  const leads = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(
      `${url}/rest/v1/leads?select=id,nome,whatsapp,created_at&org_id=eq.${encodeURIComponent(orgId)}&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!response.ok) throw new Error(await response.text());
    const page = await response.json();
    leads.push(...page);
    if (page.length < pageSize) break;
  }

  return leads;
}

async function ingestRow(url, key, orgId, lead, eventId) {
  const response = await fetch(`${url}/rest/v1/rpc/ingest_lead_webhook`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_org_id: orgId,
      p_provider: "inlead-csv",
      p_external_event_id: eventId,
      p_request_id: eventId,
      p_lead: lead,
      p_context: { source: "csv_reconciliation" },
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const [csvPathArg, orgId, flag] = process.argv.slice(2);
if (!csvPathArg || !orgId) {
  console.error("Uso: node scripts/reconcile-inlead-csv.mjs <arquivo.csv> <org_id> [--apply]");
  process.exit(1);
}

const root = process.cwd();
const env = {
  ...parseEnvFile(path.join(root, ".env")),
  ...parseEnvFile(path.join(root, ".env.local")),
  ...process.env,
};
const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente de manutencao.");
}

const csvPath = path.resolve(csvPathArg);
const matrix = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, ""));
if (matrix.length < 2) throw new Error("CSV vazio ou sem linhas de dados.");

const headers = matrix[0].map((header) => header.trim());
const rows = matrix.slice(1).map((values, rowIndex) => ({
  rowNumber: rowIndex + 2,
  data: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
}));

const existingLeads = await fetchAllLeads(supabaseUrl, serviceKey, orgId);
const existingByWhatsapp = new Map(
  existingLeads
    .map((lead) => [normalizeWhatsapp(lead.whatsapp), lead])
    .filter(([whatsapp]) => whatsapp),
);
const seenCsv = new Map();
const report = {
  org_id: orgId,
  file: path.basename(csvPath),
  dry_run: flag !== "--apply",
  total_rows: rows.length,
  complete: [],
  incomplete: [],
  existing: [],
  missing: [],
  duplicates_in_csv: [],
  inserted: [],
  errors: [],
};

for (const entry of rows) {
  const row = entry.data;
  const nome = normalizeName(findValue(row, ["nome", "nome completo", "name"]));
  const whatsapp = normalizeWhatsapp(findValue(row, ["whatsapp", "telefone", "celular", "phone"]));

  if (!nome || !whatsapp) {
    report.incomplete.push({ row: entry.rowNumber, nome, whatsapp });
    continue;
  }

  const lead = {
    nome,
    whatsapp,
    cidade: normalizeName(findValue(row, ["cidade", "city", "municipio"])),
    created_at: findValue(row, ["created at", "created_at", "data preenchimento", "horario"]),
    utm_source: findValue(row, ["utm source", "utm_source", "origem"]),
    utm_campaign: findValue(row, ["utm campaign", "utm_campaign", "campanha"]),
    utm_medium: findValue(row, ["utm medium", "utm_medium", "conjunto", "adset"]),
    utm_content: findValue(row, ["utm content", "utm_content", "anuncio", "ad"]),
    utm_term: findValue(row, ["utm term", "utm_term"]),
    utm_id: findValue(row, ["utm id", "utm_id"]),
    fbclid: findValue(row, ["fbclid"]),
    status: 0,
    wa_sent: false,
    quiz_respostas: row,
  };
  report.complete.push({ row: entry.rowNumber, nome, whatsapp });

  if (seenCsv.has(whatsapp)) {
    report.duplicates_in_csv.push({
      row: entry.rowNumber,
      first_row: seenCsv.get(whatsapp),
      nome,
      whatsapp,
    });
    continue;
  }
  seenCsv.set(whatsapp, entry.rowNumber);

  const existing = existingByWhatsapp.get(whatsapp);
  if (existing) {
    report.existing.push({ row: entry.rowNumber, lead_id: existing.id, nome, whatsapp });
    continue;
  }

  report.missing.push({ row: entry.rowNumber, nome, whatsapp });
  if (flag !== "--apply") continue;

  const eventId = `csv:${path.basename(csvPath)}:${entry.rowNumber}:${whatsapp}`;
  try {
    const result = await ingestRow(supabaseUrl, serviceKey, orgId, lead, eventId);
    report.inserted.push({ row: entry.rowNumber, lead_id: result.lead_id, nome, whatsapp });
    existingByWhatsapp.set(whatsapp, { id: result.lead_id, nome, whatsapp });
  } catch (error) {
    report.errors.push({ row: entry.rowNumber, nome, whatsapp, error: String(error) });
  }
}

const reportPath = path.join(
  root,
  `reconciliation-${path.basename(csvPath, path.extname(csvPath))}-${Date.now()}.json`,
);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  report: reportPath,
  dry_run: report.dry_run,
  total_rows: report.total_rows,
  complete: report.complete.length,
  incomplete: report.incomplete.length,
  existing: report.existing.length,
  missing: report.missing.length,
  duplicates_in_csv: report.duplicates_in_csv.length,
  inserted: report.inserted.length,
  errors: report.errors.length,
}, null, 2));

export { normalizeName, normalizeWhatsapp, parseCsv };
