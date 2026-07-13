const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const META_BASE = "https://graph.facebook.com/v18.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

const dbH = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

const LEAD_ACTIONS = ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"];
const PAGE_LIMIT = "500";
const MAX_BUDGET_CHANGE_PCT = 0.20;
const BUDGET_ACTION_THROTTLE_MS = 6 * 60 * 60 * 1000;

type InsightNode = {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  frequency: number;
  leads_api: number;
  cpl: number;
};

type CampaignNode = InsightNode & {
  daily_budget: number;
  lifetime_budget: number;
  created_time?: string;
  adsets: AdsetNode[];
  ads: AdNode[];
  crm_leads: number;
  crm_revs: number;
  crm_potentials: number;
  cpr: number;
  tendencia: "melhorando" | "estavel" | "piorando";
  cpl_7d: number;
  cpl_14d: number;
};

type AdsetNode = InsightNode & {
  campaign_id: string;
  daily_budget: number;
  lifetime_budget: number;
  crm_leads: number;
  crm_revs: number;
  crm_potentials: number;
  cpr: number;
  ads: AdNode[];
};

type AdNode = InsightNode & {
  campaign_id: string;
  adset_id: string;
  creative_id: string | null;
  thumbnail_url: string | null;
};

async function rest(path: string, opts?: RequestInit) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbH, ...opts });
}

async function restAll(path: string, pageSize = 1000) {
  const rows: any[] = [];
  let from = 0;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await rest(`${path}${sep}limit=${pageSize}&offset=${from}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function n(v: unknown) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function round(v: number) {
  return Math.round(v);
}

function brl(v: number) {
  return `R$ ${Math.round(v).toLocaleString("pt-BR")}`;
}

function increaseBudget(current: number) {
  return Math.round(current * (1 + MAX_BUDGET_CHANGE_PCT));
}

function decreaseBudget(current: number) {
  return Math.max(10, Math.round(current * (1 - MAX_BUDGET_CHANGE_PCT)));
}

function pct(v: number) {
  return `${Math.round(v)}%`;
}

function shortName(name?: string | null) {
  if (!name) return "Campanha";
  return name.match(/BCK\s*\d+/i)?.[0].replace(/\s+/, " ").toUpperCase() || name.replace(/\s*-\s*\[(CBO|ABO)\]/gi, "").slice(0, 42);
}

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function getLeads(actions: any[]) {
  return parseInt(actions?.find((a: any) => LEAD_ACTIONS.includes(a.action_type))?.value || "0");
}

function readInsight(raw: any): Omit<InsightNode, "id" | "name" | "status"> {
  const ins = raw?.insights?.data?.[0] || {};
  const spend = n(ins.spend);
  const leads = getLeads(ins.actions || []);
  const impressions = parseInt(ins.impressions || "0");
  const clicks = parseInt(ins.clicks || "0");
  return {
    spend,
    impressions,
    clicks,
    ctr: n(ins.ctr),
    cpm: n(ins.cpm),
    frequency: n(ins.frequency),
    leads_api: leads,
    cpl: leads > 0 ? spend / leads : 0,
  };
}

function parseDate(str?: string | null): Date | null {
  if (!str) return null;
  if (str.includes("T")) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const sql = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/);
  if (sql) {
    const d = new Date(str.replace(" ", "T").replace("+00:00", "Z").replace("+00", "Z"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const br = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2})?:?(\d{2})?/);
  if (br) {
    const [, day, month, year, hour = "0", min = "0"] = br;
    const d = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${min.padStart(2, "0")}:00-03:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfBRTodayMinus(days: number) {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  br.setHours(0, 0, 0, 0);
  br.setDate(br.getDate() - days);
  return br;
}

function endOfBRToday() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  br.setHours(23, 59, 59, 999);
  return br;
}

function startOfBRMonth() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  br.setDate(1);
  br.setHours(0, 0, 0, 0);
  return br;
}

function endOfBRMonth() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  br.setMonth(br.getMonth() + 1, 0);
  br.setHours(23, 59, 59, 999);
  return br;
}

function startOfPreviousBRMonth() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  br.setMonth(br.getMonth() - 1, 1);
  br.setHours(0, 0, 0, 0);
  return br;
}

function endOfPreviousBRMonth() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  br.setDate(0);
  br.setHours(23, 59, 59, 999);
  return br;
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function inRange(dateStr: string | null | undefined, start: Date, end: Date) {
  const d = parseDate(dateStr);
  return !!d && d >= start && d <= end;
}

function getStatusRef(lead: any, status?: number | null) {
  const field = status === 3
    ? "status_aprovado_at"
    : status === 5
      ? "status_contrato_at"
      : status === 2
        ? "status_reuniao_at"
        : status === 6
          ? "status_sem_retorno_at"
          : null;
  return (field ? lead[field] : null) || lead.ultimo_status_change || lead.created_at;
}

function defaultStatusConfig(modelo: string) {
  if (modelo === "revenda") {
    return {
      convertido_status: 3,
      statuses: [
        { id: 1, label: "Em atendimento", ordem: 1 },
        { id: 2, label: "Reuniao", ordem: 2 },
        { id: 5, label: "Contrato/App", ordem: 3 },
        { id: 3, label: "Aprovada", ordem: 4 },
        { id: 6, label: "Sem retorno", ordem: 5 },
        { id: 4, label: "Reprovado", ordem: 6 },
      ],
    };
  }
  return {
    convertido_status: 4,
    statuses: [
      { id: 1, label: "Entrada", ordem: 1 },
      { id: 2, label: "Reuniao", ordem: 2 },
      { id: 3, label: "Proposta", ordem: 3 },
      { id: 4, label: "Convertido", ordem: 4 },
    ],
  };
}

function getFunnelConfig(org: any) {
  const fallback = defaultStatusConfig(org?.modelo_negocio || "revenda");
  const cfg = org?.status_config?.statuses?.length ? org.status_config : fallback;
  const statuses = [...(cfg.statuses || fallback.statuses)].sort((a: any, b: any) => n(a.ordem) - n(b.ordem));
  const convertido = Number(cfg.convertido_status || fallback.convertido_status);
  const isNegative = (label?: string | null) => {
    const value = normalize(label);
    return ["reprovado", "sem retorno", "perdido", "cancelado", "descartado", "desqualificado", "recusado"].some((term) => value.includes(term));
  };
  const semanticTerms = ["contrato", "cadastro", "proposta", "app", "qualificado", "documentos", "analise", "reuniao"];
  const explicitPre = org?.ravena_pre_conversion_status != null ? statuses.find((st: any) => Number(st.id) === Number(org.ravena_pre_conversion_status)) : null;
  const semanticPre = statuses.find((st: any) => Number(st.id) !== convertido && !isNegative(st.label) && semanticTerms.some((term) => normalize(st.label).includes(term)));
  const idx = statuses.findIndex((st: any) => Number(st.id) === convertido);
  const orderedPre = idx > 0 ? [...statuses.slice(0, idx)].reverse().find((st: any) => !isNegative(st.label)) : null;
  const pre = explicitPre && !isNegative(explicitPre.label) ? explicitPre : semanticPre || orderedPre || null;
  return {
    convertidoStatus: convertido,
    convertidoLabel: statuses.find((st: any) => Number(st.id) === convertido)?.label || "Convertido",
    preStatus: pre ? Number(pre.id) : null,
    preStatusLabel: pre?.label || "Potencial",
  };
}

function isPaidTrafficLead(lead: any) {
  const src = normalize(lead.utm_source);
  return ["fb", "facebook", "ig", "instagram", "meta", "trafego pago", "trafego antigo"].includes(src)
    || String(lead.utm_campaign || "").trim().length > 0;
}

function normalize(s?: string | null) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function extractUtmCampaign(lead: any) {
  const raw = String(lead.utm_campaign || "").trim();
  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  return {
    raw,
    name: parts[0] || raw,
    id: parts[1] || "",
  };
}

function matchesCampaign(lead: any, camp: CampaignNode) {
  const utm = extractUtmCampaign(lead);
  const raw = normalize(utm.raw);
  const name = normalize(utm.name);
  const campName = normalize(camp.name);
  if (!raw && !name) return false;
  if (utm.id && utm.id === camp.id) return true;
  if (raw.includes(camp.id)) return true;
  if (name === campName) return true;
  if (campName.length >= 10 && name.includes(campName.slice(0, 22))) return true;
  if (name.length >= 10 && campName.includes(name.slice(0, 22))) return true;
  return false;
}

function extractUtmAdset(lead: any) {
  const campaign = String(lead.utm_campaign || "").split("|").map((p) => p.trim());
  const medium = String(lead.utm_medium || "").split("|").map((p) => p.trim());
  return {
    name: normalize(campaign[2] || medium[0] || ""),
    id: campaign[3] || medium[1] || "",
  };
}

function extractUtmAd(lead: any) {
  const campaign = String(lead.utm_campaign || "").split("|").map((p) => p.trim());
  const content = String(lead.utm_content || "").split("|").map((p) => p.trim());
  return {
    name: normalize(campaign[4] || content[0] || ""),
    id: campaign[5] || content[1] || "",
  };
}

function matchesAdset(lead: any, adset: AdsetNode) {
  const utm = extractUtmAdset(lead);
  const adsetName = normalize(adset.name);
  if (!utm.id && !utm.name) return false;
  if (utm.id && utm.id === adset.id) return true;
  if (utm.name === adsetName) return true;
  if (utm.name.length >= 8 && adsetName.includes(utm.name.slice(0, 18))) return true;
  return false;
}

function matchesAd(lead: any, ad: AdNode) {
  const utm = extractUtmAd(lead);
  const adName = normalize(ad.name);
  if (!utm.id && !utm.name) return false;
  if (utm.id && utm.id === ad.id) return true;
  if (utm.name === adName) return true;
  if (utm.name.length >= 8 && adName.includes(utm.name.slice(0, 18))) return true;
  return false;
}

async function fbGetAll(url: URL) {
  const all: any[] = [];
  let next: string | null = url.toString();
  while (next) {
    const data = await (await fetch(next)).json();
    if (data.error) throw new Error(data.error.message || "Erro Meta Ads");
    all.push(...(data.data || []));
    next = data.paging?.next || null;
  }
  return all;
}

function metaFields(preset: string, safe = false) {
  if (safe) {
    return {
      campaign: "id,name,status,daily_budget,lifetime_budget,created_time,insights.date_preset(" + preset + "){spend,impressions,clicks,ctr,cpm,actions}",
      adset: "id,name,status,campaign_id,daily_budget,lifetime_budget,insights.date_preset(" + preset + "){spend,impressions,clicks,ctr,actions}",
      ad: "id,name,status,campaign_id,adset_id,creative{thumbnail_url},insights.date_preset(" + preset + "){spend,ctr,actions}",
    };
  }
  return {
    campaign: "id,name,status,effective_status,daily_budget,lifetime_budget,created_time,insights.date_preset(" + preset + "){spend,impressions,clicks,ctr,cpm,frequency,actions}",
    adset: "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,insights.date_preset(" + preset + "){spend,impressions,clicks,ctr,cpm,frequency,actions}",
    ad: "id,name,status,effective_status,campaign_id,adset_id,creative{id,thumbnail_url,image_url,video_id,image_hash},insights.date_preset(" + preset + "){spend,impressions,clicks,ctr,cpm,frequency,actions}",
  };
}

function isInvalidMetaParameter(err: unknown) {
  const msg = String(err || "").toLowerCase();
  return msg.includes("invalid parameter") || msg.includes("nonexisting field") || msg.includes("unsupported get request");
}

async function loadMeta(token: string, account: string, preset: string) {
  try {
    return await loadMetaWithFields(token, account, preset, false);
  } catch (err) {
    if (!isInvalidMetaParameter(err)) throw err;
    console.warn("[otimizar] Meta retornou parametro invalido; tentando leitura segura:", String(err).slice(0, 180));
    return await loadMetaWithFields(token, account, preset, true);
  }
}

async function loadMetaWithFields(token: string, account: string, preset: string, safe: boolean) {
  const fields = metaFields(preset, safe);
  const campUrl = new URL(META_BASE + "/act_" + account + "/campaigns");
  campUrl.searchParams.set("fields", fields.campaign);
  campUrl.searchParams.set("limit", PAGE_LIMIT);
  campUrl.searchParams.set("access_token", token);

  const adsetUrl = new URL(META_BASE + "/act_" + account + "/adsets");
  adsetUrl.searchParams.set("fields", fields.adset);
  adsetUrl.searchParams.set("limit", PAGE_LIMIT);
  adsetUrl.searchParams.set("access_token", token);

  const adUrl = new URL(META_BASE + "/act_" + account + "/ads");
  adUrl.searchParams.set("fields", fields.ad);
  adUrl.searchParams.set("limit", PAGE_LIMIT);
  adUrl.searchParams.set("access_token", token);

  const [rawCampaigns, rawAdsets, rawAds] = await Promise.all([
    fbGetAll(campUrl),
    fbGetAll(adsetUrl),
    fbGetAll(adUrl),
  ]);

  const adsByCampaign = new Map<string, AdNode[]>();
  const adsByAdset = new Map<string, AdNode[]>();
  for (const ad of rawAds) {
    const metric = readInsight(ad);
    const item: AdNode = {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      effective_status: ad.effective_status,
      campaign_id: ad.campaign_id,
      adset_id: ad.adset_id,
      creative_id: ad.creative?.id || ad.creative?.video_id || ad.creative?.image_hash || null,
      thumbnail_url: ad.creative?.thumbnail_url || ad.creative?.image_url || null,
      ...metric,
    };
    if (!adsByCampaign.has(item.campaign_id)) adsByCampaign.set(item.campaign_id, []);
    if (!adsByAdset.has(item.adset_id)) adsByAdset.set(item.adset_id, []);
    adsByCampaign.get(item.campaign_id)!.push(item);
    adsByAdset.get(item.adset_id)!.push(item);
  }

  const adsetsByCampaign = new Map<string, AdsetNode[]>();
  for (const adset of rawAdsets) {
    const metric = readInsight(adset);
    const item: AdsetNode = {
      id: adset.id,
      name: adset.name,
      status: adset.status,
      effective_status: adset.effective_status,
      campaign_id: adset.campaign_id,
      daily_budget: adset.daily_budget ? parseInt(adset.daily_budget) / 100 : 0,
      lifetime_budget: adset.lifetime_budget ? parseInt(adset.lifetime_budget) / 100 : 0,
      crm_leads: 0,
      crm_revs: 0,
      crm_potentials: 0,
      cpr: 0,
      ads: (adsByAdset.get(adset.id) || []).sort((a, b) => b.leads_api - a.leads_api || a.cpl - b.cpl),
      ...metric,
    };
    if (!adsetsByCampaign.has(item.campaign_id)) adsetsByCampaign.set(item.campaign_id, []);
    adsetsByCampaign.get(item.campaign_id)!.push(item);
  }

  return rawCampaigns.map((camp: any): CampaignNode => {
    const metric = readInsight(camp);
    return {
      id: camp.id,
      name: camp.name,
      status: camp.status,
      effective_status: camp.effective_status,
      daily_budget: camp.daily_budget ? parseInt(camp.daily_budget) / 100 : 0,
      lifetime_budget: camp.lifetime_budget ? parseInt(camp.lifetime_budget) / 100 : 0,
      created_time: camp.created_time,
      adsets: (adsetsByCampaign.get(camp.id) || []).sort((a, b) => b.leads_api - a.leads_api || a.cpl - b.cpl),
      ads: (adsByCampaign.get(camp.id) || []).sort((a, b) => b.leads_api - a.leads_api || a.cpl - b.cpl),
      crm_leads: 0,
      crm_revs: 0,
      crm_potentials: 0,
      cpr: 0,
      tendencia: "estavel",
      cpl_7d: 0,
      cpl_14d: 0,
      ...metric,
    };
  }).filter((c: CampaignNode) => c.spend > 0 || c.status === "ACTIVE");
}

async function loadMetaTotals(token: string, account: string, since: Date, until: Date) {
  const url = new URL(`${META_BASE}/act_${account}/insights`);
  url.searchParams.set("fields", "spend,actions");
  url.searchParams.set("time_range", JSON.stringify({ since: ymd(since), until: ymd(until) }));
  url.searchParams.set("access_token", token);
  const data = await (await fetch(url.toString())).json();
  if (data.error) throw new Error(data.error.message || "Erro Meta Ads");
  const ins = data.data?.[0] || {};
  const spend = n(ins.spend);
  const leads = getLeads(ins.actions || []);
  return { spend, leads, cpl: leads > 0 ? spend / leads : 0 };
}

async function attachTrend(campaigns: CampaignNode[], token: string) {
  await Promise.all(campaigns.map(async (camp) => {
    const load = async (preset: string) => {
      const url = new URL(`${META_BASE}/${camp.id}/insights`);
      url.searchParams.set("fields", "spend,actions");
      url.searchParams.set("date_preset", preset);
      url.searchParams.set("access_token", token);
      const data = await (await fetch(url.toString())).json();
      const ins = data.data?.[0] || {};
      const spend = n(ins.spend);
      const leads = getLeads(ins.actions || []);
      return leads > 0 ? spend / leads : 0;
    };
    try {
      camp.cpl_7d = await load("last_7d");
      camp.cpl_14d = await load("last_14d");
      if (camp.cpl_7d > 0 && camp.cpl_14d > 0) {
        const diff = (camp.cpl_7d - camp.cpl_14d) / camp.cpl_14d;
        camp.tendencia = diff >= 0.25 ? "piorando" : diff <= -0.20 ? "melhorando" : "estavel";
      }
    } catch {
      camp.tendencia = "estavel";
    }
  }));
}

function attachCrm(campaigns: CampaignNode[], leads: any[], start7: Date, end: Date, convertidoStatus: number, preStatus: number | null) {
  for (const camp of campaigns) {
    const campLeads = leads.filter((l) => matchesCampaign(l, camp) && inRange(l.created_at, start7, end));
    const campRevs = leads.filter((l) => matchesCampaign(l, camp) && Number(l.status) === convertidoStatus && inRange(getStatusRef(l, convertidoStatus), start7, end));
    const campPotentials = preStatus == null
      ? []
      : leads.filter((l) => matchesCampaign(l, camp) && Number(l.status) === preStatus && inRange(getStatusRef(l, preStatus), start7, end));
    camp.crm_leads = campLeads.length;
    camp.crm_revs = campRevs.length;
    camp.crm_potentials = campPotentials.length;
    camp.cpr = camp.crm_revs > 0 ? camp.spend / camp.crm_revs : 0;

    for (const adset of camp.adsets) {
      const directLeads = campLeads.filter((l) => matchesAdset(l, adset));
      const directRevs = campRevs.filter((l) => matchesAdset(l, adset));
      const directPotentials = campPotentials.filter((l) => matchesAdset(l, adset));
      const apiWeight = camp.adsets.reduce((s, a) => s + a.leads_api, 0);
      const fallbackShare = apiWeight > 0 ? adset.leads_api / apiWeight : 1 / Math.max(camp.adsets.length, 1);
      adset.crm_leads = directLeads.length || Math.round(camp.crm_leads * fallbackShare);
      adset.crm_revs = directRevs.length || Math.round(camp.crm_revs * fallbackShare);
      adset.crm_potentials = directPotentials.length || Math.round(camp.crm_potentials * fallbackShare);
      adset.cpr = adset.crm_revs > 0 ? adset.spend / adset.crm_revs : 0;
    }
  }
}

function scoreCampaign(c: CampaignNode, avgCpl: number, avgCpr: number) {
  let score = 50;
  if (c.crm_revs > 0) score += Math.min(c.crm_revs * 7, 28);
  else if (c.crm_potentials > 0) score += Math.min(c.crm_potentials * 5, 18);
  else if (c.spend >= 80) score -= 18;
  if (avgCpr > 0 && c.cpr > 0) score += c.cpr <= avgCpr * 0.75 ? 18 : c.cpr <= avgCpr ? 8 : c.cpr >= avgCpr * 1.4 ? -18 : -6;
  if (avgCpl > 0 && c.cpl > 0) score += c.cpl <= avgCpl * 0.75 ? 10 : c.cpl >= avgCpl * 1.4 ? -10 : 0;
  if (c.tendencia === "melhorando") score += 8;
  if (c.tendencia === "piorando") score -= 14;
  if (c.ctr >= 2.5) score += 4;
  if (c.ctr > 0 && c.ctr < 1) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildSuggestions(campaigns: CampaignNode[], avgCpl: number, avgCpr: number, modo: string, preStatusLabel: string, guardrails: any = {}) {
  const reducao = modo === "conservador" ? 0.15 : MAX_BUDGET_CHANGE_PCT;
  const aumento = modo === "conservador" ? 0.15 : MAX_BUDGET_CHANGE_PCT;
  const sugestoes: any[] = [];
  const analise: any[] = [];
  const cprHistorico = Number(guardrails.cprMesAnterior || 0);
  const deltaCprGuard = Number(guardrails.deltaCpr || 0);
  const deltaCplGuard = Number(guardrails.deltaCpl || 0);
  const contaComCustoEstourado = deltaCprGuard >= 50 || deltaCplGuard >= 50;
  const contaComCustoPressionado = deltaCprGuard >= 30 || deltaCplGuard >= 35;

  for (const camp of campaigns.filter((c) => c.status === "ACTIVE")) {
    const label = shortName(camp.name);

    // CBO: budget at campaign level. ABO: budget split across adsets â€” sum active adsets as effective budget.
    const campBudget = camp.daily_budget || 0;
    const adsetDailySum = camp.adsets
      .filter(a => a.status === "ACTIVE")
      .reduce((s, a) => s + (a.daily_budget || 0), 0);
    const budget = campBudget || adsetDailySum;
    const isAbo = campBudget === 0 && adsetDailySum > 0;

    const enoughSpend = camp.spend >= Math.max(50, avgCpl * 4);
    const cprRuim = (avgCpr > 0 && camp.cpr > avgCpr * 1.25) || (cprHistorico > 0 && camp.cpr > cprHistorico * 1.50);
    const cplRuim = avgCpl > 0 && camp.cpl > avgCpl * 1.35;
    const temPipeline = camp.crm_potentials > 0;
    const semRevs = camp.crm_revs === 0 && enoughSpend;
    const semPipeline = semRevs && !temPipeline;

    // Either CPR or CPL excellent is enough to qualify for scale â€” CPR winning overrides slightly bad CPL.
    const boaCpr = camp.crm_revs > 0 && avgCpr > 0 && camp.cpr > 0 && camp.cpr <= avgCpr * 0.8;
    const boaCpl = camp.crm_revs > 0 && avgCpl > 0 && camp.cpl > 0 && camp.cpl <= avgCpl * 0.8;
    const custoHistoricoOk = cprHistorico <= 0 || camp.cpr <= cprHistorico * 1.30;
    const custoAtualOk = avgCpr <= 0 || camp.cpr <= avgCpr * 0.85;
    const podeEscalar = contaComCustoEstourado === false && custoHistoricoOk && custoAtualOk;
    const boa = (boaCpr || boaCpl) && podeEscalar;

    let decisao = "manter";
    let porque = `${label} estÃ¡ dentro do esperado.`;
    let proximo = "Continuar acompanhando por mais 24 horas.";

    if (semPipeline && cplRuim) {
      decisao = "pausar";
      porque = `${label} gastou ${brl(camp.spend)} e ainda nÃ£o trouxe aprovadas.`;
      proximo = "Pausar e revisar pÃºblico e criativo antes de voltar.";
      sugestoes.push({
        tipo: "pausar_campanha",
        id: camp.id,
        nome: camp.name,
        campanha_nome: camp.name,
        motivo: porque,
      });
    } else if (semRevs && temPipeline) {
      decisao = "aguardar";
      porque = `${label} ainda nao aprovou, mas tem ${camp.crm_potentials} lead${camp.crm_potentials !== 1 ? "s" : ""} em ${preStatusLabel}.`;
      proximo = "Segurar por 24-48h e cobrar fechamento antes de cortar verba.";
    } else if ((boaCpr || boaCpl) && podeEscalar === false) {
      decisao = "observacao";
      porque = label + " teve escala bloqueada por alta de CPR/CPL.";
      proximo = "Subir novos criativos antes de escalar verba.";
    } else if (boa && budget > 0 && camp.tendencia !== "piorando") {
      // Check scale before bad-metrics: excellent CPR overrides slightly bad CPL.
      const novoBase = Math.round(budget * (1 + aumento));
      if (novoBase > budget) {
        decisao = "escalar";
        porque = `${label} estÃ¡ trazendo aprovadas com custo bom.`;
        if (isAbo) {
          const bestAdset = [...camp.adsets]
            .filter(a => a.status === "ACTIVE" && (a.daily_budget || 0) > 0)
            .sort((a, b) => (b.crm_revs * 30 + b.leads_api * 4 + b.ctr * 2) - (a.crm_revs * 30 + a.leads_api * 4 + a.ctr * 2))[0];
          if (bestAdset) {
            const novoAdset = Math.round(bestAdset.daily_budget * (1 + aumento));
            proximo = `Subir conjunto "${bestAdset.name}" de ${brl(bestAdset.daily_budget)}/dia para ${brl(novoAdset)}/dia e reavaliar em 48h.`;
            sugestoes.push({
              tipo: "aumentar_budget_conjunto",
              id: bestAdset.id,
              nome: bestAdset.name,
              conjunto_nome: bestAdset.name,
              campanha_nome: camp.name,
              direcao: "aumento",
              antigo_budget: bestAdset.daily_budget,
              novo_budget: novoAdset,
              motivo: porque,
              automatico: true,
            });
          } else {
            proximo = `Escalar manualmente os adsets de ${label}.`;
          }
        } else {
          proximo = `Subir de ${brl(campBudget)}/dia para ${brl(novoBase)}/dia sem mexer na estrutura.`;
          sugestoes.push({
            tipo: "aumentar_budget_campanha",
            id: camp.id,
            nome: camp.name,
            campanha_nome: camp.name,
            direcao: "aumento",
            antigo_budget: campBudget,
            novo_budget: novoBase,
            motivo: porque,
            automatico: true,
          });
        }
      }
    } else if ((cprRuim || cplRuim || camp.tendencia === "piorando") && camp.spend >= 30) {
      // Flag for optimization regardless of budget type; auto-execute only when budget is adjustable.
      decisao = "otimizar";
      porque = camp.tendencia === "piorando"
        ? `${label} estÃ¡ piorando e jÃ¡ merece cortar verba antes de estourar.`
        : `${label} estÃ¡ cara para o resultado que entregou.`;
      if (budget > 0) {
        if (isAbo) {
          const worstAdset = [...camp.adsets]
            .filter(a => a.status === "ACTIVE" && (a.daily_budget || 0) > 0)
            .sort((a, b) => (b.cpl || 999) - (a.cpl || 999))[0];
          if (worstAdset) {
            const novoAdset = Math.max(10, Math.round(worstAdset.daily_budget * (1 - reducao)));
            if (novoAdset < worstAdset.daily_budget) {
              proximo = `Reduzir conjunto "${worstAdset.name}" de ${brl(worstAdset.daily_budget)}/dia para ${brl(novoAdset)}/dia e reavaliar em 48h.`;
              sugestoes.push({
                tipo: "reduzir_budget_conjunto",
                id: worstAdset.id,
                nome: worstAdset.name,
                conjunto_nome: worstAdset.name,
                campanha_nome: camp.name,
                direcao: "reducao",
                antigo_budget: worstAdset.daily_budget,
                novo_budget: novoAdset,
                motivo: porque,
                automatico: true,
              });
            } else {
              proximo = "Revisar adsets â€” nenhum elegÃ­vel para reduÃ§Ã£o automÃ¡tica.";
            }
          } else {
            proximo = "Revisar adsets manualmente â€” sem budget ajustÃ¡vel detectado.";
          }
        } else {
          const novo = Math.max(10, Math.round(campBudget * (1 - reducao)));
          if (novo < campBudget) {
            proximo = `Reduzir de ${brl(campBudget)}/dia para ${brl(novo)}/dia e reavaliar em 48h.`;
            sugestoes.push({
              tipo: "reduzir_budget_campanha",
              id: camp.id,
              nome: camp.name,
              campanha_nome: camp.name,
              direcao: "reducao",
              antigo_budget: campBudget,
              novo_budget: novo,
              motivo: porque,
              automatico: true,
            });
          }
        }
      } else {
        proximo = "Revisar configuraÃ§Ã£o â€” campanha sem budget ajustÃ¡vel identificado.";
      }
    }

    const badAdsets = camp.adsets.filter((a) => {
      const gastoMinimo = Math.max(80, avgCpl * 6);
      const amostraSuficiente = a.leads_api >= 6 || a.spend >= Math.max(120, avgCpl * 10);
      const cplMuitoAcima = avgCpl > 0 && a.cpl > avgCpl * 1.4;
      return a.status === "ACTIVE"
        && a.spend >= gastoMinimo
        && amostraSuficiente
        && cplMuitoAcima
        && a.crm_revs === 0
        && a.crm_potentials === 0;
    });
    for (const adset of badAdsets.slice(0, 2)) {
      sugestoes.push({
        tipo: "pausar_conjunto",
        id: adset.id,
        nome: adset.name,
        conjunto_nome: adset.name,
        campanha_nome: camp.name,
        gasto: round(adset.spend),
        leads: adset.leads_api,
        cpl: round(adset.cpl),
        potenciais: adset.crm_potentials,
        revendedoras: adset.crm_revs,
        benchmark_cpl: round(avgCpl),
        motivo: `${adset.name} gastou ${brl(adset.spend)}, trouxe ${adset.leads_api} lead${adset.leads_api !== 1 ? "s" : ""} com CPL de ${brl(adset.cpl || 0)}, nÃ£o tem ${preStatusLabel} e nÃ£o aprovou ninguÃ©m. A mÃ©dia da conta estÃ¡ perto de ${brl(avgCpl || 0)} por lead.`,
      });
    }

    analise.push({
      campanha_id: camp.id,
      campanha_nome: camp.name,
      campanha_curta: label,
      decisao,
      porque,
      proximo_passo: proximo,
      gasto: round(camp.spend),
      leads: Math.max(camp.crm_leads, camp.leads_api),
      revendedoras: camp.crm_revs,
      potenciais: camp.crm_potentials,
      potenciais_label: preStatusLabel,
      cpl: round(camp.cpl),
      cpr: round(camp.cpr),
      taxa_conversao: camp.crm_leads > 0 ? Math.round((camp.crm_revs / camp.crm_leads) * 100) : 0,
      tendencia: camp.tendencia,
      score: scoreCampaign(camp, avgCpl, avgCpr),
    });
  }

  return { sugestoes, analise };
}

function bestMaster(campaigns: CampaignNode[], avgCpr: number) {
  const active = campaigns.filter((c) => c.status === "ACTIVE" && (c.crm_revs > 0 || c.leads_api > 0));
  if (!active.length) return null;
  const ranked = active
    .map((c) => ({ c, score: scoreCampaign(c, 0, avgCpr) }))
    .sort((a, b) => b.score - a.score);
  const base = ranked[0].c;
  const bestAdset = [...base.adsets].filter((a) => a.spend > 0 || a.leads_api > 0).sort((a, b) => {
    const aScore = (a.crm_revs * 30) + (a.leads_api * 4) + (a.ctr * 2) - (a.cpl || 999) / 4;
    const bScore = (b.crm_revs * 30) + (b.leads_api * 4) + (b.ctr * 2) - (b.cpl || 999) / 4;
    return bScore - aScore;
  })[0] || null;
  const allAds = active.flatMap((c) => c.ads.map((ad) => ({ ad, camp: c })));
  const bestAd = allAds.filter((x) => x.ad.spend > 0 || x.ad.leads_api > 0).sort((a, b) => {
    const sa = (a.ad.leads_api * 10) + (a.ad.ctr * 4) - (a.ad.cpl || 999) / 3;
    const sb = (b.ad.leads_api * 10) + (b.ad.ctr * 4) - (b.ad.cpl || 999) / 3;
    return sb - sa;
  })[0]?.ad || null;
  const budget = base.daily_budget > 0 ? Math.max(30, Math.round(base.daily_budget * 0.6)) : 50;
  return {
    titulo: "SugestÃ£o de campanha",
    campanha_base: base.name,
    campanha_base_id: base.id,
    publico: bestAdset?.name || "Melhor pÃºblico da campanha vencedora",
    publico_id: bestAdset?.id || null,
    criativo: bestAd?.name || "Melhor criativo ativo",
    criativo_id: bestAd?.id || null,
    thumbnail_url: bestAd?.thumbnail_url || null,
    budget_diario_sugerido: budget,
    motivo: cleanText(`Juntar o que jÃ¡ provou funcionar: ${shortName(base.name)}, pÃºblico ${bestAdset?.name || "vencedor"} e criativo ${bestAd?.name || "vencedor"}.`),
    instrucoes: [
      `Criar uma campanha nova com ${brl(budget)}/dia.`,
      `Usar o pÃºblico "${bestAdset?.name || "vencedor"}".`,
      `ComeÃ§ar com o criativo "${bestAd?.name || "vencedor"}".`,
      "Deixar a campanha rodar 48 horas antes de escalar.",
    ],
  };
}

function collectMetaAlerts(campaigns: CampaignNode[]) {
  const bad = new Set(["ACCOUNT_DISABLED", "AD_ACCOUNT_DISABLED", "DISABLED", "RESTRICTED", "PAYMENT_REQUIRED", "PAYMENT_DISABLED"]);
  const alerts: any[] = [];
  const push = (tipo: string, item: any, campanha?: CampaignNode) => {
    const effective = String(item.effective_status || item.status || "").toUpperCase();
    const configured = String(item.status || "").toUpperCase();
    if (!effective || effective === "ACTIVE") return;
    if (!bad.has(effective)) return;
    alerts.push({
      tipo,
      id: item.id,
      nome: item.name,
      campanha_nome: campanha?.name || item.name,
      status: configured,
      status_facebook: effective,
      motivo: effective === "DISAPPROVED"
        ? "Reprovado pela Meta."
        : effective === "PENDING_REVIEW" || effective === "IN_PROCESS"
          ? "Em anÃ¡lise pela Meta."
          : effective === "WITH_ISSUES"
            ? "Com problema de entrega na Meta."
            : effective === "CAMPAIGN_PAUSED"
              ? "Campanha pausada na Meta."
              : effective === "ADSET_PAUSED"
                ? "Conjunto pausado na Meta."
                : `Status efetivo na Meta: ${effective}.`,
    });
  };
  for (const campaign of campaigns) {
    push("campanha", campaign);
    for (const adset of campaign.adsets || []) push("conjunto", adset, campaign);
    for (const ad of campaign.ads || []) push("anuncio", ad, campaign);
  }
  return alerts.slice(0, 8);
}

async function wasMasterRecentlyClosed(orgId: string, campanhaMestre: any) {
  if (!campanhaMestre?.campanha_base_id) return false;
  const res = await rest(`ai_optimization_logs?select=created_at,acoes_executadas&org_id=eq.${orgId}&order=created_at.desc&limit=50`);
  const logs = await res.json();
  if (!Array.isArray(logs)) return false;
  const cutoff = Date.now() - 21 * 86400000;
  return logs.some((log: any) => {
    const ts = new Date(log.created_at).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) return false;
    return (log.acoes_executadas || []).some((acao: any) =>
      acao?.tipo === "criar_campanha" &&
      acao?.ok !== false &&
      acao?.campanha_base_id === campanhaMestre.campanha_base_id
    );
  });
}

function isBudgetAction(acao: any) {
  const tipo = String(acao?.tipo || "").toLowerCase();
  return tipo.includes("budget") && (tipo.includes("aumentar") || tipo.includes("reduzir"));
}

function canAutoExecute(acao: any) {
  return acao?.automatico === true && isBudgetAction(acao);
}

function actionKey(acao: any) {
  const tipo = String(acao?.tipo || "").toLowerCase();
  const direction = tipo.includes("aumentar") ? "up" : tipo.includes("reduzir") ? "down" : tipo;
  return String(acao?.id || "sem-id") + ":" + direction;
}

async function getBudgetThrottle(orgId: string) {
  const res = await rest("ai_optimization_logs?select=created_at,acoes_executadas&org_id=eq." + orgId + "&order=created_at.desc&limit=50");
  const logs = await res.json();
  if (!Array.isArray(logs)) return { bloqueado: false, ultimo_ajuste_em: null };
  const cutoff = Date.now() - BUDGET_ACTION_THROTTLE_MS;
  const recente = logs.find((log: any) => {
    const ts = new Date(log.created_at).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) return false;
    return (log.acoes_executadas || []).some((acao: any) => acao?.ok !== false && isBudgetAction(acao));
  });
  return { bloqueado: !!recente, ultimo_ajuste_em: recente?.created_at || null };
}

async function executeBudgetAction(acao: any, token: string) {
  const tipo = String(acao?.tipo || "").toLowerCase();
  const atual = Number(acao?.antigo_budget || 0);
  let novo = Number(acao?.novo_budget || 0);
  if (!acao?.id || atual <= 0 || novo <= 0) {
    return { ...acao, automatico: true, ok: false, erro: "Budget invalido para executar", executado_em: new Date().toISOString() };
  }

  if (tipo.includes("aumentar")) {
    novo = Math.min(novo, increaseBudget(atual));
    if (novo <= atual) return { ...acao, novo_budget: novo, automatico: true, ok: false, erro: "Aumento ficou abaixo do budget atual", executado_em: new Date().toISOString() };
  } else if (tipo.includes("reduzir")) {
    novo = Math.max(novo, decreaseBudget(atual));
    if (novo >= atual) return { ...acao, novo_budget: novo, automatico: true, ok: false, erro: "Reducao ficou acima do budget atual", executado_em: new Date().toISOString() };
  } else {
    return { ...acao, automatico: true, ok: false, erro: "Tipo de budget nao suportado", executado_em: new Date().toISOString() };
  }

  try {
    const res = await fetch(`${META_BASE}/${acao.id}?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daily_budget: Math.round(novo * 100) }),
    });
    const data = await res.json();
    const ok = data.success === true;
    return { ...acao, novo_budget: novo, automatico: true, ok, erro: data.error?.message || (ok ? null : JSON.stringify(data)), executado_em: new Date().toISOString() };
  } catch (err) {
    return { ...acao, novo_budget: novo, automatico: true, ok: false, erro: String(err), executado_em: new Date().toISOString() };
  }
}

async function executeAutomaticBudgetActions(sugestoes: any[], token: string, bloqueado: boolean) {
  const executadas: any[] = [];
  const pendentes: any[] = [];
  const vistos = new Set<string>();
  for (const acao of sugestoes) {
    if (!canAutoExecute(acao)) {
      pendentes.push(acao);
      continue;
    }
    const key = actionKey(acao);
    if (vistos.has(key)) {
      pendentes.push({ ...acao, automatico: false, motivo_bloqueio_auto: "Acao duplicada na mesma analise; mantive apenas a primeira." });
      continue;
    }
    vistos.add(key);
    if (bloqueado) {
      pendentes.push({ ...acao, automatico: false, motivo_bloqueio_auto: "Bloqueado pelo intervalo de seguranca ou modo observacao." });
      continue;
    }
    executadas.push(await executeBudgetAction(acao, token));
  }
  return { executadas, pendentes };
}

async function analisarOrg(orgId: string) {
  const orgRes = await rest(`organizations?select=meta_token,meta_account_id,ravena_ativa,ravena_modo,ravena_meta_revendedoras,ravena_pre_conversion_status,modelo_negocio,status_config&id=eq.${orgId}&limit=1`);
  const [org] = await orgRes.json();
  if (!org?.ravena_ativa || !org.meta_token || !org.meta_account_id) {
    return { skip: true, motivo: "Ravena nÃ£o ativa ou sem token configurado" };
  }

  const token = org.meta_token;
  const account = org.meta_account_id;
  const modo = org.ravena_modo || "equilibrado";
  const metaRevs = Number(org.ravena_meta_revendedoras) || 0;
  const funil = getFunnelConfig(org);
  const modoObsAtivo = normalize(modo).includes("observ");
  const throttle = await getBudgetThrottle(orgId);
  const bloquearAutomatico = modoObsAtivo || throttle.bloqueado;
  const start7 = startOfBRTodayMinus(6);
  const end = endOfBRToday();
  const startMonth = startOfBRMonth();
  const endMonth = endOfBRMonth();
  const startPrevMonth = startOfPreviousBRMonth();
  const endPrevMonth = endOfPreviousBRMonth();

  let campaigns: CampaignNode[];
  try {
    campaigns = await loadMeta(token, account, "last_7d");
  } catch (err) {
    return {
      skip: false,
      log: {
        org_id: orgId,
        status: "erro",
        acoes_sugeridas: [],
        acoes_executadas: [],
        decisao_principal: "A Ravena nÃ£o conseguiu ler a conta Meta Ads",
        frase_do_dia: "Erro na sincronizaÃ§Ã£o com Meta Ads",
        resumo: "Sem dados recebidos da Meta.",
        insights: [],
        analise_campanhas: [],
        insight_do_dia: null,
        alerta: `Verifique a integraÃ§Ã£o com a Meta. ${String(err).slice(0, 120)}`,
        meta_alertas: [{
          tipo: "integracao",
          nome: "Meta Ads",
          status_facebook: "ERRO",
          motivo: String(err).slice(0, 180),
        }],
        total_gasto: 0,
        total_leads: 0,
        cpl_medio: 0,
        ritmo_mensal: 0,
        revendedoras_mes: 0,
        dias_restantes: 0,
        campanha_mestre: null,
      },
    };
  }

  if (!campaigns.length) return { skip: true, motivo: "Sem campanhas com dados" };

  const leads = await restAll(`leads?select=id,utm_campaign,utm_medium,utm_content,utm_source,status,created_at,status_aprovado_at,status_contrato_at,status_reuniao_at,status_sem_retorno_at,ultimo_status_change&org_id=eq.${orgId}`, 1000);
  await attachTrend(campaigns, token);
  attachCrm(campaigns, leads, start7, end, funil.convertidoStatus, funil.preStatus);

  const totalGasto = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalLeadsApi = campaigns.reduce((s, c) => s + c.leads_api, 0);
  const totalLeadsCrm = campaigns.reduce((s, c) => s + c.crm_leads, 0);
  const revsTotal = campaigns.reduce((s, c) => s + c.crm_revs, 0);
  const revsMes = leads.filter((l) =>
    Number(l.status) === funil.convertidoStatus &&
    inRange(getStatusRef(l, funil.convertidoStatus), startMonth, endMonth)
  ).length;
  const prevMonthRevs = leads.filter((l) =>
    Number(l.status) === funil.convertidoStatus &&
    inRange(getStatusRef(l, funil.convertidoStatus), startPrevMonth, endPrevMonth)
  ).length;
  const currentMonthTrafficRevs = leads.filter((l) =>
    isPaidTrafficLead(l) &&
    Number(l.status) === funil.convertidoStatus &&
    inRange(getStatusRef(l, funil.convertidoStatus), startMonth, end)
  ).length;
  const prevMonthTrafficRevs = leads.filter((l) =>
    isPaidTrafficLead(l) &&
    Number(l.status) === funil.convertidoStatus &&
    inRange(getStatusRef(l, funil.convertidoStatus), startPrevMonth, endPrevMonth)
  ).length;
  const cplMedio = totalLeadsApi > 0 ? totalGasto / totalLeadsApi : 0;
  const avgCpr = revsTotal > 0 ? totalGasto / revsTotal : 0;
  let metaMes = { spend: 0, leads: 0, cpl: 0 };
  let metaMesAnterior = { spend: 0, leads: 0, cpl: 0 };
  try {
    [metaMes, metaMesAnterior] = await Promise.all([
      loadMetaTotals(token, account, startMonth, end),
      loadMetaTotals(token, account, startPrevMonth, endPrevMonth),
    ]);
  } catch {
    metaMes = { spend: totalGasto, leads: totalLeadsApi, cpl: cplMedio };
  }
  const cprMes = currentMonthTrafficRevs > 0 ? metaMes.spend / currentMonthTrafficRevs : 0;
  const cprMesAnterior = prevMonthTrafficRevs > 0 ? metaMesAnterior.spend / prevMonthTrafficRevs : 0;
  const deltaCpr = cprMes > 0 && cprMesAnterior > 0 ? ((cprMes - cprMesAnterior) / cprMesAnterior) * 100 : 0;
  const deltaCpl = metaMes.cpl > 0 && metaMesAnterior.cpl > 0 ? ((metaMes.cpl - metaMesAnterior.cpl) / metaMesAnterior.cpl) * 100 : 0;
  let { sugestoes, analise } = buildSuggestions(campaigns, cplMedio, avgCpr, modo, funil.preStatusLabel, { cprMesAnterior, deltaCpr, deltaCpl });
  const custoGlobalEstourado = deltaCpr >= 50 || deltaCpl >= 50;
  const custoGlobalPressionado = deltaCpr >= 30 || deltaCpl >= 35;
  const metaAlertas = collectMetaAlerts(campaigns);
  const campanhaMestreBase = custoGlobalEstourado ? null : bestMaster(campaigns, avgCpr);
  const campanhaMestre = await wasMasterRecentlyClosed(orgId, campanhaMestreBase) ? null : campanhaMestreBase;

  const agora = new Date();
  const diasNoMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
  const diasRestantes = Math.max(0, diasNoMes - agora.getDate());
  const diasDecorridos = Math.max(agora.getDate(), 1);
  const ritmoMensal = Math.round((totalGasto / diasDecorridos) * diasNoMes);
  const ritmoRevs = Math.round((revsMes / diasDecorridos) * diasNoMes);

  const piorCriativo = [...analise].filter((a: any) => a.gasto >= 50).sort((a: any, b: any) => (b.cpr || 0) - (a.cpr || 0))[0];
  if (custoGlobalPressionado) {
    if (piorCriativo) {
      sugestoes.push({
        tipo: "novo_criativo",
        id: piorCriativo.campanha_id,
        nome: "Subir novos criativos",
        campanha_nome: piorCriativo.campanha_nome,
        motivo: "CPR/CPL subiram. Hora de testar novos criativos antes de escalar verba.",
        automatico: false,
      });
    }
  }
  const { executadas: acoesAutomaticas, pendentes: sugestoesPendentes } = await executeAutomaticBudgetActions(sugestoes, token, bloquearAutomatico);
  sugestoes = sugestoesPendentes;

  const melhor = [...analise].sort((a, b) => b.score - a.score)[0];
  const piorando = analise.filter((a) => a.tendencia === "piorando");
  const alerta = metaAlertas.length > 0
    ? `A Meta marcou ${metaAlertas.length} item${metaAlertas.length !== 1 ? "s" : ""} com problema. ${metaAlertas[0].nome}: ${metaAlertas[0].motivo}`
    : metaRevs > 0 && diasDecorridos >= 7 && ritmoRevs < metaRevs * 0.75
      ? `No ritmo atual, a conta projeta ${ritmoRevs} aprovadas no mÃªs. A meta Ã© ${metaRevs}.`
      : piorando.length > 0
        ? `${piorando[0].campanha_curta} estÃ¡ piorando. Melhor reduzir verba antes de queimar mais orÃ§amento.`
        : null;

  const piorCampanha = [...analise].filter((a) => a.gasto > 0).sort((a, b) => (b.cpr || 9999) - (a.cpr || 9999))[0];
  const diagnosticoCpr = cprMes > 0 && cprMesAnterior > 0
    ? deltaCpr > 25
      ? `O custo por ${funil.convertidoLabel} subiu ${pct(deltaCpr)} contra o mes passado (${brl(cprMesAnterior)} -> ${brl(cprMes)}). ${Math.abs(deltaCpl) < 15 ? "O CPL nao explica sozinho; o gargalo parece estar entre lead e CRM." : `O CPL tambem mudou ${pct(deltaCpl)}, entao parte do aumento veio da compra de lead.`} ${piorCampanha ? `${piorCampanha.campanha_curta} precisa de atencao no ranking.` : ""}`
      : `O custo por ${funil.convertidoLabel} esta perto do mes passado (${brl(cprMesAnterior)} -> ${brl(cprMes)}).`
    : "Ainda faltam conversoes de trafego suficientes para comparar custo atual contra mes anterior com seguranca.";

  const insightDia = campanhaMestre
    ? `A melhor combinaÃ§Ã£o hoje Ã© usar ${shortName(campanhaMestre.campanha_base)}, pÃºblico ${campanhaMestre.publico} e criativo ${campanhaMestre.criativo}. Isso pode virar uma sugestÃ£o de campanha com orÃ§amento inicial de ${brl(campanhaMestre.budget_diario_sugerido)}/dia.`
    : melhor
      ? `${melhor.campanha_curta} Ã© a campanha mais forte hoje. Ela trouxe ${melhor.revendedoras} aprovadas com custo de ${brl(melhor.cpr || 0)} por aprovada.`
      : "A Ravena analisou as campanhas, mas ainda precisa de mais dados para apontar uma vencedora clara.";

  const insightDiaFinal = `${diagnosticoCpr} ${insightDia}`;

  const recomendacoesPendentes = sugestoes.length + (campanhaMestre ? 1 : 0);
  const decisao = acoesAutomaticas.length > 0 && recomendacoesPendentes > 0
    ? `${acoesAutomaticas.length} ajuste${acoesAutomaticas.length !== 1 ? "s" : ""} feito${acoesAutomaticas.length !== 1 ? "s" : ""} e ${recomendacoesPendentes} recomenda${recomendacoesPendentes !== 1 ? "coes" : "cao"}`
    : acoesAutomaticas.length > 0
      ? `${acoesAutomaticas.length} ajuste${acoesAutomaticas.length !== 1 ? "s" : ""} feito${acoesAutomaticas.length !== 1 ? "s" : ""}`
      : recomendacoesPendentes > 0
        ? `${recomendacoesPendentes} recomenda${recomendacoesPendentes !== 1 ? "coes" : "cao"}`
        : "Nenhum ajuste urgente";

  return {
    skip: false,
    log: {
      org_id: orgId,
      status: recomendacoesPendentes > 0 ? "pendente" : (acoesAutomaticas.length > 0 ? "executado" : "sem_acao"),
      acoes_sugeridas: sugestoes,
      acoes_executadas: acoesAutomaticas,
      decisao_principal: decisao,
      frase_do_dia: recomendacoesPendentes > 0 ? "A Ravena encontrou ajustes para proteger seu orÃ§amento." : "Campanhas estÃ¡veis hoje.",
      resumo: `${Math.max(totalLeadsApi, totalLeadsCrm)} leads, ${revsTotal} aprovadas e custo mÃ©dio de ${brl(avgCpr || cplMedio)}.`,
      resumo_contextual: `${Math.max(totalLeadsApi, totalLeadsCrm)} leads, ${revsTotal} ${funil.convertidoLabel} e CPR mÃ©dio de ${brl(avgCpr || cplMedio)} nos Ãºltimos 7 dias.`,
      insights: analise.slice(0, 10),
      analise_campanhas: analise.slice(0, 10),
      insight_do_dia: insightDiaFinal,
      alerta,
      meta_alertas: metaAlertas,
      total_gasto: totalGasto,
      total_leads: Math.max(totalLeadsApi, totalLeadsCrm),
      cpl_medio: cplMedio,
      metricas_7d: {
        leads: Math.max(totalLeadsApi, totalLeadsCrm),
        gasto: round(totalGasto),
        cpl: round(cplMedio),
        convertido: revsTotal,
        cpr: round(avgCpr ? avgCpr : 0),
        convertido_label: funil.convertidoLabel,
      },
      ritmo_mensal: ritmoMensal,
      revendedoras_mes: revsMes,
      dias_restantes: diasRestantes,
      throttle_ativo: bloquearAutomatico,
      modo_observacao: modoObsAtivo,
      motivo_bloqueio: bloquearAutomatico ? "Bloqueado pelo intervalo de seguranca ou modo observacao." : null,
      funil_analisado: {
        convertido_status: funil.convertidoStatus,
        convertido_label: funil.convertidoLabel,
        pre_conversao_status: funil.preStatus,
        pre_conversao_label: funil.preStatusLabel,
      },
      comparativo_mes: {
        revendedoras_mes: revsMes,
        revendedoras_mes_anterior: prevMonthRevs,
        trafego_revendedoras_mes: currentMonthTrafficRevs,
        trafego_revendedoras_mes_anterior: prevMonthTrafficRevs,
        cpr_mes: round(cprMes),
        cpr_mes_anterior: round(cprMesAnterior),
        cpl_mes: round(metaMes.cpl),
        cpl_mes_anterior: round(metaMesAnterior.cpl),
        variacao_cpr_pct: round(deltaCpr),
        variacao_cpl_pct: round(deltaCpl),
      },
      campanha_mestre: campanhaMestre,
      melhores_publicos: campaigns.flatMap((c) => c.adsets.map((a) => ({ campanha_nome: c.name, nome: a.name, gasto: round(a.spend), leads: a.leads_api, revendedoras: a.crm_revs, cpl: round(a.cpl), cpr: round(a.cpr) }))).sort((a, b) => b.revendedoras - a.revendedoras || a.cpl - b.cpl).slice(0, 5),
      melhores_criativos: campaigns.flatMap((c) => c.ads.map((a) => ({ campanha_nome: c.name, nome: a.name, id: a.id, thumbnail_url: a.thumbnail_url, gasto: round(a.spend), leads: a.leads_api, cpl: round(a.cpl), ctr: Number(a.ctr.toFixed(2)) }))).sort((a, b) => b.leads - a.leads || a.cpl - b.cpl).slice(0, 5),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    let orgIds: string[] = [];
    if (body.org_id) {
      orgIds = [body.org_id];
    } else {
      const res = await rest("organizations?select=id&ravena_ativa=eq.true&limit=200");
      const orgs = await res.json();
      orgIds = (orgs || []).map((o: any) => o.id);
    }

    const resultados: any[] = [];
    for (const orgId of orgIds) {
      try {
        const result = await analisarOrg(orgId);
        if (result.skip) {
          resultados.push({ orgId, status: "pulado", motivo: result.motivo });
          continue;
        }

        const saveRes = await rest("ai_optimization_logs", {
          method: "POST",
          body: JSON.stringify(result.log),
          headers: { ...dbH, Prefer: "return=representation" },
        });
        const saved = await saveRes.json();
        if (!saveRes.ok) throw new Error(JSON.stringify(saved));
        resultados.push({
          orgId,
          status: result.log.status,
          log_id: saved?.[0]?.id,
          acoes_sugeridas: result.log.acoes_sugeridas.length,
        });
      } catch (err) {
        console.error(`[otimizar] Erro org=${orgId}:`, String(err));
        resultados.push({ orgId, status: "erro", erro: String(err) });
      }
    }

    return new Response(JSON.stringify({ ok: true, resultados }), { status: 200, headers: CORS });
  } catch (err) {
    console.error("[otimizar] erro geral:", String(err));
    return new Response(JSON.stringify({ ok: false, erro: String(err) }), { status: 500, headers: CORS });
  }
});



