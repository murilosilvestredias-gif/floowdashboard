import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { useAppStore } from '@/stores/appStore';
import { useTheme } from '@/hooks/useTheme';
import { useMetaConfig } from '@/hooks/useMetaConfig';
import { useOrgId } from '@/hooks/useOrgId';
import { useTerminology, useModeloNegocio } from '@/hooks/useTerminology';
import { useStatusConfig } from '@/hooks/useStatusConfig';
import { TrendingUp, TrendingDown, Activity, Pause, AlertTriangle, X, DollarSign, Users, RefreshCw, Zap, ChevronDown, ChevronUp, Lightbulb, Edit2, Copy, ExternalLink, Settings, Folder, LayoutGrid, Monitor, ArrowUp, ArrowDown, Trash2, Info, Smartphone, Search, ChevronRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList } from 'recharts';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { getMetaCache, setMetaCache } from '@/lib/metaCache';
import { createPortal } from 'react-dom';
import { usePlanFeatures } from '@/hooks/usePlanFeatures';

interface AdSet {
  id: string; name: string; status: string;
  spend: number; impressions: number; clicks: number; ctr: number; leads_api: number; cpl: number;
  daily_budget?: number; lifetime_budget?: number;
  ads?: Ad[];
}
interface Ad {
  id: string; name: string; status: string;
  spend: number; leads_api: number; cpl: number; ctr: number; thumbnail_url: string | null;
}
interface Campaign {
  id: string; name: string; status: string;
  spend: number; impressions: number; clicks: number; ctr: number; cpm: number;
  leads_api: number; cpl?: number; daily_budget?: number; lifetime_budget?: number;
  created_time?: string;
  adsets?: AdSet[]; ads?: Ad[];
}


const LEAD_ACTIONS = ['lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_grouped'];
const BECKER_ORG_ID = '81b1ba7b-5c03-45c5-a74a-6ea8eb3432ae';

// Retorna a data em que um lead foi movido para determinado status
function getStatusMovedAt(lead: any, status: number): string | null {
  switch (status) {
    case 5: return lead.status_contrato_at || lead.ultimo_status_change || lead.created_at;
    case 3: return lead.status_aprovado_at  || lead.ultimo_status_change || lead.created_at;
    case 2: return lead.status_reuniao_at   || lead.ultimo_status_change || lead.created_at;
    default: return lead.ultimo_status_change || lead.created_at;
  }
}

// Filtra leads que foram MOVIDOS para o status no período selecionado
function filterPotenciaisByPreset(leads: any[], status: number, preset: string): any[] {
  const today = todayBRCamp();
  const ok = (ref: string | null | undefined, a: string, b: string) => {
    const d = leadDateBRCamp(ref);
    return !!d && d >= a && d <= b;
  };
  return leads.filter(l => {
    if (Number(l.status) !== status) return false;
    const movedAt = getStatusMovedAt(l, status);
    switch (preset) {
      case 'today':      return ok(movedAt, today, today);
      case 'yesterday':  { const y = subDaysCamp(today, 1); return ok(movedAt, y, y); }
      case 'last_7d':    return ok(movedAt, subDaysCamp(today, 6), today);
      case 'last_30d':   return ok(movedAt, subDaysCamp(today, 29), today);
      case 'this_month': return ok(movedAt, today.slice(0,7)+'-01', today);
      default: return true;
    }
  });
}

// ── Score inteligente por campanha (0-100) ────────────────────
function calcScore(
  r: { id: string; leads: number; rev: number; cpl: number; cpr: number; spend: number },
  allRows: { id: string; leads: number; rev: number; cpl: number; cpr: number; spend: number }[],
  allCampLeadsMap: Map<string, any[]>,
  _campRevsMap: Map<string, any[]>,
  _datePreset: string,
  preConvertidoStatus: number | null = null,
  potenciaisOverride?: number
): number {
  // Usa allCampLeadsMap (todos os leads, sem filtro de período) para calcular idade real
  const campLeads = allCampLeadsMap.get(r.id) || [];
  const oldest = campLeads.length > 0
    ? Math.min(...campLeads.map(l => new Date((l as any).created_at || Date.now()).getTime()))
    : 0;
  const ageDays = (Date.now() - oldest) / (1000 * 60 * 60 * 24);
  const isNew = ageDays < 3;
  const potenciais = potenciaisOverride !== undefined
    ? potenciaisOverride
    : (preConvertidoStatus != null
        ? campLeads.filter(l => Number((l as any).status) === preConvertidoStatus).length
        : 0);

  const maxRevs = Math.max(...allRows.map(x => x.rev), 1);
  const comCPR = allRows.filter(x => x.cpr > 0);
  const mediaCPR = comCPR.length > 0 ? comCPR.reduce((s, x) => s + x.cpr, 0) / comCPR.length : 0;
  const comCPL = allRows.filter(x => x.cpl > 0);
  const mediaCPL = comCPL.length > 0 ? comCPL.reduce((s, x) => s + x.cpl, 0) / comCPL.length : 0;

  let score = 0;

  // BLOCO 1: Revendedoras — peso 45
  score += Math.round((r.rev / maxRevs) * 45);

  // BLOCO 2: CPR — peso 35
  if (r.cpr > 0 && mediaCPR > 0) {
    const ratio = r.cpr / mediaCPR;
    if (ratio <= 0.5)       score += 35;
    else if (ratio <= 0.7)  score += 28;
    else if (ratio <= 0.9)  score += 21;
    else if (ratio <= 1.1)  score += 14;
    else if (ratio <= 1.4)  score += 5;
    else if (ratio <= 1.8)  score -= 4;
    else                    score -= 10;
  } else if (r.rev === 0 && !isNew) {
    score -= 10; // penalidade campanha antiga sem revendedoras
  }

  // BLOCO 3: CPL — peso 10
  if (mediaCPL > 0 && r.cpl > 0) {
    const ratio = r.cpl / mediaCPL;
    if (ratio <= 0.7)      score += 10;
    else if (ratio <= 1.0) score += 6;
    else if (ratio <= 1.3) score += 2;
    else if (ratio > 1.5)  score -= 2;
  }

  // BLOCO 4: Potenciais — peso 8
  score += Math.min(potenciais * 2, 8);

  // BLOCO 5: Volume de leads — peso 5
  const maxLeads = Math.max(...allRows.map(x => x.leads), 1);
  score += Math.round((r.leads / maxLeads) * 5);

  // Campanha nova: congela score entre 35-50
  if (isNew) {
    const newBase = 35 + Math.min(potenciais * 3, 10) + (r.leads >= 5 ? 5 : 0);
    return Math.min(50, Math.max(35, newBase));
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreColor(score: number): string {
  if (score >= 88) return '#059669';
  if (score >= 75) return '#10b981';
  if (score >= 62) return '#34d399';
  if (score >= 50) return '#fbbf24';
  if (score >= 38) return '#f97316';
  if (score >= 25) return '#ef4444';
  return '#b91c1c';
}

function scoreColorSolid(score: number): string {
  if (score >= 90) return '#059669';
  if (score >= 75) return '#10b981';
  if (score >= 62) return '#34d399';
  if (score >= 50) return '#fbbf24';
  if (score >= 38) return '#f97316';
  if (score >= 25) return '#ef4444';
  return '#b91c1c';
}

function scoreLabel(score: number, isNew?: boolean): string {
  if (isNew) return 'Aguardando dados';
  if (score >= 75) return 'Escalar';
  if (score >= 50) return 'Monitorar';
  if (score >= 38) return 'Otimizar';
  return 'Atenção';
}

type ScoreCriterio = { icon: string; label: string; detalhe: string; pts: number };

function gerarCriterios(
  r: { id: string; leads: number; rev: number; cpl: number; cpr: number; spend: number },
  allRows: { id: string; leads: number; rev: number; cpl: number; cpr: number; spend: number }[],
  mediaCPR: number,
  mediaCPL: number,
  isNew: boolean,
  potenciais: number,
  term: { convertidoPlural: string; convertidoCurto: string; custoConversaoSigla: string }
): ScoreCriterio[] {
  const crit: ScoreCriterio[] = [];
  const maxRevs = Math.max(...allRows.map(x => x.rev), 1);

  const revsScore = Math.round((r.rev / maxRevs) * 45);
  const revsLabel = revsScore < 15 ? 'Baixo' : revsScore < 32 ? 'Médio' : 'Excelente';
  crit.push({ icon: '👑', label: term.convertidoPlural, detalhe: `${r.rev} ${term.convertidoCurto} — ${revsLabel}`, pts: revsScore });

  let cprScore = 0; let cprDetalhe = '—';
  if (r.cpr > 0 && mediaCPR > 0) {
    const ratio = r.cpr / mediaCPR;
    if (ratio <= 0.5)      { cprScore = 35; cprDetalhe = `R$ ${Math.round(r.cpr)} — 50%+ abaixo da média`; }
    else if (ratio <= 0.7) { cprScore = 28; cprDetalhe = `R$ ${Math.round(r.cpr)} — muito abaixo da média`; }
    else if (ratio <= 0.9) { cprScore = 21; cprDetalhe = `R$ ${Math.round(r.cpr)} — abaixo da média`; }
    else if (ratio <= 1.1) { cprScore = 14; cprDetalhe = `R$ ${Math.round(r.cpr)} — na média (R$ ${Math.round(mediaCPR)})`; }
    else if (ratio <= 1.4) { cprScore = 5;  cprDetalhe = `R$ ${Math.round(r.cpr)} — acima da média`; }
    else if (ratio <= 1.8) { cprScore = -4; cprDetalhe = `R$ ${Math.round(r.cpr)} — 40%+ acima da média`; }
    else                   { cprScore = -10; cprDetalhe = `R$ ${Math.round(r.cpr)} — muito acima da média`; }
  } else if (r.rev === 0 && !isNew) {
    cprScore = -10; cprDetalhe = `Sem ${term.convertidoPlural} no período`;
  } else {
    cprDetalhe = isNew ? 'Aguardando dados' : 'Sem conversões';
  }
  crit.push({ icon: '💰', label: `Custo por ${term.convertidoCurto.toUpperCase()} (${term.custoConversaoSigla})`, detalhe: cprDetalhe, pts: cprScore });

  // CPL
  let cplScore = 0; let cplDetalhe = '—';
  if (mediaCPL > 0 && r.cpl > 0) {
    const ratio = r.cpl / mediaCPL;
    if (ratio <= 0.7)      { cplScore = 10; cplDetalhe = `R$ ${Math.round(r.cpl)} — ótimo`; }
    else if (ratio <= 1.0) { cplScore = 6;  cplDetalhe = `R$ ${Math.round(r.cpl)} — bom`; }
    else if (ratio <= 1.3) { cplScore = 2;  cplDetalhe = `R$ ${Math.round(r.cpl)} — acima da média`; }
    else                   { cplScore = -2; cplDetalhe = `R$ ${Math.round(r.cpl)} — alto`; }
  }
  crit.push({ icon: '📊', label: 'Custo por Lead (CPL)', detalhe: cplDetalhe, pts: cplScore });

  // Potenciais
  const potScore = Math.min(potenciais * 2, 8);
  crit.push({ icon: '⭐', label: 'Leads potenciais', detalhe: `${potenciais} lead${potenciais !== 1 ? 's' : ''} em triagem/reunião`, pts: potScore });

  // Volume
  const maxLeads = Math.max(...allRows.map(x => x.leads), 1);
  const volScore = Math.round((r.leads / maxLeads) * 5);
  crit.push({ icon: '📈', label: 'Volume de leads', detalhe: `${r.leads} leads no período`, pts: volScore });

  if (isNew) {
    crit.push({ icon: '🆕', label: 'Campanha nova', detalhe: 'Score congelado — menos de 3 dias de dados', pts: 0 });
  }

  return crit;
}

const PERIOD_OPTIONS = [
  { label:'Hoje',      value:'today' },
  { label:'Ontem',     value:'yesterday' },
  { label:'7 dias',   value:'last_7d' },
  { label:'30 dias',  value:'last_30d' },
  { label:'Este mês', value:'this_month' },
];

const PERIOD_MAP: Record<string,string> = {
  today:'today', yesterday:'yesterday', last_7d:'7days', last_30d:'30days', this_month:'month',
};


function fmt(n: number) { return n.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtInt(n: number) { return n.toLocaleString('pt-BR'); }
function getLeads(actions: any[]) { return parseInt(actions?.find((a:any)=>LEAD_ACTIONS.includes(a.action_type))?.value||'0'); }

// ── Datas Brasília ────────────────────────────────────────────
function parseLeadDateCamp(str?: string|null): Date {
  if (!str) return new Date(0);
  if (typeof str !== 'string') return new Date(0);
  if (str.includes('T')) {
    const cleaned = str.replace(/(\.\d{3})\d+/, '$1');
    return new Date(cleaned);
  }
  if (/^\d{4}-\d{2}-\d{2} /.test(str)) {
    const cleaned = str.replace(' ', 'T').replace('+00:00', 'Z').replace('+00', 'Z').replace(/(\.\d{3})\d+/, '$1');
    return new Date(cleaned);
  }
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{2})?:?(\d{2})?/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0'] = m;
    return new Date(`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi.padStart(2,'0')}:00-03:00`);
  }
  return new Date(str.replace(/(\.\d{3})\d+/, '$1'));
}
function leadDateBRCamp(str?: string|null): string {
  try {
    const d=parseLeadDateCamp(str);
    if(!d || isNaN(d.getTime()) || d.getTime()===0) return '';
    // UTC-3 fixo (Brasil), independente do fuso do browser
    const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return br.toISOString().slice(0, 10);
  } catch { return ''; }
}
function todayBRCamp(): string {
  try {
    const d = new Date();
    // UTC-3 fixo
    const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return br.toISOString().slice(0, 10);
  } catch { return new Date().toISOString().slice(0, 10); }
}
function subDaysCamp(s:string,n:number): string {
  try { const d=new Date(s+'T12:00:00Z'); if(isNaN(d.getTime()))return s; d.setUTCDate(d.getUTCDate()-n); return d.toISOString().slice(0,10); } catch { return s; }
}
function filterLeadsByPreset(leads: any[], preset: string) {
  const today = todayBRCamp();
  const ok = (l: any, a: string, b: string) => {
    // Leads: usa created_at — quando o lead ENTROU via tráfego
    const ref = l.created_at;
    const d = leadDateBRCamp(ref);
    return !!d && d >= a && d <= b;
  };
  switch(preset) {
    case 'today':      return leads.filter(l => ok(l, today, today));
    case 'yesterday':  { const y = subDaysCamp(today, 1); return leads.filter(l => ok(l, y, y)); }
    case 'last_7d':    return leads.filter(l => ok(l, subDaysCamp(today, 6), today));
    case 'last_30d':   return leads.filter(l => ok(l, subDaysCamp(today, 29), today));
    case 'this_month': return leads.filter(l => ok(l, today.slice(0,7)+'-01', today));
    default: return leads;
  }
}

// Returns true if the lead should be counted as paid-traffic origin.
function isPaidTraffic(la: any): boolean {
  const src = (la.utm_source || '').trim();
  const camp = (la.utm_campaign || '').trim();
  const srcNorm = src.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  
  if (srcNorm.includes('INDICAC')) return false;
  if (camp.length > 0) return true;
  if (src.toLowerCase().includes('fbclid')) return true;
  if (la.fbclid && String(la.fbclid).trim().length > 0) return true;
  
  if (srcNorm) {
    const seg = srcNorm.split('|')[0].trim();
    const isMeta = (s: string) =>
      ['FB', 'FACEBOOK', 'IG', 'INSTAGRAM', 'META', 'IG_BOOST', 'CAMPANHA'].includes(s)
      || s.startsWith('FB') || s.includes('TRAFEGO') || s.includes('PAGO');
    if (isMeta(srcNorm) || isMeta(seg)) return true;
  }
  
  if ((la.utm_medium || '').trim()) return true;
  if ((la.utm_content || '').trim()) return true;
  if ((la.utm_term || '').trim()) return true;
  
  return false;
}

// Clean and check if two campaign names are matching
function matchCampaignName(utmCampaign: string, metaCampaignName: string): boolean {
  const clean = (name: string) => {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*-\s*\[cbo\]/gi, '')
      .replace(/\s*-\s*\[abo\]/gi, '')
      .replace(/\s*\[leads?\]/gi, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const utmClean = clean(utmCampaign);
  const metaClean = clean(metaCampaignName);

  if (!utmClean || !metaClean) return false;
  if (utmClean === metaClean) return true;
  if (metaClean.includes(utmClean) || utmClean.includes(metaClean)) return true;

  if (utmClean.length >= 6 && metaClean.includes(utmClean.slice(0, 20))) return true;
  if (metaClean.length >= 6 && utmClean.includes(metaClean.slice(0, 20))) return true;

  return false;
}

// ── Fetch campanhas ───────────────────────────────────────────
async function fetchCampaignsWithChildren(datePreset: string, token: string, account: string): Promise<Campaign[]> {
  const tok = token; const base = 'https://graph.facebook.com/v18.0'; const dp = datePreset;
  if (!tok || !account) return [];
  function getLeadsFromActions(actions: any[]) {
    return parseInt(actions?.find((a: any) => LEAD_ACTIONS.includes(a.action_type))?.value || '0');
  }
  try {
    const campUrl = new URL(`${base}/act_${account}/campaigns`);
    campUrl.searchParams.set('fields', `id,name,status,daily_budget,lifetime_budget,created_time,insights.date_preset(${dp}){spend,impressions,clicks,ctr,cpm,actions}`);
    campUrl.searchParams.set('limit', '50');
    campUrl.searchParams.set('access_token', tok);
    const campData = await (await fetch(campUrl.toString())).json();
    if (!campData.data?.length) return [];

    const asUrl = new URL(`${base}/act_${account}/adsets`);
    asUrl.searchParams.set('fields', `id,name,status,campaign_id,daily_budget,lifetime_budget,insights.date_preset(${dp}){spend,impressions,clicks,ctr,actions}`);
    asUrl.searchParams.set('limit', '200');
    asUrl.searchParams.set('access_token', tok);
    const asData = await (await fetch(asUrl.toString())).json();
    const adUrl = new URL(`${base}/act_${account}/ads`);
    adUrl.searchParams.set('fields', `id,name,status,campaign_id,adset_id,creative{thumbnail_url},insights.date_preset(${dp}){spend,ctr,actions}`);
    adUrl.searchParams.set('limit', '500');
    adUrl.searchParams.set('access_token', tok);
    const adData = await (await fetch(adUrl.toString())).json();
    const adsetsByCampaign: Record<string, AdSet[]> = {};
    for (const as of (asData.data || []) as any[]) {
      const cid = as.campaign_id; if (!cid) continue;
      if (!adsetsByCampaign[cid]) adsetsByCampaign[cid] = [];
      const ins = as.insights?.data?.[0];
      const spend = parseFloat(ins?.spend || '0');
      const leads = getLeadsFromActions(ins?.actions || []);
      adsetsByCampaign[cid].push({
        id: as.id, name: as.name, status: as.status, spend,
        impressions: parseInt(ins?.impressions || '0'),
        clicks: parseInt(ins?.clicks || '0'),
        ctr: parseFloat(ins?.ctr || '0'),
        leads_api: leads, cpl: leads > 0 ? spend / leads : 0,
        daily_budget: as.daily_budget ? parseInt(as.daily_budget) / 100 : undefined,
        lifetime_budget: as.lifetime_budget ? parseInt(as.lifetime_budget) / 100 : undefined,
      });
    }

    const adsByCampaign: Record<string, Ad[]> = {};
    const adsByAdset: Record<string, Ad[]> = {};
    for (const ad of (adData.data || []) as any[]) {
      const cid = ad.campaign_id; if (!cid) continue;
      if (!adsByCampaign[cid]) adsByCampaign[cid] = [];
      const ins = ad.insights?.data?.[0];
      const spend = parseFloat(ins?.spend || '0');
      const leads = getLeadsFromActions(ins?.actions || []);
      const adObj: Ad = { id: ad.id, name: ad.name, status: ad.status, spend, leads_api: leads, cpl: leads > 0 ? spend / leads : 0, ctr: parseFloat(ins?.ctr || '0'), thumbnail_url: ad.creative?.thumbnail_url || null };
      adsByCampaign[cid].push(adObj);
      const asid = ad.adset_id;
      if (asid) { if (!adsByAdset[asid]) adsByAdset[asid] = []; adsByAdset[asid].push(adObj); }
    }

    const results: Campaign[] = [];
    for (const c of campData.data as any[]) {
      const ins = c.insights?.data?.[0];
      const spend = parseFloat(ins?.spend || '0');
      const leadsApi = getLeadsFromActions(ins?.actions || []);
      const adsets = (adsetsByCampaign[c.id] || [])
        .map(as => ({ ...as, ads: (adsByAdset[as.id] || []).sort((a, b) => b.leads_api - a.leads_api || (a.cpl || 999) - (b.cpl || 999)) }))
        .sort((a, b) => b.leads_api - a.leads_api || (a.cpl || 999) - (b.cpl || 999));
      const ads = (adsByCampaign[c.id] || []).sort((a, b) => b.leads_api - a.leads_api || (a.cpl || 999) - (b.cpl || 999));

      const leadsFromAdsets = adsets.reduce((sum, as) => sum + as.leads_api, 0);

      results.push({
        id: c.id, name: c.name, status: c.status, spend,
        impressions: parseInt(ins?.impressions || '0'),
        clicks: parseInt(ins?.clicks || '0'),
        ctr: parseFloat(ins?.ctr || '0'),
        cpm: parseFloat(ins?.cpm || '0'),
        leads_api: leadsApi,
        cpl: leadsApi > 0 ? spend / leadsApi : 0,
        daily_budget: c.daily_budget ? parseInt(c.daily_budget) / 100 : undefined,
        lifetime_budget: c.lifetime_budget ? parseInt(c.lifetime_budget) / 100 : undefined,
        created_time: c.created_time,
        adsets, ads,
      });
    }
    return results
      .filter(c => c.spend > 0 || c.status === 'ACTIVE')
      .sort((a, b) => b.leads_api - a.leads_api || (a.cpl || 999) - (b.cpl || 999) || b.spend - a.spend);
  } catch (e) { console.error('[FETCH] Erro:', e); return []; }
}


function FilterDropdown({value,options,onChange,dark}:{value:string;options:{label:string;value:string}[];onChange:(v:string)=>void;dark:boolean}){
  const[open,setOpen]=useState(false);const[pos,setPos]=useState({top:0,left:0,width:180});const btnRef=useRef<HTMLButtonElement>(null);const sel=options.find(o=>o.value===value);
  function handleOpen(){if(btnRef.current){const r=btnRef.current.getBoundingClientRect();const mw=180;let left=r.right-mw;if(left<8)left=8;if(left+mw>window.innerWidth-8)left=window.innerWidth-mw-8;setPos({top:r.bottom+6,left,width:mw});}setOpen(v=>!v);}
  return(<div style={{position:'relative'}}><button ref={btnRef} onClick={handleOpen} style={{display:'flex',alignItems:'center',gap:'6px',padding:'8px 14px',borderRadius:'10px',border:`1px solid ${dark?'#1e1e22':'#e5e7eb'}`,background:dark?'#111113':'#fff',color:dark?'#d4d4d8':'#374151',fontSize:'13px',cursor:'pointer',fontFamily:'inherit'}}>{sel?.label}<ChevronDown style={{width:'14px',height:'14px',transform:open?'rotate(180deg)':'',transition:'transform 0.18s'}}/></button>{open&&(<><div onClick={()=>setOpen(false)} style={{position:'fixed',inset:0,zIndex:9998}}/><div style={{position:'fixed',top:pos.top,left:pos.left,width:pos.width,background:dark?'#111113':'#fff',border:`1px solid ${dark?'#1e1e22':'#e5e7eb'}`,borderRadius:'10px',padding:'4px',zIndex:9999,boxShadow:dark?'0 8px 32px rgba(0,0,0,0.5)':'0 8px 24px rgba(0,0,0,0.1)'}}>{options.map(o=>(<button key={o.value} onClick={()=>{onChange(o.value);setOpen(false);}} style={{width:'100%',padding:'7px 10px',borderRadius:'7px',border:'none',background:value===o.value?(dark?'rgba(255,255,255,0.08)':'#eff6ff'):'transparent',color:value===o.value?(dark?'#60a5fa':'#2563eb'):(dark?'#a1a1aa':'#374151'),fontSize:'13px',cursor:'pointer',textAlign:'left',fontFamily:'inherit'}}>{o.label}</button>))}</div></>)}</div>);
}

function Thumbnail({url,name,size=36}:{url:string|null;name:string;size?:number}){
  const[err,setErr]=useState(false);const initials=name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';const colors=['#3b82f6','#8b5cf6','#f97316','#10b981','#f59e0b','#ec4899'];const color=colors[name.charCodeAt(0)%colors.length];
  if(!url||err)return<div style={{width:size,height:size,borderRadius:'6px',background:color+'22',border:`1px solid ${color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:size>40?'12px':'9px',fontWeight:700,color,flexShrink:0}}>{initials}</div>;
  return<img src={url} alt={name} onError={()=>setErr(true)} style={{width:size,height:size,borderRadius:'6px',objectFit:'cover',flexShrink:0,border:'1px solid rgba(0,0,0,0.08)'}}/>;
}

const AVAILABLE_COLUMNS = [
  { key: 'status', label: 'Status' },
  { key: 'name', label: 'Nome' },
  { key: 'budget', label: 'Orçamento' },
  { key: 'spend', label: 'Gasto' },
  { key: 'impressions', label: 'Impressões' },
  { key: 'clicks', label: 'Cliques' },
  { key: 'ctr', label: 'CTR' },
  { key: 'cpm', label: 'CPM' },
  { key: 'leads', label: 'Leads' },
  { key: 'cpl', label: 'CPL' },
  { key: 'rev', label: 'Rev' },
  { key: 'cpr', label: 'CPR' }, // labels overridden at render time with terminology
  { key: 'score', label: 'Score' },
] as const;
type ColKey = typeof AVAILABLE_COLUMNS[number]['key'];

function TooltipIcon({ text, dark }: { text: string; dark: boolean }) {
  const [pos, setPos] = useState<{top:number;left:number}|null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      onMouseEnter={() => {
        if (ref.current) {
          const r = ref.current.getBoundingClientRect();
          setPos({ top: r.top + window.scrollY, left: r.left + r.width / 2 + window.scrollX });
        }
      }}
      onMouseLeave={() => setPos(null)}
      style={{display:'inline-flex',alignItems:'center',marginLeft:'6px',flexShrink:0,cursor:'help',userSelect:'none',lineHeight:1}}
    >
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        border: `1.2px solid ${dark ? '#71717a' : '#9ca3af'}`,
        fontSize: '9px',
        fontWeight: 'bold',
        fontFamily: 'serif',
        lineHeight: 1,
        textAlign: 'center',
        color: dark ? '#a1a1aa' : '#6b7280',
        userSelect: 'none',
        flexShrink: 0,
      }}>
        i
      </span>
      {pos && createPortal(
        <div className="tooltip-premium" style={{
          position:'absolute',
          top: pos.top - 8,
          left: Math.max(130, Math.min(window.innerWidth - 130, pos.left)),
          transform: 'translateX(-50%) translateY(-100%)',
          fontSize: '11.5px',
          fontWeight: 400,
          padding: '8px 12px',
          borderRadius: '8px',
          width: '240px',
          whiteSpace: 'normal',
          textAlign: 'center',
          zIndex: 999999,
          pointerEvents: 'none',
          boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.15)',
          lineHeight: 1.5,
          background: dark ? '#1e1e24' : '#ffffff',
          color: dark ? '#f4f4f5' : '#1f2937',
          border: `1px solid ${dark ? '#2e2e38' : '#e5e7eb'}`,
        }}>
          {text}
          <div style={{
            position: 'absolute',
            top: '100%',
            left: `${Math.min(90, Math.max(10, ((pos.left - Math.max(130, Math.min(window.innerWidth - 130, pos.left))) / 240) * 100 + 50))}%`,
            transform: 'translateX(-50%)',
            borderWidth: '6px',
            borderStyle: 'solid',
            borderColor: `${dark ? '#1e1e24' : '#ffffff'} transparent transparent transparent`,
          }}/>
          {!dark && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: `${Math.min(90, Math.max(10, ((pos.left - Math.max(130, Math.min(window.innerWidth - 130, pos.left))) / 240) * 100 + 50))}%`,
              transform: 'translateX(-50%)',
              borderWidth: '7px',
              borderStyle: 'solid',
              borderColor: '#e5e7eb transparent transparent transparent',
              zIndex: -1,
            }}/>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}

// ── Distribui `total` inteiros entre N itens usando maior resto ────────────
// Garante que sum(resultado) === total e nunca perde leads por Math.round.
function distributeProportional(total: number, weights: number[]): number[] {
  if (!total || !weights.length) return weights.map(() => 0);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) {
    const base = Math.floor(total / weights.length);
    const rem = total - base * weights.length;
    return weights.map((_, i) => base + (i < rem ? 1 : 0));
  }
  const exact = weights.map(w => (w / sum) * total);
  const floored = exact.map(Math.floor);
  let rem = total - floored.reduce((s, v) => s + v, 0);
  exact.map((v, i) => ({ diff: v - floored[i], i }))
    .sort((a, b) => b.diff - a.diff)
    .slice(0, rem)
    .forEach(({ i }) => floored[i]++);
  return floored;
}

// ── Extrai adset e ad das UTMs de um lead ─────────────────────────────────
function extractUtmAdset(lead: any): { id: string; name: string } {
  const parts = (lead.utm_campaign || '').trim().split('|').map((p: string) => p.trim());
  if (parts.length >= 4 && (parts[3] || parts[2])) {
    return { id: parts[3] || '', name: parts[2].toLowerCase() };
  }
  const med = (lead.utm_medium || '').trim();
  if (med) {
    const mp = med.split('|').map((p: string) => p.trim());
    return { id: mp[1] || '', name: mp[0].toLowerCase() };
  }
  return { id: '', name: '' };
}

function extractUtmAd(lead: any): { id: string; name: string } {
  const parts = (lead.utm_campaign || '').trim().split('|').map((p: string) => p.trim());
  if (parts.length >= 6 && (parts[5] || parts[4])) {
    return { id: parts[5] || '', name: parts[4].toLowerCase() };
  }
  const cont = (lead.utm_content || '').trim();
  if (cont) {
    const cp = cont.split('|').map((p: string) => p.trim());
    return { id: cp[1] || '', name: cp[0].toLowerCase() };
  }
  return { id: '', name: '' };
}

// ── Distribui leads de uma campanha pelos adsets usando UTM direto + proporcional
function buildAdsetCounts(
  crmLeads: any[], crmRevs: any[], adsets: AdSet[]
): { leads: Map<string, number>; revs: Map<string, number> } {
  const leadsMap = new Map<string, number>(adsets.map(as => [as.id, 0]));
  const revsMap  = new Map<string, number>(adsets.map(as => [as.id, 0]));
  if (!adsets.length) return { leads: leadsMap, revs: revsMap };

  const matchAdset = (lead: any): AdSet | null => {
    const { id, name } = extractUtmAdset(lead);
    if (id) { const a = adsets.find(as => as.id === id); if (a) return a; }
    if (name) { const a = adsets.find(as => as.name.toLowerCase().trim() === name); if (a) return a; }
    return null;
  };

  let unmatched = 0, unmatchedRevs = 0;
  for (const l of crmLeads) {
    const t = matchAdset(l);
    if (t) leadsMap.set(t.id, (leadsMap.get(t.id) || 0) + 1);
    else unmatched++;
  }
  for (const l of crmRevs) {
    const t = matchAdset(l);
    if (t) revsMap.set(t.id, (revsMap.get(t.id) || 0) + 1);
    else unmatchedRevs++;
  }

  if (unmatched > 0 || unmatchedRevs > 0) {
    const apiTotal = adsets.reduce((s, as) => s + as.leads_api, 0);
    const weights = apiTotal > 0 ? adsets.map(as => as.leads_api) : adsets.map(() => 1);
    if (unmatched > 0) {
      const dist = distributeProportional(unmatched, weights);
      adsets.forEach((as, i) => leadsMap.set(as.id, (leadsMap.get(as.id) || 0) + dist[i]));
    }
    if (unmatchedRevs > 0) {
      const dist = distributeProportional(unmatchedRevs, weights);
      adsets.forEach((as, i) => revsMap.set(as.id, (revsMap.get(as.id) || 0) + dist[i]));
    }
  }
  return { leads: leadsMap, revs: revsMap };
}

// ── Distribui leads de uma campanha pelos ads usando UTM direto + proporcional
function buildAdCounts(
  crmLeads: any[], crmRevs: any[], ads: Ad[]
): { leads: Map<string, number>; revs: Map<string, number> } {
  const leadsMap = new Map<string, number>(ads.map(ad => [ad.id, 0]));
  const revsMap  = new Map<string, number>(ads.map(ad => [ad.id, 0]));
  if (!ads.length) return { leads: leadsMap, revs: revsMap };

  const matchAd = (lead: any): Ad | null => {
    const { id, name } = extractUtmAd(lead);
    if (id) { const a = ads.find(ad => ad.id === id); if (a) return a; }
    if (name) { const a = ads.find(ad => ad.name.toLowerCase().trim() === name); if (a) return a; }
    return null;
  };

  let unmatched = 0, unmatchedRevs = 0;
  for (const l of crmLeads) {
    const t = matchAd(l);
    if (t) leadsMap.set(t.id, (leadsMap.get(t.id) || 0) + 1);
    else unmatched++;
  }
  for (const l of crmRevs) {
    const t = matchAd(l);
    if (t) revsMap.set(t.id, (revsMap.get(t.id) || 0) + 1);
    else unmatchedRevs++;
  }

  if (unmatched > 0 || unmatchedRevs > 0) {
    const apiTotal = ads.reduce((s, ad) => s + ad.leads_api, 0);
    const weights = apiTotal > 0 ? ads.map(ad => ad.leads_api) : ads.map(() => 1);
    if (unmatched > 0) {
      const dist = distributeProportional(unmatched, weights);
      ads.forEach((ad, i) => leadsMap.set(ad.id, (leadsMap.get(ad.id) || 0) + dist[i]));
    }
    if (unmatchedRevs > 0) {
      const dist = distributeProportional(unmatchedRevs, weights);
      ads.forEach((ad, i) => revsMap.set(ad.id, (revsMap.get(ad.id) || 0) + dist[i]));
    }
  }
  return { leads: leadsMap, revs: revsMap };
}

export default function CampanhasPage() {
  const { leads } = useAppStore();
  const { theme } = useTheme();
  const { metaToken, metaAccount, ready: metaReady } = useMetaConfig();
  const { orgId, ready: orgReady } = useOrgId();
  const t = useTerminology();
  const modelo = useModeloNegocio();
  const { config: statusConfig } = useStatusConfig(modelo);
  const dark = theme === 'dark';
  const { features, loading: planLoading } = usePlanFeatures();
  const ravenaDesbotada = !planLoading && !features.ravena;
  const semToken = metaReady && (!metaToken || !metaAccount);
  const navigate = useNavigate();
  const _initCampKey = orgId ? `meta_camp_${orgId}_today` : null;
  const _initCampCached = _initCampKey ? getMetaCache(_initCampKey) : null;
  const [campaigns, setCampaigns] = useState<Campaign[]>(_initCampCached || []);
  const [loading, setLoading] = useState(!_initCampCached && !!metaToken);
  const [error, setError] = useState(false);
  const [datePreset, setDatePreset] = useState('today');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeLevel, setActiveLevel] = useState<'campanhas'|'conjuntos'|'anuncios'>('campanhas');
  const [selectedCampIds, setSelectedCampIds] = useState<Set<string>>(new Set());
  const [selectedAdsetIds, setSelectedAdsetIds] = useState<Set<string>>(new Set());
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(new Set());
  const [editingBudget, setEditingBudget] = useState<{id:string;value:string;level:'campaign'|'adset'}|null>(null);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const DEFAULT_VISIBLE_COLS: ColKey[] = ['status','name','budget','spend','leads','cpl','rev','cpr','score'];
  const [visibleColumns, setVisibleColumns] = useState<ColKey[]>([...DEFAULT_VISIBLE_COLS]);
  const [orderedColumns, setOrderedColumns] = useState([...AVAILABLE_COLUMNS]);

  const [columnWidths, setColumnWidths] = useState<Record<ColKey, number>>({
    status: 90,
    name: 320,
    score: 130,
    budget: 120,
    spend: 120,
    impressions: 110,
    clicks: 90,
    ctr: 80,
    cpm: 90,
    leads: 100,
    cpl: 100,
    rev: 100,
    cpr: 100,
  });

  const columnWidthsRef = useRef(columnWidths);
  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  const startResize = useCallback((col: ColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = columnWidthsRef.current[col] || 80;
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = Math.max(60, startWidth + deltaX);
      setColumnWidths(prev => ({
        ...prev,
        [col]: newWidth
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const [toast, setToast] = useState<{msg:string;ok:boolean}|null>(null);
  const [lastLoadTime, setLastLoadTime] = useState<Date|null>(null);
  const [isMobile, setIsMobile] = useState(false);
  // Leads direto do Supabase com select('*') para garantir utm_campaign
  const [allLeads, setAllLeads] = useState<any[]>([]);
  const [aiLog, setAiLog] = useState<any>(null);
  const aiLogJustClearedRef = useRef(false);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [executandoOtimizacao, setExecutandoOtimizacao] = useState(false);
  const [metaRevsOrg, setMetaRevsOrg] = useState(0);
  const [gestorMode, setGestorMode] = useState(false);
  const [selectedCamp, setSelectedCamp] = useState<{
    r: { id: string; name: string; fullName: string; leads: number; rev: number; cpl: number; cpr: number; spend: number; score: number };
    isNew: boolean; potenciais: number; ageDays: number;
    criteria: ScoreCriterio[];
  } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{type:'duplicate'|'delete';count:number;label:string}|null>(null);
  const [togglingCampaigns, setTogglingCampaigns] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set());
  const [expandedAdsets, setExpandedAdsets] = useState<Set<string>>(new Set());
  const [ravenaAtivaNoBanco, setRavenaAtivaNoBanco] = useState<boolean | null>(null);
  const [ravenaPreConversionStatus, setRavenaPreConversionStatus] = useState<number | null>(null);

  useEffect(()=>{const check=()=>setIsMobile(window.innerWidth<768);check();window.addEventListener('resize',check);return()=>window.removeEventListener('resize',check);},[]);

  // Busca leads filtrados pelo período selecionado — garante cruzamento correto
  useEffect(()=>{
    if (!orgReady || !orgId) return;
    const today=todayBRCamp();
    let since:string|null=null;
    switch(datePreset){
      case 'today':     since=today+'T00:00:00-03:00'; break;
      case 'yesterday': since=subDaysCamp(today,1)+'T00:00:00-03:00'; break;
      case 'last_7d':   since=subDaysCamp(today,6)+'T00:00:00-03:00'; break;
      case 'last_30d':  since=subDaysCamp(today,29)+'T00:00:00-03:00'; break;
      case 'this_month':since=today.slice(0,7)+'-01T00:00:00-03:00'; break;
    }
    const fallback = since || (todayBRCamp().slice(0,7) + '-01T00:00:00-03:00');
    const fields = 'id,utm_campaign,utm_medium,utm_content,utm_source,status,created_at,status_aprovado_at,status_reuniao_at,status_contrato_at,ultimo_status_change';
    Promise.all([
      // Revendedoras com status_aprovado_at — data precisa de aprovação
      supabase.from('leads').select(fields).eq('org_id', orgId)
        .eq('status', 3).not('status_aprovado_at', 'is', null)
        .gte('status_aprovado_at', fallback)
        .order('status_aprovado_at', { ascending: false }).limit(500),
      // Revendedoras com ultimo_status_change mas sem status_aprovado_at
      supabase.from('leads').select(fields).eq('org_id', orgId)
        .eq('status', 3).is('status_aprovado_at', null)
        .not('ultimo_status_change', 'is', null)
        .gte('ultimo_status_change', fallback)
        .order('ultimo_status_change', { ascending: false }).limit(200),
      // Revendedoras sem nenhum campo de data — fallback created_at
      supabase.from('leads').select(fields).eq('org_id', orgId)
        .eq('status', 3).is('status_aprovado_at', null)
        .is('ultimo_status_change', null)
        .gte('created_at', fallback)
        .order('created_at', { ascending: false }).limit(200),
      // Todos os outros leads (não revendedoras) — por created_at
      supabase.from('leads').select(fields).eq('org_id', orgId)
        .neq('status', 3).gte('created_at', fallback)
        .order('created_at', { ascending: false }).limit(5000),
    ]).then(([{ data: d1 }, { data: d2 }, { data: d3 }, { data: d4 }]: any[]) => {
      const seen = new Set<string>();
      const combined: any[] = [];
      for (const l of [...(d1 || []), ...(d2 || []), ...(d3 || []), ...(d4 || [])]) {
        if (!seen.has(l.id)) { seen.add(l.id); combined.push(l); }
      }
      if (combined.length) setAllLeads(combined);
    });
  },[orgId, orgReady, datePreset]); // eslint-disable-line

  // Realtime: atualiza allLeads ao receber novos leads (filtrado por org)
  useEffect(()=>{
    if (!orgReady || !orgId) return;
    const ch = supabase.channel(`camp-leads-rt-${orgId}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'leads',filter:`org_id=eq.${orgId}`},p=>{
        setAllLeads(prev=>[p.new as any,...prev]);
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'leads',filter:`org_id=eq.${orgId}`},p=>{
        setAllLeads(prev=>prev.map(l=>l.id===(p.new as any).id?p.new as any:l));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  },[orgId, orgReady]); // eslint-disable-line

  // Resetar painel ao trocar de org
  useEffect(() => {
    setAiLog(null);
    setShowAiPanel(false);
  }, [orgId]);

  useEffect(()=>{
    if (!orgReady || !orgId) return;
    if (aiLogJustClearedRef.current) return;
    (async () => {
      const { data, error } = await (supabase as any)
        .from('ai_optimization_logs')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn('Erro ao buscar log da Ravena', error);
        setAiLog(null);
        return;
      }
      setAiLog(data || null);
    })();
  },[orgId, orgReady]); // eslint-disable-line

  // Busca meta de revendedoras da org para barra de progresso do painel Ravena
  useEffect(()=>{
    if (!orgReady || !orgId) return;
    supabase.from('organizations')
      .select('ravena_meta_revendedoras, ravena_pre_conversion_status')
      .eq('id', orgId)
      .single()
      .then(({ data }) => {
        if (data) {
          setMetaRevsOrg(Number((data as any).ravena_meta_revendedoras) || 0);
          const preStatus = Number((data as any).ravena_pre_conversion_status);
          setRavenaPreConversionStatus(Number.isFinite(preStatus) && preStatus > 0 ? preStatus : null);
        }
      });
  },[orgId, orgReady]); // eslint-disable-line

  useEffect(() => {
    if (!orgReady || !orgId) return;
    supabase
      .from('organizations')
      .select('ravena_ativa')
      .eq('id', orgId)
      .single()
      .then(({ data }) => {
        setRavenaAtivaNoBanco(data?.ravena_ativa === true);
      });
  }, [orgId, orgReady]); // eslint-disable-line

  const load=async()=>{if(!metaToken||!metaAccount){setLoading(false);return;}const key=`meta_camp_v2_${orgId}_${datePreset}`;setLoading(true);setError(false);const data=await fetchCampaignsWithChildren(datePreset,metaToken,metaAccount);if(data.length>0){setMetaCache(key,data);setCampaigns(data);}setLoading(false);setLastLoadTime(new Date());};
  useEffect(()=>{
    if (!metaReady || !orgReady) return;
    load();
  },[datePreset,metaToken,metaAccount,metaReady,orgReady,orgId]); // eslint-disable-line

  async function handleExecutarOtimizacao(logId: string) {
    setExecutandoOtimizacao(true);
    try {
      const res = await fetch('https://obguidmfvfjaekaskgob.functions.supabase.co/executar-otimizacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_id: logId }),
      });
      const data = await res.json();
      if (data.ok) {
        setAiLog((prev: any) => prev ? { ...prev, status: 'executado', acoes_executadas: data.acoes_executadas ?? [] } : prev);
        setToast({ msg: `${data.ok_count} ação${data.ok_count !== 1 ? 'ões' : ''} aplicada${data.ok_count !== 1 ? 's' : ''} com sucesso`, ok: true });
      } else {
        setToast({ msg: data.erro || 'Erro ao executar otimizações', ok: false });
      }
    } catch {
      setToast({ msg: 'Erro ao conectar com o servidor', ok: false });
    } finally {
      setExecutandoOtimizacao(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleIgnorarOtimizacao(logId: string) {
    await (supabase as any).from('ai_optimization_logs').update({ status: 'ignorado' }).eq('id', logId);
    setAiLog(null);
    setShowAiPanel(false);
  }

  const filtered=useMemo(()=>{const base=statusFilter==='all'?campaigns:campaigns.filter(c=>c.status===statusFilter);return[...base].sort((a,b)=>b.leads_api-a.leads_api||(a.cpl||999)-(b.cpl||999)||b.spend-a.spend);},[campaigns,statusFilter]);

  // Leads do CRM filtrados pelo created_at dentro do período
  const filteredLeads = useMemo(()=>filterLeadsByPreset(allLeads,datePreset),[allLeads,datePreset]);

  const filteredRevs = useMemo(() => {
    const today = todayBRCamp();
    const ok = (ref: string | null | undefined, a: string, b: string) => {
      const d = leadDateBRCamp(ref);
      return !!d && d >= a && d <= b;
    };
    const convertidoStatusAtual = statusConfig?.convertido_status ?? 3;
    return allLeads.filter(l => {
      if (Number((l as any).status) !== convertidoStatusAtual) return false;
      const ref = getStatusMovedAt(l, convertidoStatusAtual);
      switch(datePreset) {
        case 'today':      return ok(ref, today, today);
        case 'yesterday':  { const y = subDaysCamp(today, 1); return ok(ref, y, y); }
        case 'last_7d':    return ok(ref, subDaysCamp(today, 6), today);
        case 'last_30d':   return ok(ref, subDaysCamp(today, 29), today);
        case 'this_month': return ok(ref, today.slice(0,7)+'-01', today);
        default: return true;
      }
    });
  }, [allLeads, datePreset, statusConfig]);

  // ── Mapeamento Único: Garante que um lead pertença a apenas 1 campanha
  const campLeadsMap = useMemo(() => {
    const map = new Map<string, any[]>();
    campaigns.forEach(c => map.set(c.id, []));
    const unmatchedLeads: any[] = [];

    for (const l of filteredLeads) {
      const la = l as any;
      if (!isPaidTraffic(la)) continue;

      const utmRaw = (la.utm_campaign || '').trim();
      let bestMatch: string | null = null;
      if (utmRaw) {
        const parts = utmRaw.split('|');
        const utm = (parts[0] || '').trim();
        const utmId = parts.length >= 2 ? parts[1].trim() : '';

        for (const c of campaigns) {
          if (utm === c.id || (utmId && utmId === c.id)) {
            bestMatch = c.id;
            break;
          }
          if (matchCampaignName(utm, c.name)) {
            bestMatch = c.id;
            break;
          }
        }
      }

      if (bestMatch) {
        const arr = map.get(bestMatch) || [];
        arr.push(l);
        map.set(bestMatch, arr);
      } else {
        unmatchedLeads.push(l);
      }
    }

    if (unmatchedLeads.length > 0 && campaigns.length > 0) {
      const weights = campaigns.map(c => c.leads_api > 0 ? c.leads_api : 1);
      const dist = distributeProportional(unmatchedLeads.length, weights);
      const remaining = [...unmatchedLeads];
      campaigns.forEach((c, i) => {
        const count = dist[i];
        if (count > 0) {
          const arr = map.get(c.id) || [];
          const slice = remaining.splice(0, count);
          arr.push(...slice);
          map.set(c.id, arr);
        }
      });
    }

    return map;
  }, [filteredLeads, campaigns]);

  const campRevsMap = useMemo(() => {
    const map = new Map<string, any[]>();
    campaigns.forEach(c => map.set(c.id, []));
    const unmatchedRevs: any[] = [];

    for (const l of filteredRevs) {
      const la = l as any;
      if (!isPaidTraffic(la)) continue;

      const utmRaw = (la.utm_campaign || '').trim();
      let bestMatch: string | null = null;
      if (utmRaw) {
        const parts = utmRaw.split('|');
        const utm = (parts[0] || '').trim();
        const utmId = parts.length >= 2 ? parts[1].trim() : '';

        for (const c of campaigns) {
          if (utm === c.id || (utmId && utmId === c.id)) {
            bestMatch = c.id;
            break;
          }
          if (matchCampaignName(utm, c.name)) {
            bestMatch = c.id;
            break;
          }
        }
      }

      if (bestMatch) {
        const arr = map.get(bestMatch) || [];
        arr.push(l);
        map.set(bestMatch, arr);
      } else {
        unmatchedRevs.push(l);
      }
    }

    if (unmatchedRevs.length > 0 && campaigns.length > 0) {
      const weights = campaigns.map(c => c.leads_api > 0 ? c.leads_api : 1);
      const dist = distributeProportional(unmatchedRevs.length, weights);
      const remaining = [...unmatchedRevs];
      campaigns.forEach((c, i) => {
        const count = dist[i];
        if (count > 0) {
          const arr = map.get(c.id) || [];
          const slice = remaining.splice(0, count);
          arr.push(...slice);
          map.set(c.id, arr);
        }
      });
    }

    return map;
  }, [filteredRevs, campaigns]);

  // Todos os leads (sem filtro de período) mapeados por campanha — para calcular idade real (isNew)
  const allCampLeadsMap = useMemo(() => {
    const map = new Map<string, any[]>();
    campaigns.forEach(c => map.set(c.id, []));
    for (const l of allLeads) {
      const la = l as any;
      const utmRaw = (la.utm_campaign || '').trim();
      if (!utmRaw) continue;
      const parts = utmRaw.split('|');
      const utm = (parts[0] || '').trim();
      const utmId = parts.length >= 2 ? parts[1].trim() : '';
      let bestMatch: string | null = null;
      for (const c of campaigns) {
        if (utm === c.id || (utmId && utmId === c.id)) {
          bestMatch = c.id;
          break;
        }
        if (matchCampaignName(utm, c.name)) {
          bestMatch = c.id;
          break;
        }
      }
      if (bestMatch) {
        const arr = map.get(bestMatch) || [];
        arr.push(l);
        map.set(bestMatch, arr);
      }
    }
    return map;
  }, [allLeads, campaigns]);

  const getCampLeads = useCallback((campName: string, campId: string) => {
    return campLeadsMap.get(campId) || [];
  }, [campLeadsMap]);

  const getCampRevs = useCallback((_campName: string, campId: string) => {
    return campRevsMap.get(campId) || [];
  }, [campRevsMap]);

  const totalSpend = campaigns.reduce((s,c)=>s+c.spend,0);
  const totalLeads = campaigns.reduce((s,c)=>s+c.leads_api,0);
  const avgCPL = totalLeads>0?totalSpend/totalLeads:0;
  const maxSpend = Math.max(...campaigns.map(c=>c.spend),1);

  // Dados por campanha (leads CRM + revendedoras)
  const chartRows = useMemo(()=>{
    return filtered.slice(0,10).map(c=>{
      const campLeads = getCampLeads(c.name, c.id);
      const campRevs  = getCampRevs(c.name, c.id);
      const l = campLeads.length > 0 ? campLeads.length : c.leads_api;
      const r = campRevs.length;
      return {
        name: c.name.length>16?c.name.slice(0,16)+'…':c.name,
        fullName: c.name,
        leads: l,
        rev:   r,
        cpl:   l>0&&c.spend>0 ? Math.round(c.spend/l) : 0,
        cpr:   r>0&&c.spend>0 ? Math.round(c.spend/r) : 0,
        spend: c.spend,
        id: c.id,
      };
    });
  },[filtered, getCampLeads, getCampRevs]); // eslint-disable-line

  const mediaCPR = useMemo(() => {
    const comCPR = chartRows.filter(r => r.cpr > 0);
    return comCPR.length > 0
      ? comCPR.reduce((s, r) => s + r.cpr, 0) / comCPR.length
      : 0;
  }, [chartRows]);

  const preConvertidoStatus = useMemo(() => {
    if (ravenaPreConversionStatus != null) return ravenaPreConversionStatus;
    const blocked = ['reprovado', 'sem retorno', 'perdido', 'cancelado'];
    const sorted = [...statusConfig.statuses].sort((a, b) => a.ordem - b.ordem);
    const candidates = sorted.filter(s => s.id !== statusConfig.convertido_status && !blocked.some(term => (s.label || '').toLowerCase().includes(term)));
    return candidates.length > 0 ? candidates[candidates.length - 1].id : null;
  }, [statusConfig, ravenaPreConversionStatus]);

  // Scores por campanha — usa allCampLeadsMap para idade real
  const campScores = useMemo(() => {
    const map = new Map<string, number>();
    chartRows.forEach(r => {
      const allLeadsForCamp = allCampLeadsMap.get(r.id) || [];
      const potenciaisPeriodo = preConvertidoStatus != null
        ? filterPotenciaisByPreset(allLeadsForCamp, preConvertidoStatus, datePreset).length
        : 0;
      map.set(r.id, calcScore(r, chartRows, allCampLeadsMap, campRevsMap, datePreset, preConvertidoStatus, potenciaisPeriodo));
    });
    return map;
  }, [chartRows, allCampLeadsMap, campRevsMap, datePreset, preConvertidoStatus]);

  // Top 5 por score para o ranking lateral — usa os mesmos dados do período selecionado
  const rankedRows = useMemo(() => {
    return [...chartRows]
      .map(r => {
        const allLeadsForCamp = allCampLeadsMap.get(r.id) || [];
        const potenciaisPeriodo = preConvertidoStatus != null
          ? filterPotenciaisByPreset(allLeadsForCamp, preConvertidoStatus, datePreset).length
          : 0;
        return {
          ...r,
          score: calcScore(r, chartRows, allCampLeadsMap, campRevsMap, datePreset, preConvertidoStatus, potenciaisPeriodo),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [chartRows, allCampLeadsMap, campRevsMap, datePreset, preConvertidoStatus]);

  // ── Performance badge por campanha ───────────────────────────
  function getCampPerf(c: Campaign): 'green'|'yellow'|'red' {
    const cl=getCampLeads(c.name,c.id);
    const cL=cl.length>0?cl.length:c.leads_api;
    const cR=getCampRevs(c.name,c.id).length;
    const cpl=cL>0&&c.spend>0?c.spend/cL:0;
    if(avgCPL>0&&cpl>0&&cpl>avgCPL*1.5) return 'red';
    if(cpl>0&&avgCPL>0&&cpl<=avgCPL&&cR>0) return 'green';
    return 'yellow';
  }

  // ── Modo Gestor: exibe só campanhas que precisam atenção ──────
  const displayedCampaigns = useMemo(()=>{
    let base = gestorMode ? filtered.filter(c=>getCampPerf(c)!=='green') : filtered;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      base = base.filter(c => c.name.toLowerCase().includes(q));
    }
    return [...base].sort((a, b) => {
      const sA = campScores.get(a.id) ?? 0;
      const sB = campScores.get(b.id) ?? 0;
      return sB - sA;
    });
  },[filtered, gestorMode, campScores, getCampLeads, avgCPL, searchQuery]); // eslint-disable-line

  function handleSort(field: string) {
    if (sortBy === field) setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortOrder('desc'); }
  }

  function toggleExpanded(campId: string) {
    setExpandedCampaigns(prev => { const n = new Set(prev); n.has(campId) ? n.delete(campId) : n.add(campId); return n; });
  }
  function toggleExpandedAdset(adsetId: string) {
    setExpandedAdsets(prev => { const n = new Set(prev); n.has(adsetId) ? n.delete(adsetId) : n.add(adsetId); return n; });
  }

  function saveFilterAndNavigate(filter: object) {
    if (!orgId) return;
    const showRevs = (filter as any).showRevs === true;
    // useAprovacaoDate: true instrui a página de leads a filtrar por status_aprovado_at em vez de created_at
    const payload = { ...filter, datePreset, ...(showRevs ? { useAprovacaoDate: true } : {}) };
    localStorage.setItem(`leads_campaign_filter_${orgId}`, JSON.stringify(payload));
    navigate('/leads');
  }

  function handleFilterByCampaign(campId: string, campName: string) {
    saveFilterAndNavigate({ type: 'campaign', campaignId: campId, campaignName: campName, showRevs: false });
  }
  function handleFilterByCampaignRevs(campId: string, campName: string) {
    saveFilterAndNavigate({ type: 'campaign', campaignId: campId, campaignName: campName, showRevs: true });
  }
  function handleFilterByAdSet(campId: string, campName: string, adSetId: string, adSetName: string) {
    saveFilterAndNavigate({ type: 'adset', campaignId: campId, campaignName: campName, adSetId, adSetName, showRevs: false });
  }
  function handleFilterByAdSetRevs(campId: string, campName: string, adSetId: string, adSetName: string) {
    saveFilterAndNavigate({ type: 'adset', campaignId: campId, campaignName: campName, adSetId, adSetName, showRevs: true });
  }
  function handleFilterByAd(campId: string, campName: string, adSetId: string, adSetName: string, adId: string, adName: string) {
    saveFilterAndNavigate({ type: 'ad', campaignId: campId, campaignName: campName, adSetId, adSetName, adId, adName, showRevs: false });
  }
  function handleFilterByAdRevs(campId: string, campName: string, adSetId: string, adSetName: string, adId: string, adName: string) {
    saveFilterAndNavigate({ type: 'ad', campaignId: campId, campaignName: campName, adSetId, adSetName, adId, adName, showRevs: true });
  }

  // Cruzamento de CRM por nome — false se qualquer parte for vazia ou inválida
  function matchByName(utmPart: string, targetName: string): boolean {
    const a = utmPart.toLowerCase().trim();
    const b = targetName.toLowerCase().trim();
    if (!a || a.length === 0) return false;
    if (!b || b.length === 0) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  // Flat rows para a aba ativa (campanhas / conjuntos / anuncios)
  const tableData = useMemo(() => {
    if (activeLevel === 'campanhas') {
      return displayedCampaigns.map(c => {
        const crmLeads = getCampLeads(c.name, c.id);
        const hasCrm = crmLeads.length > 0;
        const leads = hasCrm ? crmLeads.length : c.leads_api;
        const rev = getCampRevs(c.name, c.id).length;
        return {
          id: c.id, name: c.name, status: c.status, type: 'campaign' as const,
          parentCampId: undefined as string|undefined, parentAdsetId: undefined as string|undefined,
          thumbnail_url: undefined as string|null|undefined,
          budget: c.daily_budget ?? c.lifetime_budget ?? 0,
          spend: c.spend, leads, cpl: leads > 0 && c.spend > 0 ? c.spend / leads : 0,
          rev, cpr: rev > 0 && c.spend > 0 ? c.spend / rev : 0,
          score: campScores.get(c.id) ?? 50,
          impressions: c.impressions, clicks: c.clicks, ctr: c.ctr, cpm: c.cpm,
          fromApi: !hasCrm,
        };
      });
    }
    const src = selectedCampIds.size > 0
      ? displayedCampaigns.filter(c => selectedCampIds.has(c.id))
      : displayedCampaigns;

    if (activeLevel === 'conjuntos') {
      return src.flatMap(c => {
        const crmLeads = getCampLeads(c.name, c.id);
        const crmRevs  = getCampRevs(c.name, c.id);
        const adsets   = c.adsets || [];
        const adsetsFiltrados = statusFilter === 'all' ? adsets : adsets.filter(as => as.status === statusFilter);
        const hasCrm   = crmLeads.length > 0;

        if (!hasCrm) {
          // Sem leads no CRM: usa API diretamente
          return adsetsFiltrados.map(as => ({
            id: as.id, name: as.name, status: as.status, type: 'adset' as const,
            parentCampId: c.id, parentAdsetId: undefined as string|undefined,
            thumbnail_url: undefined as string|null|undefined,
            budget: as.daily_budget ?? as.lifetime_budget ?? 0,
            spend: as.spend, leads: as.leads_api,
            cpl: as.leads_api > 0 && as.spend > 0 ? as.spend / as.leads_api : 0,
            rev: 0, cpr: 0,
            score: undefined as number|undefined,
            impressions: as.impressions, clicks: as.clicks, ctr: as.ctr, cpm: 0,
          }));
        }

        // Com leads no CRM: match direto UTM + proporcional para não-atribuídos
        const { leads: leadsMap, revs: revsMap } = buildAdsetCounts(crmLeads, crmRevs, adsets);

        return adsetsFiltrados.map(as => {
          const leads = leadsMap.get(as.id) ?? 0;
          const rev   = revsMap.get(as.id)  ?? 0;
          return {
            id: as.id, name: as.name, status: as.status, type: 'adset' as const,
            parentCampId: c.id, parentAdsetId: undefined as string|undefined,
            thumbnail_url: undefined as string|null|undefined,
            budget: as.daily_budget ?? as.lifetime_budget ?? 0,
            spend: as.spend, leads, cpl: leads > 0 && as.spend > 0 ? as.spend / leads : 0,
            rev, cpr: rev > 0 && as.spend > 0 ? as.spend / rev : 0,
            score: undefined as number|undefined,
            impressions: as.impressions, clicks: as.clicks, ctr: as.ctr, cpm: 0,
          };
        });
      });
    }

    if (activeLevel === 'anuncios') {
      const validSelectedAdsetIds = new Set<string>();
      if (selectedAdsetIds.size > 0) {
        src.forEach(c => {
          (c.adsets || []).forEach(as => {
            if (selectedAdsetIds.has(as.id)) validSelectedAdsetIds.add(as.id);
          });
        });
      }

      // Para cada campanha, pré-computa os counts de ads uma única vez
      const buildRowsForCampaign = (c: Campaign, adsToRender: Ad[]) => {
        const crmLeads = getCampLeads(c.name, c.id);
        const crmRevs  = getCampRevs(c.name, c.id);
        const hasCrm   = crmLeads.length > 0;
        const allAds   = c.ads || [];

        if (!hasCrm) {
          return adsToRender.map(ad => ({
            id: ad.id, name: ad.name, status: ad.status, type: 'ad' as const,
            parentCampId: c.id, parentAdsetId: c.adsets?.find(as => as.ads?.some(a => a.id === ad.id))?.id as string|undefined,
            thumbnail_url: ad.thumbnail_url,
            budget: 0, spend: ad.spend, leads: ad.leads_api,
            cpl: ad.leads_api > 0 && ad.spend > 0 ? ad.spend / ad.leads_api : 0,
            rev: 0, cpr: 0,
            score: undefined as number|undefined,
            impressions: 0, clicks: 0, ctr: ad.ctr, cpm: 0,
          }));
        }

        // Calcula os counts usando TODOS os ads da campanha como denominador
        const { leads: leadsMap, revs: revsMap } = buildAdCounts(crmLeads, crmRevs, allAds);

        return adsToRender.map(ad => {
          const leads = leadsMap.get(ad.id) ?? 0;
          const rev   = revsMap.get(ad.id)  ?? 0;
          const parentAdsetId = c.adsets?.find(as => as.ads?.some(a => a.id === ad.id))?.id;
          return {
            id: ad.id, name: ad.name, status: ad.status, type: 'ad' as const,
            parentCampId: c.id, parentAdsetId: parentAdsetId as string|undefined,
            thumbnail_url: ad.thumbnail_url,
            budget: 0, spend: ad.spend, leads, cpl: leads > 0 && ad.spend > 0 ? ad.spend / leads : 0,
            rev, cpr: rev > 0 && ad.spend > 0 ? ad.spend / rev : 0,
            score: undefined as number|undefined,
            impressions: 0, clicks: 0, ctr: ad.ctr, cpm: 0,
          };
        });
      };

      if (validSelectedAdsetIds.size > 0) {
        return src.flatMap(c => {
          const adsToRender = (c.adsets || [])
            .filter(as => validSelectedAdsetIds.has(as.id))
            .flatMap(as => statusFilter === 'all' ? (as.ads || []) : (as.ads || []).filter(ad => ad.status === statusFilter));
          return buildRowsForCampaign(c, adsToRender);
        });
      }
      return src.flatMap(c => buildRowsForCampaign(c, statusFilter === 'all' ? (c.ads || []) : (c.ads || []).filter(ad => ad.status === statusFilter)));
    }
    return [];
  }, [activeLevel, displayedCampaigns, selectedCampIds, selectedAdsetIds, campScores, getCampLeads, getCampRevs, statusFilter]);

  const sortedTableData = useMemo(() => {
    let data = tableData;
    if (searchQuery.trim() && activeLevel !== 'campanhas') {
      const q = searchQuery.toLowerCase();
      data = data.filter(r => r.name.toLowerCase().includes(q));
    }
    if (!sortBy) return data;
    return [...data].sort((a, b) => {
      const aVal = (a as any)[sortBy];
      const bVal = (b as any)[sortBy];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
  }, [tableData, sortBy, sortOrder, searchQuery, activeLevel]);

  const gridCols = useMemo(() => {
    return '48px ' + visibleColumns.map(c => `${columnWidths[c] || 80}px`).join(' ');
  }, [visibleColumns, columnWidths]);

  // ── Alertas automáticos ───────────────────────────────────────
  const alerts = useMemo(()=>{
    if(!filtered.length||loading) return [];
    const items:{type:'red'|'yellow'|'green';msg:string}[]=[];
    const trunc=(s:string)=>s.length>35?s.slice(0,35)+'…':s;
    for(const c of filtered){
      const cl=getCampLeads(c.name,c.id);
      const cL=cl.length>0?cl.length:c.leads_api;
      const cR=getCampRevs(c.name,c.id).length;
      const cpl=cL>0&&c.spend>0?c.spend/cL:0;
      const cpr=cR>0&&c.spend>0?c.spend/cR:0;
      if(avgCPL>0&&cpl>avgCPL*1.3&&c.spend>20&&items.length<5)
        items.push({type:'red',msg:`${trunc(c.name)} — CPL R$ ${fmt(cpl)} está ${Math.round((cpl/avgCPL-1)*100)}% acima da média`});
      else if(cL>5&&cR===0&&items.length<5)
        items.push({type:'red',msg:`${trunc(c.name)} — ${cL} leads sem nenhum ${t.convertidoSingular}`});
      if(c.ctr<1.5&&c.impressions>1000&&items.length<5)
        items.push({type:'yellow',msg:`${trunc(c.name)} — CTR ${c.ctr.toFixed(2)}% abaixo de 1.5%`});
      if(cR>0&&cpr>200&&items.length<5)
        items.push({type:'yellow',msg:`${trunc(c.name)} — ${t.custoConversaoSigla} R$ ${fmt(cpr)} acima de R$ 200`});
      if(avgCPL>0&&cpl>0&&cpl<avgCPL&&c.spend>20&&items.length<5)
        items.push({type:'green',msg:`${trunc(c.name)} — CPL R$ ${fmt(cpl)} abaixo da média da conta`});
      if(cL>=5&&cR/cL>0.1&&items.length<5)
        items.push({type:'green',msg:`${trunc(c.name)} — ${Math.round(cR/cL*100)}% de aprovação (${cR} ${t.convertidoCurto} de ${cL} leads)`});
    }
    return items.sort((a,b)=>{const o={red:0,yellow:1,green:2};return o[a.type]-o[b.type];}).slice(0,5);
  },[filtered,getCampLeads,avgCPL,loading]); // eslint-disable-line

  const leadsCRMTotal = useMemo(()=>
    filteredLeads.filter(l => isPaidTraffic(l as any)).length
  ,[filteredLeads]);
  // Revendedoras aprovadas no período (status_aprovado_at) via Meta Ads
  const revsCRMTotal = useMemo(()=>
    filteredRevs.filter(l => isPaidTraffic(l as any)).length
  ,[filteredRevs]);
  const cplCard = leadsCRMTotal>0&&totalSpend>0 ? totalSpend/leadsCRMTotal : 0;
  const cprCard = revsCRMTotal>0&&totalSpend>0  ? totalSpend/revsCRMTotal  : 0;

  const avgCTR = useMemo(() => {
    const ativas = filtered.filter(c => c.impressions > 0);
    if (!ativas.length) return 0;
    const totalImpressions = ativas.reduce((s,c) => s + c.impressions, 0);
    const totalClicks = ativas.reduce((s,c) => s + c.clicks, 0);
    return totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  }, [filtered]);

  const bg=dark?'#090909':'#f4f4f5'; const cardBg=dark?'#111113':'#ffffff'; const border=dark?'#1e1e22':'#e5e7eb';
  const txtHi=dark?'#f4f4f5':'#111827'; const txtMid=dark?'#71717a':'#6b7280'; const panelBg = dark ? '#0d0d18' : '#f5f7ff';
  const txtLow=dark?'#52525b':'#9ca3af';
  const divCls=dark?'#1e1e22':'#f3f4f6'; const gridLn=dark?'#1e1e22':'#f0f0f0';
  const inputBg=dark?'#1a1a1e':'#ffffff';
  const pad=isMobile?'16px':'32px';
  const dot=<span style={{fontSize:'11px',color:txtLow,margin:'0 2px'}}>·</span>;

  async function toggleStatus(id: string, currentStatus: string, type: 'campaign'|'adset'|'ad') {
    const newStatus = currentStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setTogglingCampaigns(prev => new Set(prev).add(id));
    const labels = {campaign:'Campanha', adset:'Conjunto', ad:'Anúncio'};
    const callApi = async (entityId: string): Promise<{ ok: boolean; erro?: string }> => {
      try {
        const url = new URL(`https://graph.facebook.com/v18.0/${entityId}`);
        url.searchParams.set('status', newStatus);
        url.searchParams.set('access_token', metaToken || '');
        const res = await fetch(url.toString(), { method: 'POST' });
        const d = await res.json();
        if (!res.ok || d.error) return { ok: false, erro: d.error?.error_user_msg || d.error?.message || 'Erro Meta API' };
        return { ok: true };
      } catch (e: any) {
        return { ok: false, erro: e.message || 'Erro de rede' };
      }
    };
    const getChildAds = async (parentId: string): Promise<string[]> => {
      try {
        const url = new URL(`https://graph.facebook.com/v18.0/${parentId}/ads`);
        url.searchParams.set('fields', 'id');
        url.searchParams.set('limit', '100');
        url.searchParams.set('access_token', metaToken || '');
        const res = await fetch(url.toString());
        const d = await res.json();
        return (d.data || []).map((a: any) => a.id);
      } catch { return []; }
    };
    const getAdsetIds = async (campaignId: string): Promise<string[]> => {
      try {
        const url = new URL(`https://graph.facebook.com/v18.0/${campaignId}/adsets`);
        url.searchParams.set('fields', 'id');
        url.searchParams.set('limit', '50');
        url.searchParams.set('access_token', metaToken || '');
        const res = await fetch(url.toString());
        const d = await res.json();
        return (d.data || []).map((a: any) => a.id);
      } catch { return []; }
    };
    const fixAndPause = async (adsetId: string): Promise<boolean> => {
      try {
        const getUrl = new URL(`https://graph.facebook.com/v18.0/${adsetId}`);
        getUrl.searchParams.set('fields', 'targeting');
        getUrl.searchParams.set('access_token', metaToken || '');
        const getRes = await fetch(getUrl.toString());
        const getData = await getRes.json();
        if (getData.error || !getData.targeting) return false;
        const targeting = JSON.parse(JSON.stringify(getData.targeting));
        if (targeting.excluded_geo_locations) {
          delete targeting.excluded_geo_locations;
        }
        const updUrl = new URL(`https://graph.facebook.com/v18.0/${adsetId}`);
        updUrl.searchParams.set('targeting', JSON.stringify(targeting));
        updUrl.searchParams.set('access_token', metaToken || '');
        const updRes = await fetch(updUrl.toString(), { method: 'POST' });
        const updData = await updRes.json();
        if (updData.error) return false;
        const pauseUrl = new URL(`https://graph.facebook.com/v18.0/${adsetId}`);
        pauseUrl.searchParams.set('status', 'PAUSED');
        pauseUrl.searchParams.set('access_token', metaToken || '');
        const pauseRes = await fetch(pauseUrl.toString(), { method: 'POST' });
        const pauseData = await pauseRes.json();
        return !pauseData.error;
      } catch { return false; }
    };
    try {
      const result = await callApi(id);
      if (!result.ok && type !== 'ad' && newStatus === 'PAUSED') {
        // Fallback 1: tentar pausar anúncios individualmente
        const ads = await getChildAds(id);
        let pausedAds = 0;
        let lastAdError = '';
        for (const adId of ads) {
          const r = await callApi(adId);
          if (r.ok) pausedAds++;
          else lastAdError = r.erro || '';
        }
        if (pausedAds > 0) {
          setCampaigns(prev => type === 'campaign'
            ? prev.map(c => c.id === id ? {...c, status: 'PAUSED'} : c)
            : prev.map(c => ({...c, adsets: c.adsets?.map(as => as.id === id ? {...as, status: 'PAUSED'} : as)}))
          );
          setToast({msg: `${labels[type]} pausada via ${pausedAds} anúncio${pausedAds > 1 ? 's' : ''}`, ok: true});
          return;
        }
        // Fallback 2: corrigir segmentação e pausar
        const targets = type === 'campaign' ? await getAdsetIds(id) : [id];
        let fixedCount = 0;
        for (const t of targets) {
          if (await fixAndPause(t)) fixedCount++;
        }
        if (fixedCount > 0) {
          setCampaigns(prev => type === 'campaign'
            ? prev.map(c => c.id === id ? {...c, status: 'PAUSED'} : c)
            : prev.map(c => ({...c, adsets: c.adsets?.map(as => as.id === id ? {...as, status: 'PAUSED'} : as)}))
          );
          setToast({msg: `${labels[type]} pausada (segmentação corrigida em ${fixedCount} conjunto${fixedCount > 1 ? 's' : ''})`, ok: true});
          return;
        }
        throw new Error(result.erro || lastAdError || 'Erro ao pausar');
      } else if (result.ok) {
        setCampaigns(prev => type === 'campaign'
          ? prev.map(c => c.id === id ? {...c, status: newStatus} : c)
          : type === 'adset'
            ? prev.map(c => ({...c, adsets: c.adsets?.map(as => as.id === id ? {...as, status: newStatus} : as)}))
            : prev.map(c => ({...c, ads: c.ads?.map(ad => ad.id === id ? {...ad, status: newStatus} : ad), adsets: c.adsets?.map(as => ({...as, ads: as.ads?.map(ad => ad.id === id ? {...ad, status: newStatus} : ad)}))}))
        );
        setToast({msg: `${labels[type]} ${newStatus === 'ACTIVE' ? 'ativado' : 'pausado'}`, ok: true});
      } else {
        throw new Error(result.erro || 'Erro desconhecido');
      }
    } catch (e: any) {
      setToast({msg: `Erro: ${e.message}`, ok: false});
    } finally {
      setTogglingCampaigns(prev => { const n = new Set(prev); n.delete(id); return n; });
      setTimeout(() => setToast(null), 3000);
    }
  }

  async function saveBudget(id: string, value: string, level: 'campaign'|'adset') {
    const num = parseFloat(value.replace(',', '.'));
    if (isNaN(num) || num <= 0) { setToast({msg: 'Valor inválido', ok: false}); setTimeout(() => setToast(null), 3000); return; }
    const cents = Math.round(num * 100);
    setEditingBudget(null);
    try {
      const url = new URL(`https://graph.facebook.com/v18.0/${id}`);
      url.searchParams.set('daily_budget', String(cents));
      url.searchParams.set('access_token', metaToken || '');
      const res = await fetch(url.toString(), { method: 'POST' });
      if (!res.ok) throw new Error();
      if (level === 'campaign') {
        setCampaigns(prev => prev.map(c => c.id === id ? {...c, daily_budget: num} : c));
      } else {
        setCampaigns(prev => prev.map(c => ({...c, adsets: c.adsets?.map(as => as.id === id ? {...as, daily_budget: num} : as)})));
      }
      setToast({msg: `Orçamento: R$ ${num.toFixed(2)}/dia`, ok: true});
    } catch {
      setToast({msg: 'Erro ao salvar orçamento', ok: false});
    }
    setTimeout(() => setToast(null), 3000);
  }

  function handleDuplicate() {
    const count = activeLevel==='campanhas'?selectedCampIds.size:activeLevel==='conjuntos'?selectedAdsetIds.size:selectedAdIds.size;
    if (count === 0) return;
    const label = activeLevel==='campanhas'?'campanha':activeLevel==='conjuntos'?'conjunto':'anúncio';
    setConfirmModal({ type: 'duplicate', count, label });
  }

  function handleDelete() {
    const count = activeLevel==='campanhas'?selectedCampIds.size:activeLevel==='conjuntos'?selectedAdsetIds.size:selectedAdIds.size;
    if (count === 0) return;
    const label = activeLevel==='campanhas'?'campanha':activeLevel==='conjuntos'?'conjunto':'anúncio';
    setConfirmModal({ type: 'delete', count, label });
  }

  function executeDelete() {
    const key = `meta_camp_${orgId}_${datePreset}`;
    if (activeLevel === 'campanhas') {
      if (selectedCampIds.size === 0) return;
      const next = campaigns.filter(c => !selectedCampIds.has(c.id));
      setCampaigns(next); setMetaCache(key, next);
      const n = selectedCampIds.size; setSelectedCampIds(new Set());
      setToast({ msg: `${n} campanha${n>1?'s':''} excluída${n>1?'s':''}`, ok: true });
    } else if (activeLevel === 'conjuntos') {
      if (selectedAdsetIds.size === 0) return;
      const next = campaigns.map(c => ({...c, adsets:(c.adsets||[]).filter(as=>!selectedAdsetIds.has(as.id))}));
      setCampaigns(next); setMetaCache(key, next);
      const n = selectedAdsetIds.size; setSelectedAdsetIds(new Set());
      setToast({ msg: `${n} conjunto${n>1?'s':''} excluído${n>1?'s':''}`, ok: true });
    } else {
      if (selectedAdIds.size === 0) return;
      const next = campaigns.map(c => ({
        ...c,
        ads:(c.ads||[]).filter(ad=>!selectedAdIds.has(ad.id)),
        adsets:(c.adsets||[]).map(as=>({...as,ads:(as.ads||[]).filter(ad=>!selectedAdIds.has(ad.id))}))
      }));
      setCampaigns(next); setMetaCache(key, next);
      const n = selectedAdIds.size; setSelectedAdIds(new Set());
      setToast({ msg: `${n} anúncio${n>1?'s':''} excluído${n>1?'s':''}`, ok: true });
    }
    setTimeout(() => setToast(null), 3000);
  }

  function executeDuplicate() {
    const ts = Date.now();
    const key = `meta_camp_${orgId}_${datePreset}`;
    if (activeLevel === 'campanhas') {
      if (selectedCampIds.size === 0) return;
      const toDup = campaigns.filter(c => selectedCampIds.has(c.id));
      const copies = toDup.map(c => ({
        ...c,
        id: `mock_${ts}_${c.id}`,
        name: `${c.name} - Cópia`,
        status: 'PAUSED' as const,
        spend: 0, impressions: 0, clicks: 0, leads_api: 0, cpl: 0,
        adsets: (c.adsets || []).map(as => ({
          ...as,
          id: `mock_${ts}_${as.id}`,
          name: `${as.name} - Cópia`,
          status: 'PAUSED' as const,
          spend: 0, impressions: 0, clicks: 0, leads_api: 0, cpl: 0,
          ads: (as.ads || []).map(ad => ({
            ...ad,
            id: `mock_${ts}_${ad.id}`,
            name: `${ad.name} - Cópia`,
            status: 'PAUSED' as const,
            spend: 0, leads_api: 0, cpl: 0,
          }))
        })),
        ads: (c.ads || []).map(ad => ({
          ...ad,
          id: `mock_${ts}_${ad.id}`,
          name: `${ad.name} - Cópia`,
          status: 'PAUSED' as const,
          spend: 0, leads_api: 0, cpl: 0,
        }))
      }));
      const next = [...campaigns, ...copies];
      setCampaigns(next);
      setMetaCache(key, next);
      const n = copies.length;
      setToast({ msg: `${n} campanha${n > 1 ? 's' : ''} duplicada${n > 1 ? 's' : ''}`, ok: true });
    } else if (activeLevel === 'conjuntos') {
      if (selectedAdsetIds.size === 0) return;
      const next = campaigns.map(c => {
        const toDup = (c.adsets || []).filter(as => selectedAdsetIds.has(as.id));
        if (!toDup.length) return c;
        const copies = toDup.map(as => ({
          ...as,
          id: `mock_${ts}_${as.id}`,
          name: `${as.name} - Cópia`,
          status: 'PAUSED' as const,
          spend: 0, impressions: 0, clicks: 0, leads_api: 0, cpl: 0,
          ads: (as.ads || []).map(ad => ({
            ...ad,
            id: `mock_${ts}_${ad.id}`,
            name: `${ad.name} - Cópia`,
            status: 'PAUSED' as const,
            spend: 0, leads_api: 0, cpl: 0,
          }))
        }));
        return { ...c, adsets: [...(c.adsets || []), ...copies] };
      });
      setCampaigns(next);
      setMetaCache(key, next);
      const n = selectedAdsetIds.size;
      setToast({ msg: `${n} conjunto${n > 1 ? 's' : ''} duplicado${n > 1 ? 's' : ''}`, ok: true });
    } else {
      if (selectedAdIds.size === 0) return;
      const next = campaigns.map(c => ({
        ...c,
        ads: [
          ...(c.ads || []),
          ...(c.ads || []).filter(ad => selectedAdIds.has(ad.id)).map(ad => ({
            ...ad,
            id: `mock_${ts}_${ad.id}`,
            name: `${ad.name} - Cópia`,
            status: 'PAUSED' as const,
            spend: 0, leads_api: 0, cpl: 0,
          }))
        ],
        adsets: (c.adsets || []).map(as => ({
          ...as,
          ads: [
            ...(as.ads || []),
            ...(as.ads || []).filter(ad => selectedAdIds.has(ad.id)).map(ad => ({
              ...ad,
              id: `mock_${ts}_${ad.id}`,
              name: `${ad.name} - Cópia`,
              status: 'PAUSED' as const,
              spend: 0, leads_api: 0, cpl: 0,
            }))
          ]
        }))
      }));
      setCampaigns(next);
      setMetaCache(key, next);
      const n = selectedAdIds.size;
      setToast({ msg: `${n} anúncio${n > 1 ? 's' : ''} duplicado${n > 1 ? 's' : ''}`, ok: true });
    }
    setTimeout(() => setToast(null), 3000);
  }

  const totalCampCount = displayedCampaigns.length;
  const totalAdSetCount = useMemo(() => campaigns.reduce((s, c) => s + (c.adsets?.length || 0), 0), [campaigns]);
  const totalAdCount = useMemo(() => campaigns.reduce((s, c) => s + (c.ads?.length || 0), 0), [campaigns]);

  const numConjuntos = useMemo(() => {
    if (selectedCampIds.size === 0) return totalAdSetCount;
    const camps = campaigns.filter(c => selectedCampIds.has(c.id));
    return camps.reduce((sum, c) => sum + (c.adsets?.length || 0), 0);
  }, [campaigns, selectedCampIds, totalAdSetCount]);

  const numAnuncios = useMemo(() => {
    if (selectedCampIds.size === 0) {
      return totalAdCount;
    }
    const camps = campaigns.filter(c => selectedCampIds.has(c.id));
    return camps.reduce((sum, c) => sum + (c.ads?.length || 0), 0);
  }, [campaigns, selectedCampIds, totalAdCount]);

  return (
    <AppLayout leadCount={leads.length}>
      <div style={{padding:pad,background:bg,minHeight:'100vh'}}>

        {/* Header */}
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:'20px',flexWrap:'wrap',gap:'10px'}}>
          <div>
            <h1 style={{fontSize:isMobile?'20px':'24px',fontWeight:700,color:txtHi,letterSpacing:'-0.03em',margin:0}}>Campanhas Meta Ads</h1>
            <p style={{fontSize:'13px',color:txtMid,marginTop:'4px'}}>Dados em tempo real via API do Facebook</p>
          </div>
          <div style={{display:'flex',gap:'8px',alignItems:'center',flexWrap:'wrap'}}>
            <FilterDropdown value={datePreset} options={PERIOD_OPTIONS} onChange={setDatePreset} dark={dark}/>
            <FilterDropdown value={statusFilter} options={[{label:'Todas',value:'all'},{label:'Ativas',value:'ACTIVE'},{label:'Pausadas',value:'PAUSED'}]} onChange={setStatusFilter} dark={dark}/>
            <button onClick={()=>{ const key=`meta_camp_${orgId}_${datePreset}`; sessionStorage.removeItem(key); load(); }} disabled={loading} style={{display:'flex',alignItems:'center',gap:'6px',padding:'8px 14px',borderRadius:'10px',border:`1px solid ${border}`,background:cardBg,color:txtMid,fontSize:'13px',cursor:'pointer',fontFamily:'inherit'}}>
              <RefreshCw style={{width:'14px',height:'14px',animation:loading?'spin 1s linear infinite':''}}/>
              {loading?'Carregando…':'Atualizar'}
            </button>
          </div>
        </div>

        {/* Cards: Gasto | Leads+CPL | Revs+CPR | CTR */}
        <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(4,1fr)',gap:isMobile?'12px':'16px',marginBottom:'16px'}}>

          {/* Card 1: GASTO */}
          <div style={{background:cardBg,borderRadius:'16px',padding:isMobile?'12px':'20px',border:`1px solid ${border}`}}>
            <p style={{fontSize:'12px',color:txtMid,margin:'0 0 4px'}}>Gasto Total</p>
            <p style={{fontSize:isMobile?'18px':'22px',fontWeight:700,color:txtHi,letterSpacing:'-0.03em',margin:'0 0 6px'}}>
              {loading ? '…' : `R$ ${fmt(totalSpend)}`}
            </p>
            <div style={{display:'flex',alignItems:'center',gap:'4px'}}>
              <TrendingUp style={{width:'11px',height:'11px',color:'#10b981'}}/>
              <span style={{fontSize:'11px',color:txtLow}}>Meta Ads</span>
            </div>
          </div>

          {/* Card 2: LEADS + CPL */}
          <div style={{background:cardBg,borderRadius:'16px',padding:isMobile?'12px':'20px',border:`1px solid ${border}`}}>
            <p style={{fontSize:'12px',color:txtMid,margin:'0 0 4px'}}>Leads</p>
            <p style={{fontSize:isMobile?'18px':'22px',fontWeight:700,color:txtHi,letterSpacing:'-0.03em',margin:'0 0 6px'}}>
              {loading ? '…' : fmtInt(leadsCRMTotal)}
            </p>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span style={{fontSize:'11px',color:txtLow}}>Tráfego pago · CRM</span>
              {cplCard > 0 && (
                <span style={{fontSize:'12px',fontWeight:700,color:'#3b82f6'}}>
                  CPL R$ {fmt(cplCard)}
                </span>
              )}
            </div>
          </div>

          {/* Card 3: CONVERTIDOS + CUSTO CONVERSAO */}
          <div style={{background:cardBg,borderRadius:'16px',padding:isMobile?'12px':'20px',border:`1px solid ${border}`}}>
            <p style={{fontSize:'12px',color:txtMid,margin:'0 0 4px'}}>{t.convertidoPlural}</p>
            <p style={{fontSize:isMobile?'18px':'22px',fontWeight:700,color:txtHi,letterSpacing:'-0.03em',margin:'0 0 6px'}}>
              {loading ? '…' : fmtInt(revsCRMTotal)}
            </p>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span style={{fontSize:'11px',color:txtLow}}>via tráfego</span>
              {cprCard > 0 && (
                <span style={{fontSize:'12px',fontWeight:700,color:'#a855f7'}}>
                  {t.custoConversaoSigla} R$ {fmt(cprCard)}
                </span>
              )}
            </div>
          </div>

          {/* Card 4: CTR MÉDIO */}
          <div style={{background:cardBg,borderRadius:'16px',padding:isMobile?'12px':'20px',border:`1px solid ${border}`}}>
            <p style={{fontSize:'12px',color:txtMid,margin:'0 0 4px'}}>CTR Médio</p>
            <p style={{fontSize:isMobile?'18px':'22px',fontWeight:700,letterSpacing:'-0.03em',margin:'0 0 6px',
              color: avgCTR >= 3 ? '#10b981' : avgCTR >= 1.5 ? txtHi : '#ef4444'}}>
              {loading ? '…' : `${avgCTR.toFixed(2)}%`}
            </p>
            <div style={{display:'flex',alignItems:'center',gap:'4px'}}>
              <span style={{fontSize:'11px',color: avgCTR >= 3 ? '#10b981' : avgCTR >= 1.5 ? txtLow : '#ef4444'}}>
                {avgCTR >= 3 ? '↑ Excelente' : avgCTR >= 1.5 ? '→ Normal' : '↓ Baixo'}
              </span>
              <span style={{fontSize:'11px',color:txtLow}}>· média das campanhas</span>
            </div>
          </div>

        </div>

        {/* Banner Ravena — desbotado no gratuito, sem bloqueio */}
        <div style={{ opacity: ravenaDesbotada ? 0.4 : 1 }}>
        {aiLog && (() => {
          const isPendente = aiLog.status === 'pendente';
          const isSemAcao = aiLog.status === 'sem_acao';
          const isErro = aiLog.status === 'erro';
          const isIgnorado = aiLog.status === 'ignorado';
          const numSugestoes = (aiLog.acoes_sugeridas || []).filter((a: any) => { const tipo = String(a?.tipo || '').toLowerCase(); return tipo !== 'manter' && tipo !== 'criar_campanha'; }).length;
          const numExecutadas = (aiLog.acoes_executadas || []).filter((a: any) => a.ok !== false).length;
          const pendenteAtivo = (numSugestoes + (aiLog.sugestao_novo_conjunto ? 1 : 0) + ((aiLog.campanha_mestre || (aiLog.acoes_sugeridas || []).find((a: any) => String(a?.tipo || '').toLowerCase() === 'criar_campanha')) ? 1 : 0)) > 0;
          const bannerBg = isErro
            ? (dark ? 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(220,38,38,0.08))' : 'linear-gradient(135deg, #fef2f2, #fef2f2)')
            : (isSemAcao || isIgnorado)
            ? (dark ? 'linear-gradient(135deg, rgba(139,92,246,0.10), rgba(59,130,246,0.06))' : 'linear-gradient(135deg, #faf5ff, #eff6ff)')
            : pendenteAtivo
              ? (dark ? 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(249,115,22,0.08))' : 'linear-gradient(135deg, #fffbeb, #fff7ed)')
              : (dark ? 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(59,130,246,0.08))' : 'linear-gradient(135deg, #faf5ff, #eff6ff)');
          const bannerBorder = isErro
            ? (dark ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.25)')
            : (isSemAcao || isIgnorado)
            ? (dark ? 'rgba(139,92,246,0.25)' : 'rgba(139,92,246,0.18)')
            : pendenteAtivo
              ? (dark ? 'rgba(245,158,11,0.3)' : 'rgba(245,158,11,0.25)')
              : (dark ? 'rgba(139,92,246,0.3)' : 'rgba(139,92,246,0.2)');
          const textColor = isErro
            ? (dark ? '#fca5a5' : '#dc2626')
            : (isSemAcao || isIgnorado)
            ? (dark ? '#c4b5fd' : '#6d28d9')
            : pendenteAtivo ? (dark ? '#fcd34d' : '#d97706') : (dark ? '#c4b5fd' : '#6d28d9');
          const subColor = isErro
            ? (dark ? '#f87171' : '#b91c1c')
            : (isSemAcao || isIgnorado)
            ? (dark ? '#8b5cf6' : '#7c3aed')
            : pendenteAtivo ? (dark ? '#f59e0b' : '#b45309') : (dark ? '#8b5cf6' : '#7c3aed');
          const badgeBg   = isErro ? '#ef4444' : pendenteAtivo ? '#f59e0b' : '#8b5cf6';
          const temNovoConjunto = !!aiLog.sugestao_novo_conjunto;
          const temCampanhaMestre = !!(aiLog.campanha_mestre || (aiLog.acoes_sugeridas || []).find((a: any) => String(a?.tipo || '').toLowerCase() === 'criar_campanha'));
          const badgeNum  = pendenteAtivo ? (numSugestoes + (temNovoConjunto ? 1 : 0) + (temCampanhaMestre ? 1 : 0)) : numExecutadas;
          const badgeText = pendenteAtivo
            ? (badgeNum === 1 ? '1 sugestão' : `${badgeNum} sugestões`)
            : `${badgeNum} ajuste${badgeNum !== 1 ? 's' : ''} de orçamento`;
          return (
            <div
              onClick={() => setShowAiPanel(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 20px', borderRadius: '14px', background: bannerBg, border: `1px solid ${bannerBorder}`, cursor: 'pointer', marginTop: '12px', marginBottom: '4px', transition: 'all 0.15s' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <img src="/ravena.png" alt="Ravena" style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, boxShadow: isErro ? '0 0 12px rgba(239,68,68,0.4)' : (isSemAcao || isIgnorado) ? 'none' : pendenteAtivo ? '0 0 12px rgba(245,158,11,0.4)' : '0 0 12px rgba(139,92,246,0.4)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: textColor }}>
                  {isErro ? 'Erro de sincronização' : isIgnorado ? 'Analisei suas campanhas — sugestões descartadas' : pendenteAtivo ? 'Tenho sugestões para você' : isSemAcao ? `Analisei ${(aiLog.insights || aiLog.analise_campanhas || []).length > 0 ? (aiLog.insights || aiLog.analise_campanhas || []).length + ' campanhas' : 'suas campanhas'} — tudo estável` : 'Atualizei suas campanhas'}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: '12px', color: subColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {isErro
                    ? aiLog.alerta
                    : isIgnorado
                    ? (() => { const n = (aiLog.acoes_sugeridas || []).filter((a: any) => String(a?.tipo || '').toLowerCase() !== 'manter').length; return n > 0 ? `${n} sugestão${n !== 1 ? 'ões' : ''} descartada${n !== 1 ? 's' : ''} pelo usuário` : 'Clique para ver o histórico'; })()
                    : pendenteAtivo
                      ? (badgeNum === 1 ? '1 sugestão aguardando revisão' : `${badgeNum} sugestões aguardando revisão`)
                    : isSemAcao
                    ? (() => { const n = (aiLog.insights || aiLog.analise_campanhas || []).length; return n > 0 ? `${n} campanha${n !== 1 ? 's' : ''} analisada${n !== 1 ? 's' : ''} — nenhuma ação necessária` : 'Nenhuma ação necessária hoje'; })()
                      : numExecutadas > 0 ? `${numExecutadas} ajuste${numExecutadas !== 1 ? 's' : ''} de orçamento realizado${numExecutadas !== 1 ? 's' : ''}` : (aiLog.resumo_contextual || aiLog.resumo || 'Clique para ver a análise')}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                {!isSemAcao && !isIgnorado && badgeNum > 0 && (
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#fff', background: badgeBg, padding: '2px 8px', borderRadius: '99px' }}>
                    {badgeText}
                  </span>
                )}
                <span style={{ fontSize: '18px', color: subColor }}>→</span>
              </div>
            </div>
          );
        })()}
        {!aiLog && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 14px', borderRadius: '10px', marginTop: '12px', marginBottom: '4px',
            background: dark ? 'rgba(139,92,246,0.06)' : '#faf5ff',
            border: `1px solid ${dark ? 'rgba(139,92,246,0.15)' : 'rgba(139,92,246,0.15)'}`,
          }}>
            <img src="/ravena.png" alt="Ravena" style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: '12px', color: dark ? '#8b5cf6' : '#7c3aed' }}>
              {ravenaAtivaNoBanco === true
                ? 'Estou ativa — minha análise aparece aqui em breve'
                : 'Ative a Ravena em Integrações → Meta Ads'}
            </p>
          </div>
        )}
        </div>

        {/* Leads × Convertidos por Campanha — Bar Chart */}
        {!loading && chartRows.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 260px', gap: '16px', marginTop: '24px' }}>

            {/* GRÁFICO */}
            <div style={{ background: cardBg, borderRadius: '16px', border: `1px solid ${border}`, padding: '24px' }}>
              <div style={{ marginBottom: '20px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: 700, color: txtHi, margin: 0 }}>Leads × {t.convertidoPlural} por Campanha</h3>
                <p style={{ fontSize: '12px', color: txtMid, margin: '4px 0 0' }}>Comparativo de captação e conversão no período selecionado</p>
              </div>

              <ResponsiveContainer width="100%" height={320}>
                <BarChart
                  data={rankedRows.map(r => {
                    const allLeadsForChart = allCampLeadsMap.get(r.id) || [];
                    const potenciais = preConvertidoStatus != null
                      ? filterPotenciaisByPreset(allLeadsForChart, preConvertidoStatus, datePreset).length
                      : 0;
                    const raw = r.fullName.replace(/\s*-\s*\[CBO\]/gi,'').replace(/\s*-\s*\[ABO\]/gi,'').replace(/\[LEADS?\]/gi,'').trim();
                    return {
                      name: raw.length > 14 ? raw.slice(0, 14) + '…' : raw,
                      fullName: r.fullName,
                      leads: r.leads,
                      revs: r.rev,
                      cpl: r.cpl,
                      cpr: r.cpr > 0 ? Math.round(r.cpr) : 0,
                      spend: r.spend,
                      potenciais,
                      id: r.id,
                    };
                  })}
                  margin={{ top: 10, right: 10, left: -10, bottom: 20 }}
                  barCategoryGap="30%"
                  barGap={4}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={gridLn} vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: txtMid }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    height={40}
                  />
                  <YAxis tick={{ fontSize: 11, fill: txtMid }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                  <Tooltip
                    cursor={{ fill: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', radius: 8 }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0]?.payload;
                      return (
                        <div style={{ background: dark ? '#1a1a1e' : '#fff', border: `1px solid ${border}`, borderRadius: '12px', padding: '14px 16px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: '210px' }}>
                          <p style={{ fontWeight: 700, fontSize: '13px', color: txtHi, margin: '0 0 12px', lineHeight: 1.4 }}>{d.fullName}</p>
                          {/* Seção Leads */}
                          <div style={{ marginBottom: '10px', paddingBottom: '10px', borderBottom: `1px solid ${border}` }}>
                            <p style={{ fontSize: '10px', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>Leads</p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px' }}><span style={{ fontSize: '12px', color: txtMid }}>Total</span><span style={{ fontSize: '12px', fontWeight: 700, color: '#10b981' }}>{d.leads}</span></div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px' }}><span style={{ fontSize: '12px', color: txtMid }}>CPL</span><span style={{ fontSize: '12px', fontWeight: 600, color: txtHi }}>{d.cpl > 0 ? `R$ ${d.cpl}` : '—'}</span></div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px' }}><span style={{ fontSize: '12px', color: txtMid }}>Investido</span><span style={{ fontSize: '12px', fontWeight: 600, color: txtHi }}>R$ {fmt(d.spend)}</span></div>
                            </div>
                          </div>
                          {/* Seção Convertidos */}
                          <div>
                            <p style={{ fontSize: '10px', fontWeight: 700, color: '#a855f7', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>{t.convertidoPlural}</p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px' }}><span style={{ fontSize: '12px', color: txtMid }}>Total</span><span style={{ fontSize: '12px', fontWeight: 700, color: '#a855f7' }}>{d.revs}</span></div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px' }}><span style={{ fontSize: '12px', color: txtMid }}>{t.custoConversaoSigla}</span><span style={{ fontSize: '12px', fontWeight: 600, color: txtHi }}>{d.cpr > 0 ? `R$ ${d.cpr}` : '—'}</span></div>
                              {d.potenciais > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '24px' }}><span style={{ fontSize: '12px', color: txtMid }}>Em potencial</span><span style={{ fontSize: '12px', fontWeight: 600, color: '#f59e0b' }}>+{d.potenciais}</span></div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="leads" name="Leads" fill="#10b981" radius={[6,6,0,0]} maxBarSize={40} animationDuration={800} animationEasing="ease-out">
                    <LabelList dataKey="leads" position="top" style={{ fontSize: '11px', fontWeight: 700, fill: '#10b981' }} />
                  </Bar>
                  <Bar dataKey="revs" name={t.convertidoPlural} fill="#a855f7" radius={[6,6,0,0]} maxBarSize={40} animationDuration={800} animationEasing="ease-out">
                    <LabelList dataKey="revs" position="top" style={{ fontSize: '11px', fontWeight: 700, fill: '#a855f7' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              <div style={{ display: 'flex', gap: '24px', justifyContent: 'center', marginTop: '8px' }}>
                {[{ color: '#10b981', label: 'Leads' }, { color: '#a855f7', label: t.convertidoPlural }].map(({ color, label }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: color }} />
                    <span style={{ fontSize: '12px', color: txtMid, fontWeight: 500 }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* RANKING LATERAL — Top 5 por Score */}
            <div style={{ background: cardBg, borderRadius: '16px', border: `1px solid ${border}`, padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '520px', overflowY: 'auto' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: txtHi, margin: '0 0 2px' }}>Top Campanhas</h3>
              {rankedRows.map((r, i) => {
                const color = scoreColor(r.score);
                const camp = campaigns.find(c => c.id === r.id);
                const campCreatedMs = camp?.created_time ? new Date(camp.created_time).getTime() : 0;
                const campAgeDays = campCreatedMs > 0
                  ? Math.floor((Date.now() - campCreatedMs) / (1000*60*60*24))
                  : 999;
                const isNew = campAgeDays <= 7;
                // ageDays para exibição no painel (dias ativo)
                const allLeadsList = allCampLeadsMap.get(r.id) || [];
                const oldest = allLeadsList.length > 0
                  ? Math.min(...allLeadsList.map(l => new Date((l as any).created_at || Date.now()).getTime()))
                  : 0;
                const ageDays = Math.floor((Date.now() - oldest) / (1000*60*60*24));
                // potenciais: leads movidos para preConvertidoStatus no período
                const allLeadsForRanking = allCampLeadsMap.get(r.id) || [];
                const potenciais = preConvertidoStatus != null
                  ? filterPotenciaisByPreset(allLeadsForRanking, preConvertidoStatus, datePreset).length
                  : 0;
                const comCPR = rankedRows.filter(x => x.cpr > 0);
                const mCPR = comCPR.length > 0 ? comCPR.reduce((s, x) => s + x.cpr, 0) / comCPR.length : 0;
                const comCPL = rankedRows.filter(x => x.cpl > 0);
                const mCPL = comCPL.length > 0 ? comCPL.reduce((s, x) => s + x.cpl, 0) / comCPL.length : 0;
                return (
                  <div
                    key={r.id}
                    onClick={() => setSelectedCamp({
                      r,
                      isNew,
                      potenciais,
                      ageDays,
                      criteria: gerarCriterios(r, rankedRows, mCPR, mCPL, isNew, potenciais, t),
                    })}
                    style={{ padding: '12px 14px', borderRadius: '12px', border: `1px solid ${border}`, background: dark ? 'rgba(255,255,255,0.02)' : '#fafafa', cursor: 'pointer', overflow: 'hidden', maxWidth: '100%' }}
                  >
                    {/* Posição + nome */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span style={{ fontSize: '10px', fontWeight: 800, color, background: `${color}18`, padding: '2px 7px', borderRadius: '99px', flexShrink: 0 }}>
                        #{i + 1}
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: txtHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, maxWidth: '160px' }}>
                        {r.name}
                      </span>
                      {isNew && (
                        <span style={{ fontSize: '9px', color: '#3b82f6', fontWeight: 700, flexShrink: 0 }}>nova</span>
                      )}
                    </div>
                    {/* Métricas */}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', fontWeight: 800, color: '#a855f7' }}>{r.rev} {t.convertidoCurto}</span>
                      {potenciais > 0 && (
                        <span style={{ fontSize: '11px', color: txtMid }}>+{potenciais} pot</span>
                      )}
                      <span style={{ fontSize: '11px', color: txtMid, marginLeft: 'auto' }}>
                        {r.cpr > 0 ? `${t.custoConversaoSigla} R$${Math.round(r.cpr)}` : r.leads > 0 ? `${r.leads} leads` : '—'}
                      </span>
                    </div>
                    {/* Barra de score — cor sólida baseada no score */}
                    <div style={{ position: 'relative' }}>
                      <div style={{ height: '6px', borderRadius: '99px', background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${r.score}%`,
                          borderRadius: '99px',
                          background: scoreColorSolid(r.score),
                          transition: 'width 1s cubic-bezier(0.16,1,0.3,1)',
                        }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <span style={{ fontSize: '10px', color: txtMid }}>{scoreLabel(r.score, isNew)}</span>
                        <span style={{ fontSize: '10px', fontWeight: 700, color: scoreColorSolid(r.score) }}>{r.score}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Meta Ads Manager */}
        <div style={{background:cardBg,borderRadius:'16px',border:`1px solid ${border}`,overflow:'hidden',marginTop:'24px'}}>
          {/* Facebook-style flat tab bar */}
          <div style={{display:'flex', borderBottom:`1px solid ${border}`, background: dark ? '#0d0d0f' : '#ffffff', alignItems:'flex-end', padding:'0', height: isMobile ? '48px' : '60px', overflowX: isMobile ? 'auto' : 'visible', WebkitOverflowScrolling: 'touch' as any, flexShrink: 0}}>
            {/* Tab Campanhas */}
            <button
              onClick={() => setActiveLevel('campanhas')}
              className="tab-btn"
              style={{
                color: activeLevel==='campanhas' ? '#2563eb' : txtMid,
                fontWeight: activeLevel==='campanhas' ? 700 : 500,
                borderBottom: activeLevel==='campanhas' ? '3px solid #2563eb' : '3px solid transparent',
              }}
            >
              <Folder size={16} style={{flexShrink:0}}/>
              Campanhas
              {selectedCampIds.size > 0 && (
                <span style={{
                  display:'inline-flex',alignItems:'center',gap:'5px',
                  background: activeLevel === 'campanhas' ? '#2563eb' : (dark ? '#27272a' : '#e4e4e7'),
                  color: activeLevel === 'campanhas' ? '#fff' : (dark ? '#d4d4d8' : '#3f3f46'),
                  padding:'3px 9px',borderRadius:'99px',fontSize:'11px',fontWeight:600,flexShrink:0,marginLeft:'6px'
                }}>
                  {selectedCampIds.size} selecionado{selectedCampIds.size > 1 ? 's' : ''}
                  <span onClick={e=>{e.stopPropagation();setSelectedCampIds(new Set());}} style={{cursor:'pointer',fontSize:'10px',lineHeight:1,display:'inline-flex',alignItems:'center',background:'rgba(0,0,0,0.1)',padding:'1px',borderRadius:'50%',marginLeft:'2px'}}>✕</span>
                </span>
              )}
            </button>

            {/* Tab Conjuntos */}
            <button
              onClick={() => { setActiveLevel('conjuntos'); setSelectedAdIds(new Set()); }}
              className="tab-btn"
              style={{
                color: activeLevel==='conjuntos' ? '#2563eb' : txtMid,
                fontWeight: activeLevel==='conjuntos' ? 700 : 500,
                borderBottom: activeLevel==='conjuntos' ? '3px solid #2563eb' : '3px solid transparent',
              }}
            >
              <LayoutGrid size={16} style={{flexShrink:0}}/>
              {selectedCampIds.size > 0
                ? `Conjuntos para ${selectedCampIds.size} campanha${selectedCampIds.size>1?'s':''}`
                : 'Conjuntos'}
              {selectedAdsetIds.size > 0 && (
                <span style={{
                  display:'inline-flex',alignItems:'center',gap:'5px',
                  background: activeLevel === 'conjuntos' ? '#2563eb' : (dark ? '#27272a' : '#e4e4e7'),
                  color: activeLevel === 'conjuntos' ? '#fff' : (dark ? '#d4d4d8' : '#3f3f46'),
                  padding:'3px 9px',borderRadius:'99px',fontSize:'11px',fontWeight:600,flexShrink:0,marginLeft:'6px'
                }}>
                  {selectedAdsetIds.size} selecionado{selectedAdsetIds.size > 1 ? 's' : ''}
                  <span onClick={e=>{e.stopPropagation();setSelectedAdsetIds(new Set());}} style={{cursor:'pointer',fontSize:'10px',lineHeight:1,display:'inline-flex',alignItems:'center',background:'rgba(0,0,0,0.1)',padding:'1px',borderRadius:'50%',marginLeft:'2px'}}>✕</span>
                </span>
              )}
            </button>

            {/* Tab Anúncios */}
            <button
              onClick={() => setActiveLevel('anuncios')}
              className="tab-btn"
              style={{
                color: activeLevel==='anuncios' ? '#2563eb' : txtMid,
                fontWeight: activeLevel==='anuncios' ? 700 : 500,
                borderBottom: activeLevel==='anuncios' ? '3px solid #2563eb' : '3px solid transparent',
              }}
            >
              <Smartphone size={16} style={{flexShrink:0}}/>
              {selectedAdsetIds.size > 0
                ? `Anúncios para ${selectedAdsetIds.size} conjunto${selectedAdsetIds.size>1?'s':''}`
                : selectedCampIds.size > 0
                  ? `Anúncios para ${selectedCampIds.size} campanha${selectedCampIds.size>1?'s':''}`
                  : 'Anúncios'}
              {selectedAdIds.size > 0 && (
                <span style={{
                  display:'inline-flex',alignItems:'center',gap:'5px',
                  background: activeLevel === 'anuncios' ? '#2563eb' : (dark ? '#27272a' : '#e4e4e7'),
                  color: activeLevel === 'anuncios' ? '#fff' : (dark ? '#d4d4d8' : '#3f3f46'),
                  padding:'3px 9px',borderRadius:'99px',fontSize:'11px',fontWeight:600,flexShrink:0,marginLeft:'6px'
                }}>
                  {selectedAdIds.size} selecionado{selectedAdIds.size > 1 ? 's' : ''}
                  <span onClick={e=>{e.stopPropagation();setSelectedAdIds(new Set());}} style={{cursor:'pointer',fontSize:'10px',lineHeight:1,display:'inline-flex',alignItems:'center',background:'rgba(0,0,0,0.1)',padding:'1px',borderRadius:'50%',marginLeft:'2px'}}>✕</span>
                </span>
              )}
            </button>
          </div>
          {/* Conteúdo */}
          {(()=>{
            const mostrarSemToken=metaReady&&orgReady&&(!metaToken||!metaAccount);
            const mostrarLoading=loading&&campaigns.length===0;
            const mostrarVazio=!loading&&!mostrarSemToken&&campaigns.length===0&&metaReady&&orgReady;
            if(mostrarLoading) return <div style={{padding:'40px',textAlign:'center',color:txtMid,fontSize:'13px'}}>Carregando campanhas…</div>;
            if(mostrarSemToken) return (
              <div style={{padding:'48px 32px',textAlign:'center'}}>
                <div style={{fontSize:'32px',marginBottom:'12px'}}>📊</div>
                <p style={{fontSize:'14px',fontWeight:600,color:txtHi,margin:'0 0 6px'}}>Meta Ads não configurado</p>
                <p style={{fontSize:'13px',color:txtMid,margin:'0 0 20px',lineHeight:1.6}}>Configure seu token do Facebook para ver campanhas e métricas aqui.</p>
                <Link to="/meta-ads" style={{display:'inline-flex',alignItems:'center',gap:'6px',padding:'10px 20px',borderRadius:'10px',background:'#2563eb',color:'#fff',textDecoration:'none',fontSize:'13px',fontWeight:600}}>Configurar Meta Ads →</Link>
              </div>
            );
            if(mostrarVazio) return <div style={{padding:'40px',textAlign:'center',color:txtMid,fontSize:'13px'}}>Nenhuma campanha com gasto no período selecionado.</div>;
            const periodo=PERIOD_MAP[datePreset]||'all';
            return (
              <div>
                {/* Barra de ações */}
                {(()=>{
                  const activeSelCount = activeLevel==='campanhas'?selectedCampIds.size:activeLevel==='conjuntos'?selectedAdsetIds.size:selectedAdIds.size;
                  const dupLabel = `Duplicar ${activeLevel==='campanhas'?'campanhas':activeLevel==='conjuntos'?'conjuntos':'anúncios'}`;
                  const canDup = activeSelCount > 0;
                  const canDel = activeSelCount > 0;
                  return isMobile ? (
                    <div style={{background:dark?'#0d0d0f':'#ffffff',borderBottom:`1px solid ${border}`}}>
                      {/* Status pills — full width */}
                      <div style={{display:'flex',alignItems:'center',gap:'6px',padding:'10px 16px'}}>
                        {(['all','ACTIVE'] as const).map(s=>(
                          <button key={s} onClick={()=>setStatusFilter(s)} style={{flex:1,padding:'8px 0',borderRadius:'99px',border:`1px solid ${statusFilter===s?'#2563eb':border}`,background:statusFilter===s?'#2563eb':'transparent',color:statusFilter===s?'#fff':txtMid,fontSize:'13px',cursor:'pointer',fontFamily:'inherit',fontWeight:statusFilter===s?600:400,transition:'all 0.15s'}}>
                            {s==='all'?'Todas':s==='ACTIVE'?'Ativas':'Pausadas'}
                          </button>
                        ))}
                      </div>
                      {/* Search — full width */}
                      <div style={{padding:'0 16px 10px'}}>
                        <div style={{position:'relative'}}>
                          <Search style={{position:'absolute',left:'10px',top:'50%',transform:'translateY(-50%)',width:'14px',height:'14px',color:txtMid,pointerEvents:'none'}}/>
                          <input type="text" placeholder="Buscar campanha..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
                            style={{width:'100%',padding:'9px 32px',borderRadius:'8px',border:`1px solid ${border}`,background:dark?'#1a1a1e':'#f9fafb',color:txtHi,fontSize:'13px',outline:'none',fontFamily:'inherit',boxSizing:'border-box'}}
                          />
                          {searchQuery&&<button onClick={()=>setSearchQuery('')} style={{position:'absolute',right:'10px',top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:txtMid,display:'flex',padding:'2px'}}><X style={{width:'13px',height:'13px'}}/></button>}
                        </div>
                      </div>
                      {/* Colunas + Gerenciador — side by side */}
                      <div style={{display:'flex',gap:'8px',padding:'0 16px 10px'}}>
                        <button onClick={()=>setShowColumnPicker(true)} style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',gap:'6px',padding:'9px',borderRadius:'8px',border:`1px solid ${border}`,background:'transparent',color:txtHi,fontSize:'13px',cursor:'pointer',fontFamily:'inherit'}}>
                          <Settings size={14}/><span>Colunas</span>
                        </button>
                        <button onClick={()=>window.open('https://adsmanager.facebook.com','_blank')} style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',gap:'6px',padding:'9px',borderRadius:'8px',border:`1px solid ${border}`,background:'transparent',color:txtHi,fontSize:'13px',cursor:'pointer',fontFamily:'inherit'}}>
                          <ExternalLink size={14}/><span>Gerenciador</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{display:'flex',alignItems:'center',gap:'8px',padding:'10px 16px',background:dark?'#0d0d0f':'#ffffff',borderBottom:`1px solid ${border}`}}>
                      <button onClick={()=>setShowColumnPicker(true)} title="Personalizar colunas" className="toolbar-btn" style={{color:txtHi,flexShrink:0}}>
                        <Settings size={14}/>
                        <span>Colunas</span>
                      </button>
                      <div style={{width:'1px',height:'16px',background:border,flexShrink:0}}/>
                      <div style={{display:'flex',alignItems:'center',gap:'4px',flexShrink:0}}>
                        {(['all','ACTIVE'] as const).map(s=>(
                          <button key={s} onClick={()=>setStatusFilter(s)} style={{padding:'5px 10px',borderRadius:'99px',border:`1px solid ${statusFilter===s?'#2563eb':border}`,background:statusFilter===s?'#2563eb':'transparent',color:statusFilter===s?'#fff':txtMid,fontSize:'12px',cursor:'pointer',fontFamily:'inherit',fontWeight:statusFilter===s?600:400,transition:'all 0.15s'}}>
                            {s==='all'?'Todas':s==='ACTIVE'?'Ativas':'Pausadas'}
                          </button>
                        ))}
                      </div>
                      <div style={{width:'1px',height:'16px',background:border,flexShrink:0}}/>
                      <div style={{position:'relative',flex:1,minWidth:'100px',maxWidth:'260px'}}>
                        <Search style={{position:'absolute',left:'10px',top:'50%',transform:'translateY(-50%)',width:'14px',height:'14px',color:txtMid,pointerEvents:'none'}}/>
                        <input type="text" placeholder="Buscar..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
                          style={{width:'100%',padding:'7px 32px 7px 32px',borderRadius:'8px',border:`1px solid ${border}`,background:dark?'#1a1a1e':'#f9fafb',color:txtHi,fontSize:'12.5px',outline:'none',fontFamily:'inherit',boxSizing:'border-box'}}
                        />
                        {searchQuery&&<button onClick={()=>setSearchQuery('')} style={{position:'absolute',right:'8px',top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:txtMid,display:'flex',padding:'2px'}}><X style={{width:'12px',height:'12px'}}/></button>}
                      </div>
                      <div style={{flex:1}}/>
                      <button onClick={()=>window.open('https://adsmanager.facebook.com','_blank')} className="toolbar-btn" style={{color:txtHi,flexShrink:0}}>
                        <ExternalLink size={14}/>
                        <span>Gerenciador</span>
                      </button>
                      <div style={{width:'1px',height:'16px',background:border,flexShrink:0}}/>
                      <button onClick={canDup?handleDuplicate:undefined} disabled={!canDup} className="toolbar-btn" style={{color:canDup?txtHi:txtLow,flexShrink:0}}>
                        <Copy size={14}/>
                        <span>{dupLabel}</span>
                        <ChevronDown size={13}/>
                      </button>
                      <div style={{width:'1px',height:'16px',background:border,flexShrink:0}}/>
                      <button onClick={canDel?handleDelete:undefined} disabled={!canDel} title="Excluir selecionados" className="toolbar-btn btn-danger" style={{color:canDel?'#ef4444':txtLow,flexShrink:0}}>
                        <Trash2 size={14}/>
                      </button>
                      <div style={{width:'1px',height:'16px',background:border,flexShrink:0}}/>
                      {lastLoadTime&&<span style={{fontSize:'11px',color:txtMid,flexShrink:0,whiteSpace:'nowrap'}}>{`Atualizado há ${Math.floor((Date.now()-lastLoadTime.getTime())/60000)} min`}</span>}
                      <button onClick={()=>{const k=`meta_camp_${orgId}_${datePreset}`;sessionStorage.removeItem(k);load();}} disabled={loading} style={{padding:'8px 16px',borderRadius:'6px',background:'#2563eb',color:'#fff',fontSize:'13px',fontWeight:600,cursor:loading?'not-allowed':'pointer',border:'none',fontFamily:'inherit',display:'flex',alignItems:'center',gap:'5px',opacity:loading?0.7:1,flexShrink:0}}>
                        <RefreshCw size={12} style={{animation:loading?'spin 1s linear infinite':'none'}}/>
                        {loading?'Carregando…':'Atualizar'}
                      </button>
                    </div>
                  );
                })()}
                {/* Cards mobile - REMOVIDO: usa tabela com scroll horizontal */}
                {false && (
                  <div>
                    {displayedCampaigns.map(camp=>{
                      const crmLeads=getCampLeads(camp.name,camp.id);
                      const campLeads=crmLeads.length>0?crmLeads.length:camp.leads_api;
                      const campRev=getCampRevs(camp.name,camp.id).length;
                      const campCpl=campLeads>0&&camp.spend>0?camp.spend/campLeads:0;
                      const campScore=campScores.get(camp.id)??50;
                      const campScoreCor=scoreColorSolid(campScore);
                      const isCampExp=expandedCampaigns.has(camp.id);
                      const q=searchQuery.trim().toLowerCase();
                      if(q&&!camp.name.toLowerCase().includes(q))return null;
                      return(
                        <div key={camp.id} style={{borderBottom:`1px solid ${border}`}}>
                          {/* Campaign card */}
                          <div style={{padding:'14px 16px',background:selectedCampIds.has(camp.id)?dark?'rgba(37,99,235,0.06)':'#eff6ff':'transparent'}}>
                            <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'12px'}}>
                              <div onClick={e=>{e.stopPropagation();!togglingCampaigns.has(camp.id)&&toggleStatus(camp.id,camp.status,'campaign');}} style={{width:'42px',height:'24px',borderRadius:'99px',background:togglingCampaigns.has(camp.id)?'#9ca3af':camp.status==='ACTIVE'?'#2563eb':'#d1d5db',position:'relative',cursor:togglingCampaigns.has(camp.id)?'not-allowed':'pointer',transition:'background 0.2s',flexShrink:0,opacity:togglingCampaigns.has(camp.id)?0.6:1}}>
                                <div style={{position:'absolute',top:'3px',left:camp.status==='ACTIVE'?'21px':'3px',width:'18px',height:'18px',borderRadius:'50%',background:'#fff',transition:'left 0.2s',boxShadow:'0 1px 3px rgba(0,0,0,0.3)'}}/>
                              </div>
                              <div onClick={()=>toggleExpanded(camp.id)} style={{flex:1,minWidth:0,cursor:'pointer'}}>
                                <div style={{fontSize:'13px',fontWeight:600,color:txtHi,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{camp.name}</div>
                                <div style={{fontSize:'11px',color:camp.status==='ACTIVE'?'#10b981':txtMid,marginTop:'2px'}}>{camp.status==='ACTIVE'?'Ativa':'Pausada'} {(camp.adsets?.length??0)>0?`· ${camp.adsets!.length} conjuntos`:''}</div>
                              </div>
                              {(camp.adsets?.length??0)>0&&(
                                <button onClick={()=>toggleExpanded(camp.id)} style={{background:'none',border:'none',cursor:'pointer',color:txtMid,display:'flex',alignItems:'center',padding:'4px',borderRadius:'6px',flexShrink:0}}>
                                  {isCampExp?<ChevronDown size={16}/>:<ChevronRight size={16}/>}
                                </button>
                              )}
                            </div>
                            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px'}}>
                              <div style={{background:dark?'rgba(255,255,255,0.04)':'#f9fafb',borderRadius:'8px',padding:'10px'}}>
                                <div style={{fontSize:'10px',color:txtMid,marginBottom:'2px',textTransform:'uppercase',letterSpacing:'0.3px'}}>Gasto</div>
                                <div style={{fontSize:'14px',fontWeight:600,color:txtHi}}>R$ {camp.spend.toFixed(2)}</div>
                              </div>
                              <div style={{background:dark?'rgba(16,185,129,0.06)':'#f0fdf4',borderRadius:'8px',padding:'10px'}}>
                                <div style={{fontSize:'10px',color:'#10b981',marginBottom:'2px',textTransform:'uppercase',letterSpacing:'0.3px'}}>CPL</div>
                                <div style={{fontSize:'14px',fontWeight:600,color:'#10b981'}}>{campCpl>0?`R$ ${Math.round(campCpl)}`:'—'}</div>
                              </div>
                              <div onClick={campLeads>0?()=>handleFilterByCampaign(camp.id,camp.name):undefined} style={{background:dark?'rgba(16,185,129,0.08)':'#ecfdf5',borderRadius:'8px',padding:'10px',cursor:campLeads>0?'pointer':'default'}}>
                                <div style={{fontSize:'10px',color:'#10b981',marginBottom:'2px',textTransform:'uppercase',letterSpacing:'0.3px'}}>Leads</div>
                                <div style={{fontSize:'14px',fontWeight:700,color:'#10b981'}}>{campLeads||'—'}</div>
                              </div>
                              <div onClick={campRev>0?()=>handleFilterByCampaignRevs(camp.id,camp.name):undefined} style={{background:dark?'rgba(168,85,247,0.08)':'#faf5ff',borderRadius:'8px',padding:'10px',cursor:campRev>0?'pointer':'default'}}>
                                <div style={{fontSize:'10px',color:'#a855f7',marginBottom:'2px',textTransform:'uppercase',letterSpacing:'0.3px'}}>{t.convertidoCurto}</div>
                                <div style={{fontSize:'14px',fontWeight:700,color:'#a855f7'}}>{campRev||'—'}</div>
                              </div>
                              <div style={{background:dark?'rgba(255,255,255,0.04)':'#f9fafb',borderRadius:'8px',padding:'10px'}}>
                                <div style={{fontSize:'10px',color:txtMid,marginBottom:'2px',textTransform:'uppercase',letterSpacing:'0.3px'}}>Impressões</div>
                                <div style={{fontSize:'14px',fontWeight:600,color:txtHi}}>{camp.impressions>0?camp.impressions.toLocaleString('pt-BR'):'—'}</div>
                              </div>
                              <div style={{background:dark?'rgba(255,255,255,0.04)':'#f9fafb',borderRadius:'8px',padding:'10px'}}>
                                <div style={{fontSize:'10px',color:txtMid,marginBottom:'2px',textTransform:'uppercase',letterSpacing:'0.3px'}}>CTR</div>
                                <div style={{fontSize:'14px',fontWeight:600,color:txtHi}}>{camp.ctr>0?`${camp.ctr.toFixed(2)}%`:'—'}</div>
                              </div>
                            </div>
                          </div>
                          {/* Adsets nested */}
                          {isCampExp&&(camp.adsets||[]).map(as=>{
                            const isAsExp=expandedAdsets.has(as.id);
                            return(
                              <div key={as.id} style={{borderTop:`1px solid ${border}`,background:dark?'rgba(255,255,255,0.02)':'rgba(0,0,0,0.015)'}}>
                                <div style={{padding:'12px 16px 12px 32px'}}>
                                  <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'10px'}}>
                                    <div onClick={()=>!togglingCampaigns.has(as.id)&&toggleStatus(as.id,as.status,'adset')} style={{width:'36px',height:'20px',borderRadius:'99px',background:togglingCampaigns.has(as.id)?'#9ca3af':as.status==='ACTIVE'?'#2563eb':'#d1d5db',position:'relative',cursor:togglingCampaigns.has(as.id)?'not-allowed':'pointer',transition:'background 0.2s',flexShrink:0,opacity:togglingCampaigns.has(as.id)?0.6:1}}>
                                      <div style={{position:'absolute',top:'2px',left:as.status==='ACTIVE'?'18px':'2px',width:'16px',height:'16px',borderRadius:'50%',background:'#fff',transition:'left 0.2s',boxShadow:'0 1px 2px rgba(0,0,0,0.2)'}}/>
                                    </div>
                                    <div style={{flex:1,minWidth:0}}>
                                      <div style={{fontSize:'12px',fontWeight:600,color:txtHi,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{as.name}</div>
                                      <div style={{fontSize:'10px',color:txtMid}}>Conjunto · {as.status==='ACTIVE'?'Ativo':'Pausado'}</div>
                                    </div>
                                    {(as.ads?.length??0)>0&&(
                                      <button onClick={()=>toggleExpandedAdset(as.id)} style={{background:'none',border:'none',cursor:'pointer',color:txtMid,display:'flex',alignItems:'center',padding:'2px',flexShrink:0}}>
                                        {isAsExp?<ChevronDown size={14}/>:<ChevronRight size={14}/>}
                                      </button>
                                    )}
                                  </div>
                                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px'}}>
                                    <div style={{background:dark?'rgba(255,255,255,0.04)':'#f9fafb',borderRadius:'6px',padding:'8px'}}>
                                      <div style={{fontSize:'9px',color:txtMid,marginBottom:'1px',textTransform:'uppercase'}}>Gasto</div>
                                      <div style={{fontSize:'12px',fontWeight:600,color:txtHi}}>R$ {as.spend.toFixed(2)}</div>
                                    </div>
                                    <div onClick={as.leads_api>0?()=>handleFilterByAdSet(camp.id,camp.name,as.id,as.name):undefined} style={{background:dark?'rgba(16,185,129,0.08)':'#ecfdf5',borderRadius:'6px',padding:'8px',cursor:as.leads_api>0?'pointer':'default'}}>
                                      <div style={{fontSize:'9px',color:'#10b981',marginBottom:'1px',textTransform:'uppercase'}}>Leads</div>
                                      <div style={{fontSize:'12px',fontWeight:700,color:'#10b981'}}>{as.leads_api||'—'}</div>
                                    </div>
                                    <div style={{background:dark?'rgba(16,185,129,0.06)':'#f0fdf4',borderRadius:'6px',padding:'8px'}}>
                                      <div style={{fontSize:'9px',color:'#10b981',marginBottom:'1px',textTransform:'uppercase'}}>CPL</div>
                                      <div style={{fontSize:'12px',fontWeight:600,color:'#10b981'}}>{as.cpl>0?`R$ ${Math.round(as.cpl)}`:'—'}</div>
                                    </div>
                                  </div>
                                </div>
                                {/* Ads nested */}
                                {isAsExp&&(as.ads||[]).map(ad=>(
                                  <div key={ad.id} style={{borderTop:`1px solid ${border}`,padding:'10px 16px 10px 48px',background:dark?'rgba(255,255,255,0.01)':'rgba(0,0,0,0.02)'}}>
                                    <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'8px'}}>
                                      <div onClick={()=>!togglingCampaigns.has(ad.id)&&toggleStatus(ad.id,ad.status,'ad')} style={{width:'32px',height:'18px',borderRadius:'99px',background:togglingCampaigns.has(ad.id)?'#9ca3af':ad.status==='ACTIVE'?'#2563eb':'#d1d5db',position:'relative',cursor:togglingCampaigns.has(ad.id)?'not-allowed':'pointer',transition:'background 0.2s',flexShrink:0,opacity:togglingCampaigns.has(ad.id)?0.6:1}}>
                                        <div style={{position:'absolute',top:'2px',left:ad.status==='ACTIVE'?'14px':'2px',width:'14px',height:'14px',borderRadius:'50%',background:'#fff',transition:'left 0.2s',boxShadow:'0 1px 2px rgba(0,0,0,0.2)'}}/>
                                      </div>
                                      {ad.thumbnail_url&&<Thumbnail url={ad.thumbnail_url} name={ad.name} size={24}/>}
                                      <div style={{flex:1,minWidth:0}}>
                                        <div style={{fontSize:'11px',fontWeight:600,color:txtHi,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ad.name}</div>
                                        <div style={{fontSize:'10px',color:txtMid}}>Anúncio</div>
                                      </div>
                                    </div>
                                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'6px'}}>
                                      <div style={{background:dark?'rgba(255,255,255,0.04)':'#f9fafb',borderRadius:'6px',padding:'6px 8px'}}>
                                        <div style={{fontSize:'9px',color:txtMid,textTransform:'uppercase'}}>Gasto</div>
                                        <div style={{fontSize:'11px',fontWeight:600,color:txtHi}}>R$ {ad.spend.toFixed(2)}</div>
                                      </div>
                                      <div onClick={ad.leads_api>0?()=>handleFilterByAd(camp.id,camp.name,as.id,as.name,ad.id,ad.name):undefined} style={{background:dark?'rgba(16,185,129,0.08)':'#ecfdf5',borderRadius:'6px',padding:'6px 8px',cursor:ad.leads_api>0?'pointer':'default'}}>
                                        <div style={{fontSize:'9px',color:'#10b981',textTransform:'uppercase'}}>Leads</div>
                                        <div style={{fontSize:'11px',fontWeight:700,color:'#10b981'}}>{ad.leads_api||'—'}</div>
                                      </div>
                                      <div style={{background:dark?'rgba(16,185,129,0.06)':'#f0fdf4',borderRadius:'6px',padding:'6px 8px'}}>
                                        <div style={{fontSize:'9px',color:'#10b981',textTransform:'uppercase'}}>CPL</div>
                                        <div style={{fontSize:'11px',fontWeight:600,color:'#10b981'}}>{ad.cpl>0?`R$ ${Math.round(ad.cpl)}`:'—'}</div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Tabela — scroll horizontal no mobile */}
                <div style={{background:cardBg,overflowX:'auto',width:'100%',WebkitOverflowScrolling:'touch' as any}}>
                  <div style={{minWidth:isMobile?'820px':'max-content'}}>
                    {/* Header */}
                    <div style={{display:'grid',gridTemplateColumns:gridCols,borderBottom:`1px solid ${border}`,background:dark?'#16161a':'#f9fafb',alignItems:'stretch'}}>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'12px 14px',borderRight:`1px solid ${border}`}}>
                          <input type="checkbox"
                            checked={activeLevel==='campanhas'?selectedCampIds.size===sortedTableData.length&&sortedTableData.length>0:activeLevel==='conjuntos'?selectedAdsetIds.size===sortedTableData.length&&sortedTableData.length>0:selectedAdIds.size===sortedTableData.length&&sortedTableData.length>0}
                            onChange={e=>{
                              const ids=new Set(sortedTableData.map(r=>r.id));
                              if(activeLevel==='campanhas')setSelectedCampIds(e.target.checked?ids:new Set());
                              else if(activeLevel==='conjuntos')setSelectedAdsetIds(e.target.checked?ids:new Set());
                              else setSelectedAdIds(e.target.checked?ids:new Set());
                            }} style={{width:'18px',height:'18px',cursor:'pointer',accentColor:'#2563eb'}}/>
                        </div>
                        {visibleColumns.map((col, idx)=>{
                          const isLast = idx === visibleColumns.length - 1;
                          const cellStyle = { 
                            display:'flex', 
                            alignItems:'center', 
                            padding:'12px 14px', 
                            borderRight: isLast ? 'none' : `1px solid ${border}`, 
                            fontSize:'13px', 
                            fontWeight:800, 
                            color:txtMid, 
                            textTransform:'uppercase' as const,
                            position: 'relative' as const,
                            userSelect: 'none' as const
                          };

                          const tooltipTexts: Partial<Record<ColKey,string>> = {
                            cpl: 'Custo por Lead — Valor investido dividido pelo total de leads gerados no período.',
                            rev: `${t.convertidoPlural} — Leads que foram aprovados e se tornaram ${t.convertidoPlural} oficiais.`,
                            cpr: `${t.custoConversaoCompleto} — Valor investido dividido pelo número de ${t.convertidoPlural} aprovados.`,
                            score: `Pontuação inteligente (0-100) baseada em ${t.custoConversaoSigla}, CPL, volume de leads e ${t.convertidoPlural}. Quanto maior, melhor o custo-benefício.`,
                          };
                          const tooltipTxt = tooltipTexts[col];
                          const infoBadge = tooltipTxt ? <TooltipIcon text={tooltipTxt} dark={dark}/> : null;

                          const resizerHandle = (
                            <div 
                              onMouseDown={(e)=>startResize(col, e)}
                              style={{
                                position: 'absolute',
                                top: 0,
                                right: 0,
                                bottom: 0,
                                width: '6px',
                                cursor: 'col-resize',
                                zIndex: 10,
                                background: 'transparent',
                                transition: 'background 0.15s'
                              }}
                              onMouseEnter={(e)=>{e.currentTarget.style.background = '#2563eb';}}
                              onMouseLeave={(e)=>{e.currentTarget.style.background = 'transparent';}}
                            />
                          );

                          switch(col){
                            case 'status': return (
                              <div key={col} style={{...cellStyle}}>
                                <span>STATUS</span>
                                {resizerHandle}
                              </div>
                            );
                            case 'name': return (
                              <div key={col} style={{...cellStyle}}>
                                <span>NOME</span>
                                {resizerHandle}
                              </div>
                            );
                            case 'score': return (
                              <div key={col} style={{...cellStyle, justifyContent:'center'}}>
                                <span>SCORE</span>
                                {infoBadge}
                                {resizerHandle}
                              </div>
                            );
                            case 'budget': return (
                              <div key={col} style={{...cellStyle, justifyContent:'flex-end'}}>
                                <span>ORÇAMENTO</span>
                                {resizerHandle}
                              </div>
                            );
                            case 'impressions': return (
                              <div key={col} onClick={()=>handleSort('impressions')} style={{...cellStyle, justifyContent:'flex-end', cursor:'pointer', userSelect:'none', color:sortBy==='impressions'?'#2563eb':txtMid}}>
                                <span>IMPRESSÕES</span>
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='impressions'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='impressions'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='impressions'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='impressions'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'clicks': return (
                              <div key={col} onClick={()=>handleSort('clicks')} style={{...cellStyle, justifyContent:'flex-end', cursor:'pointer', userSelect:'none', color:sortBy==='clicks'?'#2563eb':txtMid}}>
                                <span>CLIQUES</span>
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='clicks'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='clicks'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='clicks'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='clicks'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'ctr': return (
                              <div key={col} onClick={()=>handleSort('ctr')} style={{...cellStyle, justifyContent:'flex-end', cursor:'pointer', userSelect:'none', color:sortBy==='ctr'?'#2563eb':txtMid}}>
                                <span>CTR</span>
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='ctr'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='ctr'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='ctr'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='ctr'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'cpm': return (
                              <div key={col} onClick={()=>handleSort('cpm')} style={{...cellStyle, justifyContent:'flex-end', cursor:'pointer', userSelect:'none', color:sortBy==='cpm'?'#2563eb':txtMid}}>
                                <span>CPM</span>
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='cpm'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='cpm'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='cpm'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='cpm'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'leads': return (
                              <div key={col} onClick={()=>handleSort('leads')} style={{...cellStyle, color:sortBy==='leads'?'#2563eb':'#10b981', justifyContent:'flex-end', cursor:'pointer', userSelect:'none'}}>
                                <span>LEADS</span>
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='leads'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='leads'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='leads'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='leads'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'cpl': return (
                              <div key={col} onClick={()=>handleSort('cpl')} style={{...cellStyle, color:sortBy==='cpl'?'#2563eb':'#10b981', justifyContent:'flex-end', cursor:'pointer', userSelect:'none'}}>
                                <span>CPL</span>
                                {infoBadge}
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='cpl'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='cpl'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='cpl'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='cpl'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'rev': return (
                              <div key={col} onClick={()=>handleSort('rev')} style={{...cellStyle, color:sortBy==='rev'?'#2563eb':'#a855f7', justifyContent:'flex-end', cursor:'pointer', userSelect:'none'}}>
                                <span>{t.convertidoCurto.toUpperCase()}</span>
                                {infoBadge}
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='rev'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='rev'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='rev'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='rev'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'cpr': return (
                              <div key={col} onClick={()=>handleSort('cpr')} style={{...cellStyle, color:sortBy==='cpr'?'#2563eb':'#a855f7', justifyContent:'flex-end', cursor:'pointer', userSelect:'none'}}>
                                <span>{t.custoConversaoSigla}</span>
                                {infoBadge}
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='cpr'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='cpr'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='cpr'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='cpr'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            case 'spend': return (
                              <div key={col} onClick={()=>handleSort('spend')} style={{...cellStyle, justifyContent:'flex-end', cursor:'pointer', userSelect:'none', color:sortBy==='spend'?'#2563eb':txtMid}}>
                                <span>GASTO</span>
                                <span style={{display:'inline-flex',flexDirection:'column',marginLeft:'3px',flexShrink:0}}><ChevronUp size={11} style={{opacity:sortBy==='spend'&&sortOrder==='asc'?1:0.6,strokeWidth:sortBy==='spend'&&sortOrder==='asc'?2.5:2,display:'block'}}/><ChevronDown size={11} style={{opacity:sortBy==='spend'&&sortOrder==='desc'?1:0.6,strokeWidth:sortBy==='spend'&&sortOrder==='desc'?2.5:2,display:'block'}}/></span>
                                {resizerHandle}
                              </div>
                            );
                            default: return null;
                          }
                        })}
                      </div>
                    {/* Linhas */}
                    {sortedTableData.map(row=>{
                      const isSelected=activeLevel==='campanhas'?selectedCampIds.has(row.id):activeLevel==='conjuntos'?selectedAdsetIds.has(row.id):selectedAdIds.has(row.id);
                      const scoreCor=row.score!=null?scoreColorSolid(row.score):txtMid;
                      const parentCampName = row.type==='campaign' ? row.name : displayedCampaigns.find(c=>c.id===row.parentCampId)?.name;
                      return (
                        <div key={row.id} style={{borderBottom:`1px solid ${border}`}}>
                          <div style={{display:'grid',gridTemplateColumns:gridCols,alignItems:'stretch',background:isSelected?dark?'rgba(37,99,235,0.06)':'#eff6ff':'transparent',transition:'background 0.15s'}}>
                              <div style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'14px 12px',borderRight:`1px solid ${border}`}}>
                                <input type="checkbox" checked={isSelected} onChange={e=>{
                                  if(activeLevel==='campanhas'){const n=new Set(selectedCampIds);e.target.checked?n.add(row.id):n.delete(row.id);setSelectedCampIds(n);}
                                  else if(activeLevel==='conjuntos'){const n=new Set(selectedAdsetIds);e.target.checked?n.add(row.id):n.delete(row.id);setSelectedAdsetIds(n);}
                                  else{const n=new Set(selectedAdIds);e.target.checked?n.add(row.id):n.delete(row.id);setSelectedAdIds(n);}
                                }} style={{width:'18px',height:'18px',cursor:'pointer',accentColor:'#2563eb'}}/>
                              </div>
                              {visibleColumns.map((col, idx)=>{
                                const isLast = idx === visibleColumns.length - 1;
                                const cellStyle = { display:'flex', alignItems:'center', padding:'14px 12px', borderRight: isLast ? 'none' : `1px solid ${border}` };
                                switch(col){
                                  case 'status': return (
                                    <div key={col} style={{...cellStyle}}>
                                      <div onClick={()=>!togglingCampaigns.has(row.id)&&toggleStatus(row.id,row.status,row.type)} style={{width:'44px',height:'24px',borderRadius:'99px',background:togglingCampaigns.has(row.id)?'#9ca3af':row.status==='ACTIVE'?'#2563eb':'#d1d5db',position:'relative',cursor:togglingCampaigns.has(row.id)?'not-allowed':'pointer',transition:'background 0.2s',opacity:togglingCampaigns.has(row.id)?0.6:1}}>
                                        <div style={{position:'absolute',top:'3px',left:row.status==='ACTIVE'?'23px':'3px',width:'18px',height:'18px',borderRadius:'50%',background:'#fff',transition:'left 0.2s',boxShadow:'0 1px 3px rgba(0,0,0,0.3)'}}/>
                                      </div>
                                    </div>
                                  );
                                  case 'name': return (
                                    <div key={col} style={{...cellStyle, gap:'10px', minWidth:0}}>
                                      {row.thumbnail_url!==undefined&&<Thumbnail url={row.thumbnail_url??null} name={row.name} size={32}/>}
                                      <span style={{fontSize:'13px',fontWeight:400,color:txtHi,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'260px'}}>{row.name}</span>
                                    </div>
                                  );
                                  case 'score': return (
                                    <div key={col} style={{...cellStyle, justifyContent:'center', gap:'8px'}}>
                                      {row.score!=null&&(
                                        <>
                                          <div style={{width:'50px',height:'6px',borderRadius:'3px',background:dark?'#27272a':'#e5e7eb',overflow:'hidden',flexShrink:0}}>
                                            <div style={{height:'100%',width:`${row.score}%`,background:scoreCor,transition:'width 0.3s'}}/>
                                          </div>
                                          <span style={{fontSize:'13px',fontWeight:500,color:scoreCor,minWidth:'32px',textAlign:'right'}}>{row.score}%</span>
                                        </>
                                      )}
                                    </div>
                                  );
                                  case 'budget': return (
                                    <div key={col} style={{...cellStyle, justifyContent:'flex-end', gap:'6px'}}>
                                      {row.type==='ad' ? (
                                        <span style={{fontSize:'13px',color:txtMid}}>—</span>
                                      ) : row.type==='campaign' ? (
                                        row.budget > 0 ? (
                                          editingBudget?.id===row.id ? (
                                            <input autoFocus value={editingBudget.value}
                                              onChange={e=>setEditingBudget({id:row.id,value:e.target.value,level:'campaign'})}
                                              onKeyDown={e=>{if(e.key==='Enter')saveBudget(row.id,editingBudget.value,'campaign');if(e.key==='Escape')setEditingBudget(null);}}
                                              onBlur={()=>editingBudget&&saveBudget(row.id,editingBudget.value,'campaign')}
                                              style={{width:'90px',padding:'6px 8px',borderRadius:'6px',border:'1px solid #2563eb',background:inputBg,color:txtHi,fontSize:'13px',textAlign:'right',fontFamily:'inherit'}}/>
                                          ) : (
                                            <div style={{display:'flex',alignItems:'center',gap:'6px',cursor:'pointer'}} onClick={()=>setEditingBudget({id:row.id,value:row.budget.toFixed(2),level:'campaign'})}>
                                              <span style={{fontSize:'13px',color:txtHi}}>R$ {row.budget.toFixed(2)}</span>
                                              <Edit2 size={12} style={{color:txtMid}}/>
                                            </div>
                                          )
                                        ) : (
                                          <span style={{fontSize:'11px',color:txtMid,fontStyle:'italic'}} title="Campanha ABO: orçamento definido nos conjuntos">Edite nos conjuntos</span>
                                        )
                                      ) : (
                                        /* adset — verificar se pai é CBO */
                                        (()=>{
                                          const parentC = displayedCampaigns.find(c=>c.id===row.parentCampId);
                                          const isCBO = parentC && ((parentC.daily_budget??0)>0||(parentC.lifetime_budget??0)>0);
                                          if (isCBO) return <span style={{fontSize:'11px',color:txtMid,fontStyle:'italic'}} title="Campanha CBO: orçamento gerenciado pela campanha">Gerenciado pela campanha</span>;
                                          return editingBudget?.id===row.id ? (
                                            <input autoFocus value={editingBudget.value}
                                              onChange={e=>setEditingBudget({id:row.id,value:e.target.value,level:'adset'})}
                                              onKeyDown={e=>{if(e.key==='Enter')saveBudget(row.id,editingBudget.value,'adset');if(e.key==='Escape')setEditingBudget(null);}}
                                              onBlur={()=>editingBudget&&saveBudget(row.id,editingBudget.value,'adset')}
                                              style={{width:'90px',padding:'6px 8px',borderRadius:'6px',border:'1px solid #2563eb',background:inputBg,color:txtHi,fontSize:'13px',textAlign:'right',fontFamily:'inherit'}}/>
                                          ) : (
                                            <div style={{display:'flex',alignItems:'center',gap:'6px',cursor:'pointer'}} onClick={()=>setEditingBudget({id:row.id,value:row.budget.toFixed(2),level:'adset'})}>
                                              <span style={{fontSize:'13px',color:row.budget?txtHi:txtMid}}>{row.budget?`R$ ${row.budget.toFixed(2)}`:'—'}</span>
                                              <Edit2 size={12} style={{color:txtMid}}/>
                                            </div>
                                          );
                                        })()
                                      )}
                                    </div>
                                  );
                                  case 'spend': return <div key={col} style={{...cellStyle, fontSize:'13px', color:txtHi, justifyContent:'flex-end', fontWeight:400}}>R$ {row.spend.toFixed(2)}</div>;
                                  case 'impressions': return <div key={col} style={{...cellStyle, fontSize:'13px', color:txtMid, justifyContent:'flex-end', fontWeight:400}}>{(row as any).impressions>0?(row as any).impressions.toLocaleString('pt-BR'):'—'}</div>;
                                  case 'clicks': return <div key={col} style={{...cellStyle, fontSize:'13px', color:txtMid, justifyContent:'flex-end', fontWeight:400}}>{(row as any).clicks>0?(row as any).clicks.toLocaleString('pt-BR'):'—'}</div>;
                                  case 'ctr': return <div key={col} style={{...cellStyle, fontSize:'13px', color:txtMid, justifyContent:'flex-end', fontWeight:400}}>{(row as any).ctr>0?`${(row as any).ctr.toFixed(2)}%`:'—'}</div>;
                                  case 'cpm': return <div key={col} style={{...cellStyle, fontSize:'13px', color:txtMid, justifyContent:'flex-end', fontWeight:400}}>{(row as any).cpm>0?`R$ ${(row as any).cpm.toFixed(2)}`:'—'}</div>;
                                  case 'leads': return (
                                    <div key={col} onClick={()=>{
                                      if(row.leads<=0)return;
                                      if(row.type==='campaign'&&(row as any).fromApi){
                                        toast('Leads rastreados via Meta API — sem UTM correspondente no CRM');
                                        return;
                                      }
                                      if(row.type==='campaign')handleFilterByCampaign(row.id,row.name);
                                      else if(row.type==='adset'){const cn=displayedCampaigns.find(c=>c.id===row.parentCampId);if(cn)handleFilterByAdSet(row.parentCampId!,cn.name,row.id,row.name);}
                                      else{const cn=displayedCampaigns.find(c=>c.id===row.parentCampId);const as_=cn?.adsets?.find(a=>a.id===row.parentAdsetId);if(cn)handleFilterByAd(row.parentCampId!,cn.name,row.parentAdsetId||'',as_?.name||'',row.id,row.name);}
                                    }} style={{...cellStyle, fontSize:'13px', color:'#10b981', justifyContent:'flex-end', fontWeight:500, cursor:row.leads>0?'pointer':'default', gap:'4px'}}>
                                      {row.leads>0?row.leads:'—'}
                                      {row.type==='campaign'&&row.leads>0&&!(row as any).fromApi&&<TrendingUp size={12}/>}
                                      {row.type==='campaign'&&(row as any).fromApi&&row.leads>0&&<span title="Leads via Meta API" style={{fontSize:'9px',color:'#6b7280',fontWeight:400,marginLeft:'2px'}}>API</span>}
                                    </div>
                                  );
                                  case 'cpl': return <div key={col} style={{...cellStyle, fontSize:'13px', color:'#10b981', justifyContent:'flex-end', fontWeight:400}}>{row.cpl>0?`R$ ${row.cpl.toFixed(2)}`:'—'}</div>;
                                  case 'rev': return (
                                    <div key={col} onClick={()=>{
                                      if(row.rev<=0)return;
                                      if(row.type==='campaign')handleFilterByCampaignRevs(row.id,row.name);
                                      else if(row.type==='adset'){const cn=displayedCampaigns.find(c=>c.id===row.parentCampId);if(cn)handleFilterByAdSetRevs(row.parentCampId!,cn.name,row.id,row.name);}
                                    }} style={{...cellStyle, fontSize:'13px', color:'#a855f7', justifyContent:'flex-end', fontWeight:500, cursor:row.rev>0?'pointer':'default'}}>
                                      {row.rev>0?row.rev:'—'}
                                    </div>
                                  );
                                  case 'cpr': return <div key={col} style={{...cellStyle, fontSize:'13px', color:'#a855f7', justifyContent:'flex-end', fontWeight:400}}>{row.cpr>0?`R$ ${row.cpr.toFixed(2)}`:'—'}</div>;
                                  default: return null;
                                }
                              })}
                            </div>
                        </div>
                      );
                    })}
                    {/* Rodapé totais */}
                    {sortedTableData.length>0&&(()=>{
                      const tSpend=sortedTableData.reduce((s,r)=>s+r.spend,0);
                      const tLeads=sortedTableData.reduce((s,r)=>s+r.leads,0);
                      const tRev=sortedTableData.reduce((s,r)=>s+r.rev,0);
                      const lvl=activeLevel==='campanhas'?'CAMPANHA':activeLevel==='conjuntos'?'CONJUNTO':'ANÚNCIO';
                      return(
                        <div style={{display:'grid',gridTemplateColumns:gridCols,background:dark?'#16161a':'#f9fafb',fontWeight:800,borderTop:`2px solid ${border}`,borderBottom:`1px solid ${border}`,alignItems:'stretch'}}>
                          <div style={{borderRight:`1px solid ${border}`,padding:'14px 12px'}}></div>
                          {visibleColumns.map((col, idx)=>{
                            const isLast = idx === visibleColumns.length - 1;
                            const cellStyle = { display:'flex', alignItems:'center', padding:'14px 12px', borderRight: isLast ? 'none' : `1px solid ${border}` };
                            switch(col){
                              case 'name': return <div key={col} style={{...cellStyle, fontSize:'14px', color:txtHi, fontWeight:800}}>{sortedTableData.length} {lvl}{sortedTableData.length!==1?'S':''}</div>;
                              case 'spend': return <div key={col} style={{...cellStyle, fontSize:'14px', color:txtHi, justifyContent:'flex-end', fontWeight:800}}>R$ {tSpend.toFixed(2)}</div>;
                              case 'leads': return <div key={col} style={{...cellStyle, fontSize:'14px', color:'#10b981', justifyContent:'flex-end', fontWeight:800}}>{tLeads}</div>;
                              case 'cpl': return <div key={col} style={{...cellStyle, fontSize:'14px', color:'#10b981', justifyContent:'flex-end', fontWeight:800}}>{tLeads>0?`R$ ${(tSpend/tLeads).toFixed(2)}`:'—'}</div>;
                              case 'rev': return <div key={col} style={{...cellStyle, fontSize:'14px', color:'#a855f7', justifyContent:'flex-end', fontWeight:800}}>{tRev>0?tRev:'—'}</div>;
                              case 'cpr': return <div key={col} style={{...cellStyle, fontSize:'14px', color:'#a855f7', justifyContent:'flex-end', fontWeight:800}}>{tRev>0&&tSpend>0?`R$ ${(tSpend/tRev).toFixed(2)}`:'—'}</div>;
                              default: return <div key={col} style={{...cellStyle}}/>;
                            }
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Insights removido */}
      </div>
    {/* Modal seletor de colunas */}
    {showColumnPicker && (
      <div onClick={()=>setShowColumnPicker(false)} style={{position:'fixed',inset:0,zIndex:10001,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',padding:'16px'}}>
        <div onClick={e=>e.stopPropagation()} style={{background:dark?'#161619':'#fff',borderRadius:'16px',border:`1px solid ${border}`,width:'100%',maxWidth:'360px',boxShadow:'0 20px 60px rgba(0,0,0,0.3)',display:'flex',flexDirection:'column',maxHeight:'90vh'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'20px 20px 16px'}}>
            <h3 style={{margin:0,fontSize:'15px',fontWeight:700,color:txtHi}}>Personalizar colunas</h3>
            <button onClick={()=>setShowColumnPicker(false)} style={{border:'none',background:'transparent',cursor:'pointer',color:txtMid,display:'flex',alignItems:'center'}}><X size={18}/></button>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:'4px',padding:'0 20px',overflowY:'auto',flex:1}}>
            {orderedColumns.map((c, index)=>{
              const k = c.key as ColKey;
              const isRequired = k === 'status' || k === 'name';
              const isVisible = visibleColumns.includes(k);
              return (
                <div key={c.key} style={{display:'flex',alignItems:'center',gap:'12px',padding:'10px 12px',borderRadius:'8px',background:isVisible?dark?'rgba(37,99,235,0.08)':'#eff6ff':'transparent',border:`1px solid ${isVisible?'#2563eb':border}`,transition:'all 0.15s'}}>
                  <div onClick={()=>{
                      if (isRequired) return;
                      setVisibleColumns(prev=>{
                        if (isVisible) return prev.filter(x=>x!==k);
                        const newVis = [...prev, k];
                        return newVis.sort((a,b) => orderedColumns.findIndex(oc=>oc.key===a) - orderedColumns.findIndex(oc=>oc.key===b));
                      });
                    }}
                    style={{display:'flex',alignItems:'center',gap:'12px',cursor:isRequired?'default':'pointer',flex:1}}>
                    <div style={{width:'16px',height:'16px',borderRadius:'4px',border:`2px solid ${isVisible?'#2563eb':txtLow}`,background:isVisible?'#2563eb':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,opacity:isRequired?0.5:1}}>
                      {isVisible&&<div style={{width:'8px',height:'8px',background:'#fff',borderRadius:'1px'}}/>}
                    </div>
                    <span style={{fontSize:'13px',color:txtHi,fontWeight:isVisible?500:400}}>
                      {c.label}{isRequired&&<span style={{fontSize:'11px',color:txtLow,marginLeft:'4px'}}>(obrigatório)</span>}
                    </span>
                  </div>
                  <div style={{display:'flex', gap:'4px'}}>
                    <button disabled={index===0} onClick={(e)=>{
                      e.stopPropagation();
                      const newOrd = [...orderedColumns];
                      [newOrd[index-1], newOrd[index]] = [newOrd[index], newOrd[index-1]];
                      setOrderedColumns(newOrd);
                      setVisibleColumns(prev => [...prev].sort((a,b) => newOrd.findIndex(oc=>oc.key===a) - newOrd.findIndex(oc=>oc.key===b)));
                    }} style={{background:'transparent',border:'none',cursor:index===0?'default':'pointer',color:index===0?txtLow:txtHi,padding:'4px'}}><ArrowUp size={14}/></button>
                    <button disabled={index===orderedColumns.length-1} onClick={(e)=>{
                      e.stopPropagation();
                      const newOrd = [...orderedColumns];
                      [newOrd[index], newOrd[index+1]] = [newOrd[index+1], newOrd[index]];
                      setOrderedColumns(newOrd);
                      setVisibleColumns(prev => [...prev].sort((a,b) => newOrd.findIndex(oc=>oc.key===a) - newOrd.findIndex(oc=>oc.key===b)));
                    }} style={{background:'transparent',border:'none',cursor:index===orderedColumns.length-1?'default':'pointer',color:index===orderedColumns.length-1?txtLow:txtHi,padding:'4px'}}><ArrowDown size={14}/></button>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Rodapé */}
          <div style={{display:'flex',gap:'8px',padding:'16px 20px',borderTop:`1px solid ${border}`}}>
            <button onClick={()=>{setVisibleColumns([...DEFAULT_VISIBLE_COLS]);setOrderedColumns([...AVAILABLE_COLUMNS]);}} style={{flex:1,padding:'8px',borderRadius:'8px',border:`1px solid ${border}`,background:'transparent',color:txtMid,fontSize:'13px',cursor:'pointer',fontFamily:'inherit'}}>
              Restaurar padrão
            </button>
            <button onClick={()=>setShowColumnPicker(false)} style={{flex:1,padding:'8px',borderRadius:'8px',border:'none',background:'#2563eb',color:'#fff',fontSize:'13px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
              Aplicar
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Painel IA */}
    {showAiPanel && aiLog && (
        <AIOptimizationPanel
          log={aiLog}
          dark={dark}
          isMobile={isMobile}
          allLeads={allLeads}
          onClose={() => setShowAiPanel(false)}
          metaRevs={metaRevsOrg}
          setToast={setToast}
          totalSpend={totalSpend}
          leadsTotal={leadsCRMTotal}
          revsTotal={revsCRMTotal}
          cprVal={cprCard}
          dateLabel={PERIOD_OPTIONS.find(p => p.value === datePreset)?.label || '7 dias'}
          onLogUpdate={(updatedLog) => {
            setAiLog(updatedLog);
            const sugestoesPendentes = (updatedLog.acoes_sugeridas || []).filter((a: any) => String(a?.tipo || '').toLowerCase() !== 'manter');
            if (sugestoesPendentes.length === 0 && updatedLog.status === 'pendente') {
              setAiLog({ ...updatedLog, status: 'executado' });
            }
          }}
          onCampaignStatusChange={(id, tipo, status) => {
            if (tipo === 'pausar_campanha' || tipo === 'pausar') {
              setCampaigns(prev => prev.map(c => c.id === id ? { ...c, status } : c));
            } else if (tipo === 'pausar_adset' || tipo === 'pausar_conjunto') {
              setCampaigns(prev => prev.map(c => ({ ...c, adsets: c.adsets?.map(as => as.id === id ? { ...as, status } : as) })));
            }
            setTimeout(() => setToast?.({ msg: 'Status atualizado na lista', ok: true }), 100);
          }}
        />
      )}

    {/* Modal de detalhes de campanha */}
    {selectedCamp && (
      <div
        onClick={() => setSelectedCamp(null)}
        style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ background: dark ? '#161619' : '#fff', borderRadius: '20px', border: `1px solid ${border}`, width: '100%', maxWidth: '460px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}
        >
          {/* Header do modal */}
          <div style={{ padding: '20px 20px 0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: '11px', fontWeight: 700, color: txtLow, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 4px' }}>Análise de campanha</p>
              <h2 style={{ fontSize: '15px', fontWeight: 700, color: txtHi, margin: 0, lineHeight: 1.3, wordBreak: 'break-word' }}>{selectedCamp.r.fullName}</h2>
            </div>
            <button
              onClick={() => setSelectedCamp(null)}
              style={{ flexShrink: 0, width: '30px', height: '30px', borderRadius: '99px', border: 'none', background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: txtMid, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <X style={{ width: '14px', height: '14px' }} />
            </button>
          </div>

          {/* Score visual */}
          <div style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '16px', borderRadius: '14px', background: dark ? 'rgba(255,255,255,0.03)' : '#f9fafb', border: `1px solid ${border}` }}>
              <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: `${scoreColorSolid(selectedCamp.r.score)}18`, border: `3px solid ${scoreColorSolid(selectedCamp.r.score)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: '18px', fontWeight: 800, color: scoreColorSolid(selectedCamp.r.score) }}>{selectedCamp.r.score}</span>
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700, color: txtHi }}>{scoreLabel(selectedCamp.r.score, selectedCamp.isNew)}</p>
                <div style={{ height: '8px', borderRadius: '99px', background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${selectedCamp.r.score}%`, background: scoreColorSolid(selectedCamp.r.score), borderRadius: '99px', transition: 'width 0.8s ease' }} />
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '11px', color: txtLow }}>
                  {selectedCamp.isNew ? `Nova campanha — ${selectedCamp.ageDays}d de dados` : `${selectedCamp.ageDays} dias ativo`}
                </p>
              </div>
            </div>
          </div>

          {/* Critérios */}
          <div style={{ padding: '0 20px 16px' }}>
            <p style={{ fontSize: '11px', fontWeight: 700, color: txtLow, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 10px' }}>Critérios de avaliação</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {selectedCamp.criteria.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: dark ? 'rgba(255,255,255,0.03)' : '#f9fafb', border: `1px solid ${border}` }}>
                  <span style={{ fontSize: '16px', flexShrink: 0 }}>{c.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: txtHi }}>{c.label}</p>
                    <p style={{ margin: '1px 0 0', fontSize: '11px', color: txtMid }}>{c.detalhe}</p>
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: c.pts > 0 ? '#10b981' : c.pts < 0 ? '#ef4444' : txtLow, flexShrink: 0 }}>
                    {c.pts > 0 ? `+${c.pts}` : c.pts === 0 ? '—' : c.pts}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Métricas 2 colunas */}
          <div style={{ padding: '0 20px 20px' }}>
            <p style={{ fontSize: '11px', fontWeight: 700, color: txtLow, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 10px' }}>Métricas do período</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {[
                { label: 'Leads', value: String(selectedCamp.r.leads), color: '#10b981' },
                { label: t.convertidoPlural, value: String(selectedCamp.r.rev), color: '#a855f7' },
                { label: 'CPL', value: selectedCamp.r.cpl > 0 ? `R$ ${Math.round(selectedCamp.r.cpl)}` : '—', color: txtHi },
                { label: t.custoConversaoSigla, value: selectedCamp.r.cpr > 0 ? `R$ ${Math.round(selectedCamp.r.cpr)}` : '—', color: txtHi },
                { label: 'Investido', value: `R$ ${fmt(selectedCamp.r.spend)}`, color: txtHi },
                { label: 'Em potencial', value: String(selectedCamp.potenciais), color: '#f59e0b' },
              ].map((m, i) => (
                <div key={i} style={{ padding: '10px 12px', borderRadius: '10px', background: dark ? 'rgba(255,255,255,0.03)' : '#f9fafb', border: `1px solid ${border}` }}>
                  <p style={{ margin: '0 0 2px', fontSize: '10px', color: txtLow }}>{m.label}</p>
                  <p style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: m.color }}>{m.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )}
      {/* Modal de confirmação — Duplicar / Excluir */}
      {confirmModal && (
        <div onClick={()=>setConfirmModal(null)} style={{position:'fixed',inset:0,zIndex:10002,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'16px'}}>
          <div onClick={e=>e.stopPropagation()} style={{background:dark?'#161619':'#fff',borderRadius:'16px',border:`1px solid ${border}`,width:'100%',maxWidth:'380px',padding:'24px',boxShadow:'0 24px 64px rgba(0,0,0,0.35)'}}>
            <h3 style={{margin:'0 0 10px',fontSize:'16px',fontWeight:700,color:txtHi}}>
              {confirmModal.type==='duplicate'
                ?`Duplicar ${confirmModal.count} ${confirmModal.label}${confirmModal.count>1?'s':''}?`
                :`Excluir ${confirmModal.count} ${confirmModal.label}${confirmModal.count>1?'s':''}?`}
            </h3>
            <p style={{margin:'0 0 22px',fontSize:'13px',color:txtMid,lineHeight:1.6}}>
              {confirmModal.type==='delete'&&confirmModal.label==='conjunto'
                ?'Ao excluir conjuntos, todos os anúncios dentro deles também serão excluídos. Esta ação não pode ser desfeita.'
                :confirmModal.type==='delete'
                  ?'Esta ação não pode ser desfeita.'
                  :`${confirmModal.count} ${confirmModal.label}${confirmModal.count>1?'s':''} ser${confirmModal.count>1?'ão':'á'} duplicado${confirmModal.count>1?'s':''} como pausado${confirmModal.count>1?'s':''}.`}
            </p>
            <div style={{display:'flex',gap:'8px',justifyContent:'flex-end'}}>
              <button onClick={()=>setConfirmModal(null)} style={{padding:'8px 20px',borderRadius:'8px',border:`1px solid ${border}`,background:'transparent',color:txtMid,fontSize:'13px',fontWeight:500,cursor:'pointer',fontFamily:'inherit'}}>
                Cancelar
              </button>
              <button
                onClick={()=>{const m=confirmModal;setConfirmModal(null);m.type==='duplicate'?executeDuplicate():executeDelete();}}
                style={{padding:'8px 20px',borderRadius:'8px',border:'none',background:confirmModal.type==='duplicate'?'#2563eb':'#ef4444',color:'#fff',fontSize:'13px',fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}
              >
                {confirmModal.type==='duplicate'?'Duplicar':'Excluir'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast&&(
        <div style={{position:'fixed',bottom:'24px',right:'24px',zIndex:99999,padding:'12px 20px',borderRadius:'12px',background:toast.ok?'#10b981':'#ef4444',color:'#fff',fontSize:'13px',fontWeight:600,boxShadow:'0 8px 24px rgba(0,0,0,0.2)',animation:'slideUp 0.3s ease'}}>
          {toast.ok?'✓':'✕'} {toast.msg}
        </div>
      )}
      <style>{`
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes ping{75%,100%{transform:scale(2.2);opacity:0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes slideUp{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}
        .tooltip-wrap{position:relative;display:inline-flex;align-items:center;}
        .tooltip-box{display:none;position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);font-size:11px;font-weight:400;padding:6px 10px;border-radius:6px;width:max-content;max-width:220px;white-space:normal;text-align:center;z-index:9999;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.25);line-height:1.5;}
        .tooltip-box::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;}
        .tooltip-wrap:hover .tooltip-box{display:block;}
        .tooltip-light{background:#1f2937;color:#f9fafb;}
        .tooltip-light::after{border-top-color:#1f2937;}
        .tooltip-dark{background:#e4e4e7;color:#18181b;border:1px solid #d4d4d8;}
        .tooltip-dark::after{border-top-color:#e4e4e7;}

        /* Premium Tooltip Animation */
        @keyframes tooltipFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-95%); }
          to { opacity: 1; transform: translateX(-50%) translateY(-100%); }
        }
        .tooltip-premium {
          animation: tooltipFadeIn 0.18s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        /* Facebook-style Tab Button */
        .tab-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          height: 100%;
          flex: 1;
          padding: 0 24px;
          font-size: 13.5px;
          background: transparent;
          border: none;
          cursor: pointer;
          transition: all 0.2s ease;
          position: relative;
          user-select: none;
          font-family: inherit;
        }
        .tab-btn:hover {
          background: rgba(120, 120, 120, 0.05);
        }

        /* Spacious Borderless Action Toolbar Button */
        .toolbar-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 8px 14px;
          border-radius: 6px;
          background: transparent;
          border: none;
          color: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          font-family: inherit;
          user-select: none;
        }
        .toolbar-btn:hover:not(:disabled) {
          background: rgba(120, 120, 120, 0.08);
        }
        .toolbar-btn:active:not(:disabled) {
          transform: scale(0.97);
        }
        .toolbar-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .toolbar-btn.btn-danger:hover:not(:disabled) {
          background: rgba(239, 68, 68, 0.08);
        }
      `}</style>
    </AppLayout>
  );
}

// ── Componentes do Painel de Otimização IA ───────────────────────────────────

function AIOptimizationPanel({ log, dark, isMobile, allLeads, onClose, metaRevs = 0, setToast, onLogUpdate, onCampaignStatusChange, totalSpend = 0, leadsTotal = 0, revsTotal = 0, cprVal = 0, dateLabel = 'Últimos 7 dias' }: { log: any; dark: boolean; isMobile: boolean; allLeads: any[]; onClose: () => void; metaRevs?: number; setToast?: (t: {msg: string; ok: boolean} | null) => void; onLogUpdate?: (log: any) => void; onCampaignStatusChange?: (id: string, tipo: string, status: string) => void; totalSpend?: number; leadsTotal?: number; revsTotal?: number; cprVal?: number; dateLabel?: string; }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const t = useTerminology();

  // Estado interno de sugestões — banco é a fonte de verdade, sem localStorage
  const getTipoAcao = (acao: any) => String(acao?.tipo || '').toLowerCase();
  const isSugestaoVisivel = (acao: any) => {
    const tipo = getTipoAcao(acao);
    return tipo !== 'manter' && tipo !== 'criar_campanha';
  };
  const [sugestoes, setSugestoes] = useState<any[]>(() =>
    (Array.isArray(log.acoes_sugeridas) ? log.acoes_sugeridas : []).filter(isSugestaoVisivel)
  );
  const [aplicandoIds, setAplicandoIds] = useState<Set<string>>(new Set());

  const txtHi = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#a1a1aa' : '#6b7280';
  const border = dark ? '#1e1e22' : '#e5e7eb';
  const cardBg = dark ? '#161619' : '#fff';
  const panelBg = dark ? '#0d0d18' : '#f5f7ff';
  const txtLow = dark ? '#52525b' : '#9ca3af';
  const campanhaMestre = log.campanha_mestre || (log.acoes_sugeridas || []).find((a: any) => a.tipo === 'criar_campanha') || null;

  const fmtMoeda = (n: number) => n > 0 ? `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

  const analises = Array.isArray(log.analise_campanhas) ? log.analise_campanhas : (Array.isArray(log.insights) ? log.insights : []);
  const metricas7d = log.metricas_7d || {};
  const convertidoLabel = metricas7d.convertido_label || log.funil_analisado?.convertido_label || t.convertidoPlural;
  const totalLeadsAnalise = Number(metricas7d.leads ?? log.total_leads ?? leadsTotal ?? 0);
  const totalGastoAnalise = Number(metricas7d.gasto ?? log.total_gasto ?? totalSpend ?? 0);
  const cplAnalise = Number(metricas7d.cpl ?? log.cpl_medio ?? (totalLeadsAnalise > 0 ? totalGastoAnalise / totalLeadsAnalise : 0));
  const convertidosAnalise = Number(metricas7d.convertido ?? analises.reduce((sum: number, a: any) => sum + Number(a.revendedoras || 0), 0) ?? revsTotal ?? 0);
  const cprAnalise = Number(metricas7d.cpr ?? (convertidosAnalise > 0 ? totalGastoAnalise / convertidosAnalise : cprVal ?? 0));
  const fmtInteiro = (n: number) => Math.round(Number(n || 0)).toLocaleString('pt-BR');
  const metricasBase = [
    { label: 'Investido', value: fmtMoeda(totalGastoAnalise) },
    { label: 'Leads', value: fmtInteiro(totalLeadsAnalise) },
    { label: convertidoLabel, value: fmtInteiro(convertidosAnalise) },
    { label: 'CPL', value: fmtMoeda(cplAnalise) },
    { label: 'Custo/' + convertidoLabel, value: fmtMoeda(cprAnalise) },
  ];
  const prioridadeDecisao: Record<string, number> = { escalar: 0, otimizar: 1, pausar: 2, reduzir: 2, manter: 3, aguardar: 4 };
  const chaveAnaliseCampanha = (a: any) => {
    const nome = String(a?.campanha_nome || a?.campanha_curta || '');
    const match = nome.match(/BCK\s*\d+/i);
    return match ? match[0].toUpperCase().replace(/\s+/, ' ') : (nome.split(' - ')[0] || nome || 'Campanha').toLowerCase();
  };
  const campanhasLidas = Array.from(new Map(
    [...analises]
      .filter((a: any) => a?.campanha_nome || a?.campanha_curta)
      .sort((a: any, b: any) => (prioridadeDecisao[a.decisao] ?? 5) - (prioridadeDecisao[b.decisao] ?? 5))
      .map((a: any) => [chaveAnaliseCampanha(a), a])
  ).values());
  const decisaoVisual = (decisao: string) => {
    const d = (decisao || '').toLowerCase();
    if (d.includes('escalar')) return { label: 'Observei escala', color: '#7c3aed', bg: dark ? 'rgba(124,58,237,0.14)' : '#f3e8ff' };
    if (d.includes('pausar')) return { label: 'Observei risco', color: '#e11d48', bg: dark ? 'rgba(225,29,72,0.14)' : '#fff1f2' };
    if (d.includes('otimizar') || d.includes('reduzir')) return { label: 'Observei custo', color: '#2563eb', bg: dark ? 'rgba(37,99,235,0.14)' : '#eff6ff' };
    return { label: 'Observei', color: txtMid, bg: dark ? 'rgba(255,255,255,0.06)' : '#f8fafc' };
  };
  const textoCampanha = (a: any) => {
    const d = String(a.decisao || '').toLowerCase();
    const detalhe = a.porque ? a.porque : (a.proximo_passo ? a.proximo_passo : (a.motivo ? a.motivo : ''));
    let acaoFeita: any = null;
    for (const item of acoesAutomaticas) {
      const base = String(a.campanha_nome ? a.campanha_nome : (a.campanha_curta ? a.campanha_curta : '')).toLowerCase();
      const alvo = String(item.campanha_nome ? item.campanha_nome : (item.nome ? item.nome : '')).toLowerCase();
      if (base) { if (alvo.includes(base)) { acaoFeita = item; } }
    }
    if (acaoFeita) { if (acaoFeita.ok !== false) { const antigo = acaoFeita.antigo_budget ? 'R$ ' + acaoFeita.antigo_budget : 'orcamento anterior'; const novo = acaoFeita.novo_budget ? 'R$ ' + acaoFeita.novo_budget : 'novo orcamento'; return ('Eu alterei essa campanha: ' + antigo + ' para ' + novo + '. ' + detalhe).trim(); } }
    if (d.includes('escalar')) return ('Eu encontrei potencial de escala porque ela esta convertendo melhor que o restante. ' + detalhe).trim();
    if (d.includes('pausar')) return ('Eu marquei risco alto antes de consumir mais verba sem retorno em ' + convertidoLabel + '. ' + detalhe).trim();
    if (d.includes('otimizar') || d.includes('reduzir')) return ('Eu marquei custo em atencao e separei os pontos que estao puxando desperdicio. ' + detalhe).trim();
    return ('Eu mantive em observacao por enquanto. ' + (detalhe || 'Ainda nao tem um sinal forte o bastante para alterar o orcamento.')).trim();
  };
  function limparInsight(texto: string): string {
    if (!texto) return '';
    let limpo = texto.replace(/\([^)]{0,120}\)/g, '');
    limpo = limpo.replace(/\s{2,}/g, ' ').trim();
    const frases = limpo.split(/(?<=[.!?])\s+/).filter(f => f.trim().length > 10);
    return frases.slice(0, 3).join(' ');
  }

  function truncarAlerta(texto: string): string {
    if (!texto) return '';
    const frases = texto.split(/(?<=[.!?])\s+/);
    return frases.slice(0, 2).join(' ');
  }

  const isPendente = log.status === 'pendente';
  const isSemAcao = log.status === 'sem_acao';
  const isErro = log.status === 'erro';
  const metaAlertas = Array.isArray(log.meta_alertas) ? log.meta_alertas : [];
  const acoesDoLog = Array.isArray(log.acoes_executadas) ? log.acoes_executadas : [];
  const acoesAutomaticas = acoesDoLog.filter(function(a: any) { return a.automatico !== false; });
  const acoesUsuario = acoesDoLog.filter(function(a: any) { return a.automatico === false; });
  const alertasMetaGraves = metaAlertas.filter(function(item: any) {
    const texto = String([item.status_facebook,item.status,item.motivo,item.tipo].join(' ')).toUpperCase();
    return ['ACCOUNT','CONTA','DISABLE','BLOQUE','RESTRICT','PAYMENT','PAGAMENTO','PERMISSION'].some(function(term: string) { return texto.includes(term); });
  });
  const humanizarDiagnostico = (key: string, valor: any): string => {
    if (valor == null || valor === false) return '';

    if (key === 'qualidade') {
      const obj = typeof valor === 'string' ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
      if (obj && typeof obj === 'object') {
        if (obj.colapso_geral) {
          const queda = Array.isArray(obj.campanhas_com_queda) ? obj.campanhas_com_queda : [];
          if (queda.length === 0) {
            return 'Colapso geral de qualidade detectado nas campanhas.';
          }
          const lista = queda.map((c: any) => {
            const nome = c.campanha || c.campanha_nome || c.nome || 'Campanha';
            const pct = c.percentual_queda ?? c.queda_pct ?? null;
            return pct != null ? `${nome} (−${pct}%)` : nome;
          }).join(', ');
          return `Queda de qualidade detectada: ${lista}.`;
        }
        return 'Nenhuma queda de qualidade detectada essa semana.';
      }
    }

    if (key === 'fadiga') {
      const obj = typeof valor === 'string' ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
      if (obj && typeof obj === 'object') {
        if (obj.tem_fadiga) {
          const itens: string[] = [];
          const processList = (list: any[]) => {
            if (!Array.isArray(list)) return;
            list.forEach((item: any) => {
              if (!item) return;
              const nome = item.campanha || item.conjunto || item.campanha_nome || item.conjunto_nome || item.nome || 'Item';
              const freq = item.frequencia_media ?? item.frequencia ?? null;
              if (freq != null) {
                itens.push(`${nome} (frequência média: ${freq})`);
              } else {
                itens.push(nome);
              }
            });
          };
          processList(obj.campanhas);
          processList(obj.conjuntos);
          processList(obj.campanhas_fatigadas);
          processList(obj.conjuntos_fatigados);
          processList(obj.itens);
          processList(obj.detalhes);

          if (itens.length > 0) {
            return `Sinais de fadiga detectados em: ${itens.join(', ')}.`;
          }
          return 'Sinais de fadiga de criativo detectados.';
        }
        return 'Nenhum sinal de fadiga de criativo detectado.';
      }
    }

    if (key === 'sinais') {
      const obj = typeof valor === 'string' ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
      if (obj && typeof obj === 'object') {
        return obj.aviso ? String(obj.aviso) : '';
      }
      return typeof valor === 'string' ? valor : '';
    }

    if (key === 'ritmo') {
      const obj = typeof valor === 'string' ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
      if (obj && typeof obj === 'object') {
        const ritmoProjetado = obj.ritmo_projetado ?? '—';
        const metaPeriodo = obj.meta_do_periodo ?? '—';
        const decorridos = obj.dias_uteis_decorridos ?? 0;
        const noPeriodo = obj.dias_uteis_no_periodo ?? 0;
        let frase = `Ritmo projetado: ${ritmoProjetado} contra meta de ${metaPeriodo} (${decorridos} de ${noPeriodo} dias úteis decorridos).`;
        const diasSemOnboarding = obj.dias_sem_onboarding_detectados;
        if (diasSemOnboarding) {
          if (Array.isArray(diasSemOnboarding) && diasSemOnboarding.length > 0) {
            frase += ` (sem contar ${diasSemOnboarding.join(', ')})`;
          } else if (typeof diasSemOnboarding === 'string' && diasSemOnboarding.trim().length > 0) {
            frase += ` (sem contar ${diasSemOnboarding})`;
          }
        }
        return frase;
      }
    }

    if (key === 'canibalizacao') {
      const obj = typeof valor === 'string' ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
      if (obj && typeof obj === 'object') {
        if (obj.tem_canibalizacao) {
          const conflitos: string[] = [];
          const list = Array.isArray(obj.conflitos) ? obj.conflitos :
                       Array.isArray(obj.pares) ? obj.pares :
                       Array.isArray(obj.pares_conflitantes) ? obj.pares_conflitantes :
                       Array.isArray(obj.campanhas_conflitantes) ? obj.campanhas_conflitantes : [];
          list.forEach((item: any) => {
            if (typeof item === 'string') {
              conflitos.push(item);
            } else if (item && typeof item === 'object') {
              const camp1 = item.campanha1 || item.campanha_a || item.campanha_1 || '';
              const conj1 = item.conjunto1 || item.conjunto_a || item.conjunto_1 || '';
              const camp2 = item.campanha2 || item.campanha_b || item.campanha_2 || '';
              const conj2 = item.conjunto2 || item.conjunto_b || item.conjunto_2 || '';
              if (camp1 && camp2) {
                conflitos.push(`${camp1} (${conj1}) vs ${camp2} (${conj2})`);
              } else if (item.resumo || item.descricao) {
                conflitos.push(item.resumo || item.descricao);
              } else {
                conflitos.push(JSON.stringify(item));
              }
            }
          });
          if (conflitos.length > 0) {
            return `Públicos repetidos conflitando em: ${conflitos.join(', ')}.`;
          }
          if (obj.resumo) return String(obj.resumo);
          return 'Conflito de públicos repetidos (canibalização) detectado.';
        }
        return '';
      }
    }

    if (key === 'dados') {
      const obj = typeof valor === 'string' ? (() => { try { return JSON.parse(valor); } catch { return null; } })() : valor;
      if (obj && typeof obj === 'object') {
        const mem = obj.memoria_ravena;
        if (mem && typeof mem === 'object') {
          const partes: string[] = [];
          if (mem.total_analises != null) partes.push(`Essa é a análise número ${mem.total_analises}.`);
          if (mem.melhor_cpr_historico != null) {
            const cprFmt = `R$ ${Number(mem.melhor_cpr_historico).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            partes.push(`Melhor CPR já visto: ${cprFmt}${mem.melhor_cpr_campanha ? ` (${mem.melhor_cpr_campanha})` : ''}.`);
          }
          if (partes.length > 0) return partes.join(' ');
        }
        if (obj.resumo) return String(obj.resumo);
        const { memoria_ravena: _mr, ...rest } = obj as any;
        const bruto = JSON.stringify(rest);
        if (!bruto || bruto === '{}') return '';
        return bruto.replace(/[{}[\]"]/g, '').replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim();
      }
    }

    const bruto = typeof valor === 'string' ? valor : JSON.stringify(valor);
    return bruto
      .replace(/guardrail/gi, 'intervalo de seguranca')
      .replace(/throttle/gi, 'limite de seguranca')
      .replace(/taxa_conv_14d/gi, 'conversao dos ultimos 14 dias')
      .replace(/OFFSITE_CONVERSIONS/gi, 'conversoes da Meta')
      .replace(/colapso de qualidade/gi, 'queda forte na qualidade dos leads')
      .replace(/_/g, ' ')
      .replace(/[{}[\]"]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  const criarDiagnostico = (key: string, titulo: string, valor: any, prioridade: number) => {
    const texto = humanizarDiagnostico(key, valor);
    if (!texto || texto === '{}' || texto === '[]') return null;
    return { key, titulo, texto, prioridade };
  };
  const diagnosticosRavena = [
    criarDiagnostico('qualidade', 'Qualidade dos leads', log.diagnostico_qualidade_lead, 3),
    criarDiagnostico('canibalizacao', 'Publicos repetidos', log.diagnostico_canibalizacao || log['diagnostico_canibalização'] || log['diagnostico_canibalizaÃ§Ã£o'], 4),
    criarDiagnostico('estrutura', 'Estrutura da conta', log.diagnostico_criativo, 4),
    criarDiagnostico('fadiga', 'Fadiga criativa', log.diagnostico_fadiga_criativo, 5),
    criarDiagnostico('sinais', 'Sinal de otimizacao', log.diagnostico_sinais, 6),
    criarDiagnostico('ritmo', 'Ritmo da meta', log.diagnostico_ritmo, 6),
    criarDiagnostico('dados', 'Qualidade dos dados', log.diagnostico_dados, 7),
  ].filter(Boolean).sort((a: any, b: any) => a.prioridade - b.prioridade).slice(0, 6) as any[];

  const nomeCurtoCampanha = (valor: string) => {
    const nome = String(valor || '');
    const match = nome.match(/BCK\s*\d+/i);
    return match ? match[0].toUpperCase().replace(/\s+/, ' ') : (nome.split(' - ')[0] || nome || 'Campanha');
  };
  const chaveCampanha = (valor: string) => nomeCurtoCampanha(valor).toLowerCase();
  const acoesDaCampanha = (campanha: any) => {
    const chave = chaveCampanha(campanha.campanha_nome || campanha.campanha_curta || '');
    const nomeCompleto = String(campanha.campanha_nome || '').toLowerCase();
    const nomeCurto = String(campanha.campanha_curta || '').toLowerCase();
    return acoesAutomaticas.filter(function(item: any) {
      const campos = [item.campanha_nome, item.campanha_curta, item.nome, item.conjunto_nome, item.adset_nome, item.anuncio_nome]
        .filter(Boolean)
        .map(function(valor: any) { return String(valor).toLowerCase(); });
      return chave.length > 0 && campos.some(function(alvo: string) {
        return alvo.includes(chave) || (nomeCompleto && alvo.includes(nomeCompleto)) || (nomeCurto && alvo.includes(nomeCurto));
      });
    });
  };
  const variacaoBudget = (acao: any) => {
    const antigo = Number(acao.antigo_budget || 0);
    const novo = Number(acao.novo_budget || 0);
    if (!antigo || !novo) return 0;
    return Math.round(((novo - antigo) / antigo) * 100);
  };
  const labelAcaoBudget = (acao: any) => {
    const tipo = String(acao.tipo || '').toLowerCase();
    const alvo = tipo.includes('conjunto') ? 'conjunto' : tipo.includes('campanha') ? 'campanha' : tipo.includes('anuncio') ? 'anuncio' : 'orcamento';
    if (tipo.includes('aumentar')) return 'Aumentei o orçamento do ' + alvo;
    if (tipo.includes('reduzir')) return 'Reduzi o orçamento do ' + alvo;
    if (tipo.includes('redistrib')) return 'Redistribui orçamento';
    return 'Ajustei o ' + alvo;
  };
  const visualCampanha = (campanha: any) => {
    const acoes = acoesDaCampanha(campanha);
    if (acoes.length > 0) {
      const deltas = acoes.map(variacaoBudget);
      const subidas = deltas.filter((v: number) => v > 0).length;
      const quedas = deltas.filter((v: number) => v < 0).length;
      if (subidas > 0 && quedas > 0) return { label: 'Redistribuí verba', color: '#7c3aed', bg: dark ? 'rgba(124,58,237,0.14)' : '#f3e8ff' };
      if (subidas > 0) return { label: 'Aumentei orçamento', color: '#2563eb', bg: dark ? 'rgba(37,99,235,0.14)' : '#eff6ff' };
      if (quedas > 0) return { label: 'Reduzi orçamento', color: '#f97316', bg: dark ? 'rgba(249,115,22,0.14)' : '#fff7ed' };
      return { label: 'Ajustei orçamento', color: '#2563eb', bg: dark ? 'rgba(37,99,235,0.14)' : '#eff6ff' };
    }
    const d = String(campanha.decisao || '').toLowerCase();
    if (d.includes('escalar')) return { label: 'Observei escala', color: '#7c3aed', bg: dark ? 'rgba(124,58,237,0.14)' : '#f3e8ff' };
    if (d.includes('otimizar') || d.includes('reduzir')) return { label: 'Observei custo', color: '#e11d48', bg: dark ? 'rgba(225,29,72,0.14)' : '#fff1f2' };
    if (d.includes('pausar')) return { label: 'Observei risco', color: '#e11d48', bg: dark ? 'rgba(225,29,72,0.14)' : '#fff1f2' };
    return { label: 'Observei', color: txtMid, bg: dark ? 'rgba(255,255,255,0.06)' : '#f8fafc' };
  };
  const textoAnaliseCampanha = (campanha: any) => {
    const acoes = acoesDaCampanha(campanha);
    const detalhe = campanha.porque || campanha.proximo_passo || campanha.motivo || '';
    if (acoes.length > 0) return ('Eu executei ' + acoes.length + ' ajuste' + (acoes.length === 1 ? '' : 's') + ' de orçamento aqui. ' + detalhe).trim();
    const d = String(campanha.decisao || '').toLowerCase();
    if (d.includes('escalar')) return ('Eu identifiquei potencial forte de escala. ' + detalhe).trim();
    if (d.includes('otimizar') || d.includes('reduzir')) return ('Eu marquei essa campanha como ponto de atenção de custo. ' + detalhe).trim();
    if (d.includes('pausar')) return ('Eu marquei essa campanha como risco alto. ' + detalhe).trim();
    return ('Eu acompanhei essa campanha e mantive sob observação. ' + (detalhe || 'Sem ação necessária neste ciclo.')).trim();
  };
  const headerTitle = isErro
    ? 'Problema na sincronização da Meta'
    : sugestoes.length > 0 || campanhaMestre || log.sugestao_novo_conjunto
      ? 'Tenho sugestões para você'
      : isSemAcao ? 'Analisei suas campanhas — tudo estável' : 'Atualizei suas campanhas';
  const headerSub = isErro
    ? 'Veja o motivo antes de esperar novos resultados'
    : sugestoes.length > 0 || campanhaMestre || log.sugestao_novo_conjunto
      ? 'Revise o que eu recomendo fazer agora'
      : isSemAcao
        ? 'Nenhuma ação necessária hoje'
        : `Hoje às ${new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;


  async function aplicarSugestao(acao: any) {
    const uid = acao.id;
    setAplicandoIds(prev => new Set([...prev, uid]));
    try {
      const { data, error } = await supabase.functions.invoke('executar-otimizacao', {
        body: { log_id: log.id, acao_id: uid },
      });
      if (error || data == null || data.ok === false) {
        setToast?.({ msg: data?.erro || error?.message || 'Erro ao executar a ação', ok: false });
        return;
      }
      const acaoAplicada = sugestoes.find(a => a.id === uid);
      const novas = sugestoes.filter(a => a.id !== uid);
      setSugestoes(novas);
      const novasExecutadas = data.acoes_executadas || [
        ...(log.acoes_executadas || []),
        ...(acaoAplicada ? [{ ...acaoAplicada, automatico: false, aprovado: true, ok: true, executado_em: new Date().toISOString() }] : []),
      ];
      if (onLogUpdate) onLogUpdate({ ...log, acoes_sugeridas: data.acoes_sugeridas || novas, acoes_executadas: novasExecutadas, status: data.status || (novas.length === 0 ? 'executado' : log.status) });
      if ((acao.tipo || '').toLowerCase().includes('pausar')) {
        onCampaignStatusChange?.(acao.id, acao.tipo, 'PAUSED');
      }
      setToast?.({ msg: 'Ação aplicada com sucesso', ok: true });
    } catch {
      setToast?.({ msg: 'Erro ao conectar — tente novamente', ok: false });
    } finally {
      setAplicandoIds(prev => { const n = new Set(prev); n.delete(uid); return n; });
      setTimeout(() => setToast?.(null), 4000);
    }
  }

  async function ignorarSugestao(acao: any) {
    const uid = acao.id;
    const novas = sugestoes.filter((a: any) => a.id !== uid);
    setSugestoes(novas);
    const ignorada = { ...acao, automatico: false, ignorado: true, ok: true, executado_em: new Date().toISOString() };
    const novasExecutadas = [...(log.acoes_executadas || []), ignorada];
    const novoStatus = novas.length === 0 ? 'ignorado' : log.status;
    try {
      const { error } = await (supabase as any)
        .from('ai_optimization_logs')
        .update({ acoes_sugeridas: novas, acoes_executadas: novasExecutadas, status: novoStatus })
        .eq('id', log.id);
      if (error) console.warn('ignorarSugestao: DB update failed', error);
    } catch (e) {
      console.warn('ignorarSugestao: DB update error', e);
    }
    if (onLogUpdate) onLogUpdate({ ...log, acoes_sugeridas: novas, acoes_executadas: novasExecutadas, status: novoStatus });
    if (novas.length === 0) setTimeout(() => onClose(), 1000);
  }

  async function concluirCampanhaMestre(ignorado = false) {
    if (!campanhaMestre) return;
    const executada = {
      tipo: 'criar_campanha',
      ok: true,
      automatico: false,
      aprovado: !ignorado,
      ignorado,
      nome: ignorado ? 'Sugestão de campanha ignorada' : 'Sugestão de campanha criada',
      campanha_base: campanhaMestre.campanha_base || campanhaMestre.base,
      campanha_base_id: campanhaMestre.campanha_base_id,
      publico: campanhaMestre.publico_sugerido || campanhaMestre.publico,
      criativo: campanhaMestre.criativo_sugerido || campanhaMestre.criativo,
      budget_diario_sugerido: campanhaMestre.budget_diario_sugerido,
      thumbnail_url: campanhaMestre.thumbnail_url,
      instrucoes: campanhaMestre.instrucoes,
      motivo: campanhaMestre.motivo,
      executado_em: new Date().toISOString(),
    };
    const novasExecutadas = [...(log.acoes_executadas || []), executada];
    const novoStatus = sugestoes.length === 0 ? (ignorado ? 'ignorado' : 'executado') : log.status;
    const updated = { ...log, campanha_mestre: null, acoes_executadas: novasExecutadas, status: novoStatus };
    try {
      const { error } = await (supabase as any)
        .from('ai_optimization_logs')
        .update({ campanha_mestre: null, acoes_executadas: novasExecutadas, status: novoStatus })
        .eq('id', log.id);
      if (error) throw error;
      onLogUpdate?.(updated);
      setToast?.({ msg: ignorado ? 'Sugestão de campanha ignorada' : 'Sugestão de campanha marcada como criada', ok: true });
      setTimeout(() => setToast?.(null), 3500);
    } catch {
      setToast?.({ msg: 'Não consegui fechar essa sugestão agora', ok: false });
    }
  }

  async function marcarCampanhaCriada() {
    await concluirCampanhaMestre(false);
  }

  async function ignorarCampanhaMestre() {
    await concluirCampanhaMestre(true);
  }

  return (
    <>
      <div 
        onClick={onClose} 
        style={{ 
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', 
          backdropFilter: 'blur(4px)', zIndex: 1000,
          opacity: mounted ? 1 : 0, transition: 'opacity 0.3s ease'
        }} 
      />
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: isMobile ? '100%' : '440px',
        background: panelBg,
        borderLeft: `1px solid ${border}`,
        zIndex: 1001,
        display: 'flex', flexDirection: 'column',
        boxShadow: '-20px 0 50px rgba(0,0,0,0.15)',
        transform: mounted ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        {/* Header Section */}
        <div style={{ padding: '24px', borderBottom: `1px solid ${border}`, background: cardBg }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              {/* Avatar Ravena */}
              <img src="/ravena.png" alt="Ravena" style={{ width: '44px', height: '44px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, boxShadow: isErro ? '0 0 14px rgba(239,68,68,0.32)' : '0 0 14px rgba(139,92,246,0.28)' }} />
              <div>
                <h2 style={{ fontSize: '17px', fontWeight: 800, color: txtHi, margin: 0, letterSpacing: '-0.02em' }}>{headerTitle}</h2>
                <p style={{ fontSize: '12px', color: txtMid, margin: '3px 0 0' }}>{headerSub}</p>
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', padding: '8px', cursor: 'pointer', color: txtMid, borderRadius: '8px' }}>
              <X size={20} />
            </button>
          </div>

        </div>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

          {/* Barra de progresso do mês */}
          {(() => {
            const revsAtual = log.revendedoras_mes || 0;
            const progressoPct = metaRevs > 0 ? Math.min(Math.round((revsAtual / metaRevs) * 100), 100) : 0;
            const diasRestantes = log.dias_restantes || 0;
            const gastoTotal = log.total_gasto || 0;
            const progressoCor = progressoPct >= 80 ? '#10b981' : progressoPct >= 50 ? '#f59e0b' : '#ef4444';
            return (
              <div style={{ padding: '16px 24px', borderBottom: `1px solid ${border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '8px' }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 2px' }}>
                      Meta do mês
                    </p>
                    <p style={{ fontSize: '22px', fontWeight: 800, color: txtHi, margin: 0 }}>
                      {revsAtual}
                      <span style={{ fontSize: '14px', fontWeight: 500, color: txtMid }}>
                        {metaRevs > 0 ? ` / ${metaRevs} ${t.convertidoPlural}` : ` ${t.convertidoPlural}`}
                      </span>
                    </p>
                  </div>
                  {metaRevs > 0 && (
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '20px', fontWeight: 700, color: progressoCor, margin: 0 }}>{progressoPct}%</p>
                      <p style={{ fontSize: '11px', color: txtMid, margin: 0 }}>{diasRestantes}d restantes</p>
                    </div>
                  )}
                </div>
                {metaRevs > 0 && (
                  <div style={{ height: '6px', borderRadius: '99px', background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${progressoPct}%`, borderRadius: '99px', background: progressoCor, transition: 'width 1s cubic-bezier(0.16,1,0.3,1)' }} />
                  </div>
                )}

              </div>
            );
          })()}

          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
{campanhasLidas.length > 0 && (
              <div style={{ order: 3, padding: '16px', borderRadius: '18px', background: dark ? 'linear-gradient(180deg,rgba(124,58,237,0.14),rgba(37,99,235,0.06))' : 'linear-gradient(180deg,#ffffff,#f3f6ff)', border: '1px solid ' + (dark ? 'rgba(139,92,246,0.24)' : 'rgba(99,102,241,0.18)'), boxShadow: dark ? 'none' : '0 16px 34px rgba(79,70,229,0.08)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: '13px', fontWeight: 850, color: txtHi }}>Minha análise dos últimos 7 dias</p>
                    <p style={{ margin: '3px 0 0', fontSize: '12px', color: txtMid }}>O que eu executei, redistribuí ou deixei em observação por campanha</p>
                  </div>
                  <span style={{ height: '30px', minWidth: '30px', borderRadius: '10px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#2563eb,#8b5cf6)', color: '#fff', boxShadow: '0 10px 22px rgba(79,70,229,0.25)' }}>
                    <Lightbulb size={15} />
                  </span>
                </div>
                <div style={{ display: 'grid', gap: '10px' }}>
                  {campanhasLidas.map((campanha: any, i: number) => {
                    const visual = visualCampanha(campanha);
                    const nome = nomeCurtoCampanha(campanha.campanha_nome || campanha.campanha_curta || 'Campanha');
                    const ajustes = acoesDaCampanha(campanha);
                    return (
                      <div key={campanha.campanha_id || campanha.campanha_nome || i} className="ravena-campaign-card" style={{ padding: '12px', borderRadius: '14px', background: dark ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.90)', border: '1px solid ' + (dark ? 'rgba(255,255,255,0.07)' : 'rgba(99,102,241,0.10)' ) }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' }}>
                          <div style={{ minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: '12px', fontWeight: 850, color: txtHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</p>
                            <p style={{ margin: '5px 0 0', fontSize: '12px', lineHeight: 1.45, color: txtMid }}>{textoAnaliseCampanha(campanha)}</p>
                          </div>
                          <span style={{ flexShrink: 0, padding: '5px 8px', borderRadius: '999px', background: visual.bg, color: visual.color, fontSize: '10px', fontWeight: 850 }}>{visual.label}</span>
                        </div>
                        {ajustes.length > 0 && (
                          <div style={{ display: 'grid', gap: '7px', marginTop: '11px' }}>
                            {ajustes.map((ajuste: any, idx: number) => {
                              const delta = variacaoBudget(ajuste);
                              const subiu = delta >= 0;
                              const alvo = ajuste.conjunto_nome || ajuste.nome || ajuste.campanha_nome || 'Orçamento';
                              const cor = subiu ? '#2563eb' : '#f97316';
                              return (
                                <div key={ajuste.id || alvo || idx} style={{ display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: '8px', alignItems: 'center', padding: '8px', borderRadius: '11px', background: dark ? 'rgba(255,255,255,0.055)' : '#f8faff', border: '1px solid ' + (dark ? 'rgba(255,255,255,0.06)' : 'rgba(99,102,241,0.10)') }}>
                                  <span style={{ width: '22px', height: '22px', borderRadius: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: subiu ? 'rgba(37,99,235,0.10)' : 'rgba(249,115,22,0.10)', color: cor }}>
                                    {subiu ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                                  </span>
                                  <div style={{ minWidth: 0 }}>
                                    <p style={{ margin: 0, fontSize: '11px', fontWeight: 800, color: txtHi }}>{labelAcaoBudget(ajuste)}</p>
                                    <p style={{ margin: '2px 0 0', fontSize: '11px', color: txtMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alvo}</p>
                                  </div>
                                  <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 850, color: cor }}>
                                    {ajuste.antigo_budget ? 'R$ ' + ajuste.antigo_budget : '—'} → {ajuste.novo_budget ? 'R$ ' + ajuste.novo_budget : '—'} · {delta > 0 ? '+' : ''}{delta}%
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
                          {[
                            ['Leads', campanha.leads],
                            ['Rev', campanha.revendedoras],
                            ['CPL', fmtMoeda(Number(campanha.cpl || 0))],
                            ['CPR', fmtMoeda(Number(campanha.cpr || 0))],
                          ].map(([label, value]: any) => (
                            <span key={label} style={{ padding: '4px 7px', borderRadius: '999px', background: dark ? 'rgba(255,255,255,0.06)' : '#f1f5ff', color: txtMid, fontSize: '10px', fontWeight: 750 }}>{label}: {value || 0}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Alerta Meta — só se erro real ou meta_alertas */}
            {(isErro || alertasMetaGraves.length > 0) && (
              <div style={{ order:1, padding: '14px', borderRadius: '14px', background: dark ? 'rgba(239,68,68,0.08)' : '#fef2f2', border: '1px solid rgba(239,68,68,0.18)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <AlertTriangle size={15} color="#dc2626" />
                  <p style={{ margin: 0, fontSize: '12px', fontWeight: 800, color: '#dc2626' }}>Atenção na Meta</p>
                </div>
                <p style={{ margin: 0, fontSize: '12px', color: dark ? '#fecaca' : '#7f1d1d', lineHeight: 1.5 }}>
                  {log.alerta || 'A Meta sinalizou um problema que pode impedir a entrega.'}
                </p>
                {alertasMetaGraves.length > 0 && (
                  <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
                    {alertasMetaGraves.slice(0, 3).map((item: any, i: number) => (
                      <div key={item.id || i} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'center', fontSize: '11px' }}>
                        <span style={{ color: dark ? '#fee2e2' : '#991b1b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.nome}</span>
                        <span style={{ color: '#dc2626', fontWeight: 800 }}>{item.status_facebook}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* BLOCO 3: Ações — executadas + sugestões pendentes */}
            {((log.acoes_executadas || []).length > 0 || sugestoes.length > 0) ? (
              <div style={{ display: 'contents' }}>
                {/* Sub-bloco A: ações automáticas (automatico !== false) */}
                {(log.acoes_executadas || []).filter((a: any) => a.automatico !== false).length > 0 && (
                  <div style={{ order: 4 }}>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: txtLow, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>
                      Acoes executadas
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {(log.acoes_executadas || [])
                        .filter((a: any) => a.automatico !== false)
                        .map((acao: any, i: number) => (
                          <ActionCard key={i} acao={acao} dark={dark} origem="automatico" />
                        ))}
                    </div>
                  </div>
                )}
                {/* Sub-bloco B: ações aprovadas pelo usuário */}
                {(log.acoes_executadas || []).filter((a: any) => a.automatico === false).length > 0 && (
                  <div style={{ order: 5 }}>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>
                      Acoes aprovadas ou ignoradas
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {(log.acoes_executadas || [])
                        .filter((a: any) => a.automatico === false)
                        .map((acao: any, i: number) => (
                          <ActionCard key={i} acao={acao} dark={dark} origem="usuario" />
                        ))}
                    </div>
                  </div>
                )}
                {(log.acoes_executadas || []).length > 0 && sugestoes.length > 0 && (
                  <div style={{ height: '1px', background: border }} />
                )}
                {/* Sub-bloco B: sugestões aguardando aprovação */}
                {sugestoes.length > 0 && (
                  <div style={{ order: 2 }}>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
                      Sugestoes para aprovar
                    </p>
                    {sugestoes.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {sugestoes.map((acao: any, i: number) => (
                          <SugestaoCard
                            key={acao.id || i}
                            acao={acao}
                            dark={dark}
                            onAplicar={() => aplicarSugestao(acao)}
                            onIgnorar={() => ignorarSugestao(acao)}
                            aplicando={aplicandoIds.has(acao.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p style={{ fontSize: '13px', color: txtMid, margin: 0 }}>
                        Todas as sugestões foram processadas.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              !isPendente && (
                <p style={{ fontSize: '13px', color: txtMid, margin: 0 }}>
                  Nenhuma ação necessária hoje.
                </p>
              )
            )}

            {diagnosticosRavena.length > 0 && (
              <div style={{ order: 6 }}>
                <p style={{ fontSize: '11px', fontWeight: 700, color: txtLow, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' }}>
                  O que eu encontrei
                </p>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {diagnosticosRavena.map((item: any) => (
                    <div key={item.key} style={{ padding: '11px 12px', borderRadius: '13px', background: cardBg, border: `1px solid ${border}` }}>
                      <p style={{ margin: '0 0 4px', fontSize: '12px', fontWeight: 800, color: txtHi }}>{item.titulo}</p>
                      <p style={{ margin: 0, fontSize: '12px', color: txtMid, lineHeight: 1.45 }}>{item.texto.length > 180 ? item.texto.slice(0, 179) + '...' : item.texto}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* BLOCO 6: Sugestão de Novo Conjunto */}
            {(() => {
              const novoConjunto = log.sugestao_novo_conjunto;
              if (!novoConjunto) return null;
              return (
                <div style={{ order: 8, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div style={{ height: '1px', background: border }} />
                  <div style={{ borderRadius: '16px', background: cardBg, border: `1px solid ${border}`, overflow: 'hidden' }}>
                    <div style={{ padding: '16px', borderBottom: `1px solid ${border}` }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: 800, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            Sugestão de estrutura
                          </p>
                          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: txtHi, lineHeight: 1.35 }}>
                            Criar conjunto novo dentro do melhor ABO
                          </h3>
                        </div>
                        <span style={{ flexShrink: 0, padding: '5px 9px', borderRadius: '999px', background: dark ? 'rgba(255,255,255,0.06)' : '#f3f4f6', color: txtHi, fontSize: '11px', fontWeight: 800 }}>
                          R$ {novoConjunto.budget_diario_sugerido}/dia
                        </span>
                      </div>
                      {novoConjunto.motivo && (
                        <p style={{ margin: '10px 0 0', fontSize: '13px', color: txtMid, lineHeight: 1.55 }}>
                          {novoConjunto.motivo}
                        </p>
                      )}
                    </div>
                    <div style={{ padding: '14px 16px', display: 'grid', gap: '10px' }}>
                      {[
                        ['Campanha base', novoConjunto.campanha_base],
                        ['Conjunto referência', novoConjunto.melhor_conjunto_atual],
                        ['Criativo sugerido', novoConjunto.criativo_sugerido],
                      ].map(([label, value]) => (
                        <div key={label} style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '10px', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
                          <span style={{ fontSize: '13px', fontWeight: 700, color: txtHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '—'}</span>
                        </div>
                      ))}
                      {Array.isArray(novoConjunto.instrucoes) && novoConjunto.instrucoes.length > 0 && (
                        <div style={{ marginTop: '4px', display: 'grid', gap: '6px' }}>
                          {novoConjunto.instrucoes.slice(0, 4).map((item: string, i: number) => (
                            <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: txtMid, lineHeight: 1.45 }}>
                              <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: dark ? 'rgba(255,255,255,0.06)' : '#f3f4f6', color: txtMid, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '10px', fontWeight: 800 }}>{i + 1}</span>
                              <span>{item}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ marginTop: '4px' }}>
                        <button
                          onClick={async () => {
                            try {
                              const { error } = await (supabase as any)
                                .from('ai_optimization_logs')
                                .update({
                                  sugestao_novo_conjunto: null,
                                  acoes_executadas: [
                                    ...(log.acoes_executadas || []),
                                    {
                                      tipo: 'novo_conjunto',
                                      ok: true,
                                      automatico: false,
                                      aprovado: false,
                                      ignorado: true,
                                      nome: 'Sugestão de novo conjunto ignorada',
                                      campanha_base: novoConjunto.campanha_base,
                                      executado_em: new Date().toISOString(),
                                    }
                                  ]
                                })
                                .eq('id', log.id);
                              if (!error) {
                                onLogUpdate?.({ ...log, sugestao_novo_conjunto: null });
                                setToast?.({ msg: 'Sugestão ignorada', ok: true });
                                setTimeout(() => setToast?.(null), 3000);
                              }
                            } catch {
                              setToast?.({ msg: 'Erro ao ignorar sugestão', ok: false });
                            }
                          }}
                          style={{ width: '100%', padding: '9px', borderRadius: '10px', border: `1px solid ${border}`, background: dark ? 'rgba(255,255,255,0.04)' : '#fff', color: txtMid, fontSize: '12px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                        >
                          Ignorar sugestão
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {campanhaMestre && (
              <div style={{ order: 9, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ height: '1px', background: border }} />
                <div style={{ borderRadius: '16px', background: cardBg, border: `1px solid ${border}`, overflow: 'hidden' }}>
                  <div style={{ padding: '16px', borderBottom: `1px solid ${border}` }}>
                    <p style={{ margin: '0 0 4px', fontSize: '11px', fontWeight: 800, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      {campanhaMestre.tipo === 'nova_campanha' ? 'Sugestão de campanha nova' : 'Sugestao de campanha'}
                    </p>
                    <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: txtHi, lineHeight: 1.35 }}>
                      {campanhaMestre.tipo === 'nova_campanha'
                        ? 'Criar uma campanha nova com público e criativo sugeridos'
                        : 'Criar uma nova campanha com o que ja performou melhor'}
                    </h3>
                    {campanhaMestre.motivo && (
                      <p style={{ margin: '10px 0 0', fontSize: '13px', color: txtMid, lineHeight: 1.55 }}>
                        {campanhaMestre.motivo}
                      </p>
                    )}
                  </div>
                  <div style={{ padding: '14px 16px', display: 'grid', gap: '10px' }}>
                    {campanhaMestre.thumbnail_url && (
                      <div style={{ marginBottom: '4px', borderRadius: '8px', overflow: 'hidden', height: '140px', border: `1px solid ${border}` }}>
                        <img src={campanhaMestre.thumbnail_url} alt="Thumbnail do criativo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                    )}
                    {([
                      (campanhaMestre.campanha_base || campanhaMestre.base) ? ['Base', campanhaMestre.campanha_base || campanhaMestre.base] : null,
                      ['Público', campanhaMestre.publico_sugerido || campanhaMestre.publico],
                      ['Criativo', campanhaMestre.criativo_sugerido || campanhaMestre.criativo],
                      ['Orçamento sugerido', campanhaMestre.budget_diario_sugerido ? `R$ ${campanhaMestre.budget_diario_sugerido}/dia` : null],
                    ].filter(Boolean) as [string, any][]).map(([label, value]) => (
                      <div key={label} style={{ display: 'grid', gridTemplateColumns: '112px 1fr', gap: '10px', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
                        <span style={{ fontSize: '13px', fontWeight: 700, color: txtHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '—'}</span>
                      </div>
                    ))}
                    {Array.isArray(campanhaMestre.instrucoes) && campanhaMestre.instrucoes.length > 0 && (
                      <div style={{ marginTop: '4px', display: 'grid', gap: '6px' }}>
                        {campanhaMestre.instrucoes.slice(0, 4).map((item: string, i: number) => (
                          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: txtMid, lineHeight: 1.45 }}>
                            <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: dark ? 'rgba(255,255,255,0.06)' : '#f3f4f6', color: txtMid, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '10px', fontWeight: 800 }}>{i + 1}</span>
                            <span>{item}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                      <button onClick={marcarCampanhaCriada} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: '#8b5cf6', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Marcar como criada
                      </button>
                      <button onClick={ignorarCampanhaMestre} style={{ padding: '10px 14px', borderRadius: '10px', border: `1px solid ${border}`, background: 'transparent', color: txtMid, fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Ignorar
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Footer info */}
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${border}`, background: dark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)' }}>
          <p style={{ fontSize: '11px', color: txtMid, margin: 0, textAlign: 'center' }}>
            Analiso os últimos 7 dias de performance. Só executo com sua aprovação.
          </p>
        </div>
      </div>
    </>
  );
}

function SugestaoCard({ acao, dark, onAplicar, onIgnorar, aplicando }: {
  acao: any; dark: boolean;
  onAplicar: () => void; onIgnorar: () => void; aplicando?: boolean;
}) {
  const [motivoExpandido, setMotivoExpandido] = useState(false);
  const tipo = (acao.tipo || '').toLowerCase();
  const isPause    = tipo.includes('pausar');
  const isIncrease = tipo.includes('aumentar') || (tipo === 'reduzir' && acao.direcao === 'aumento');
  const isDecrease = (tipo.includes('reduzir') && acao.direcao !== 'aumento') || (tipo === 'reduzir' && !acao.direcao);
  const isConjunto = tipo.includes('conjunto');
  const isReativar = tipo === 'reativar_conjunto';
  const isCreative = tipo.includes('criativo');
  const isNovoConjunto = tipo.includes('novo_conjunto') || tipo.includes('novo conjunto');
  const isEstrutura = tipo.includes('estrutura') || tipo.includes('revisar');
  const isControlarBudgetFds = tipo === 'controlar_budget_fds';

  const color = isControlarBudgetFds ? '#3b82f6' : isReativar ? '#10b981' : isPause ? '#ef4444' : isIncrease ? '#10b981' : isDecrease ? '#f97316' : '#8b5cf6';
  const headerBg = isControlarBudgetFds ? 'rgba(59,130,246,0.08)' : isReativar ? 'rgba(16,185,129,0.08)' : isPause ? 'rgba(239,68,68,0.08)' : isIncrease ? 'rgba(16,185,129,0.08)' : isDecrease ? 'rgba(249,115,22,0.08)' : 'rgba(139,92,246,0.08)';
  const headerIcon = isControlarBudgetFds ? '📅' : isReativar ? '▶' : isPause ? '⏸' : isIncrease ? '↑' : isDecrease ? '↓' : '✦';
  const headerLabel = acao.origem === 'llm'
    ? (acao.titulo || 'Recomendação da Ravena')
    : (isControlarBudgetFds
      ? 'Controle de orçamento no fim de semana'
      : isCreative
      ? 'Subir novos criativos'
      : isNovoConjunto
      ? 'Criar novo conjunto'
      : isEstrutura
      ? 'Revisar estrutura'
      : isReativar
      ? 'Reativar grupo de anúncios'
      : isPause
        ? (isConjunto ? 'Pausar grupo de anúncios' : 'Pausar campanha')
        : isIncrease
          ? (isConjunto ? 'Aumentar orçamento do grupo' : 'Aumentar orçamento da campanha')
          : isDecrease
            ? (isConjunto ? 'Reduzir orçamento do grupo' : 'Reduzir orçamento da campanha')
            : 'Recomendação da Ravena');

  const bdr    = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const sepClr = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const txtHi  = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#a1a1aa' : '#6b7280';

  const campanhaNome = acao.campanha_nome || '';
  const conjuntoNome = acao.conjunto_nome || acao.nome || '—';
  const nomePrincipal = isConjunto ? conjuntoNome : (acao.campanha_nome || acao.nome || '—');

  const ant = acao.antigo_budget != null ? acao.antigo_budget : null;
  const nov = acao.novo_budget   != null ? acao.novo_budget   : null;
  const varPct = ant && nov && Number(ant) > 0
    ? Math.max(-20, Math.min(20, Math.round(((Number(nov) - Number(ant)) / Number(ant)) * 100)))
    : null;
  const metricas = [
    acao.gasto != null ? ['Gasto', 'R$ ' + Number(acao.gasto).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })] : null,
    acao.leads != null ? ['Leads', Number(acao.leads).toLocaleString('pt-BR')] : null,
    acao.revendedoras != null ? ['Rev', Number(acao.revendedoras).toLocaleString('pt-BR')] : null,
    acao.potenciais != null ? ['Potenciais', Number(acao.potenciais).toLocaleString('pt-BR')] : null,
    acao.cpl != null ? ['CPL', 'R$ ' + Number(acao.cpl).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })] : null,
    acao.benchmark_cpl != null ? ['CPL médio', 'R$ ' + Number(acao.benchmark_cpl).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })] : null,
  ].filter(Boolean) as [string, string][];

  return (
    <div style={{ borderRadius: '14px', background: dark ? '#161619' : '#fff', border: `1px solid ${dark ? 'rgba(255,255,255,0.08)' : '#e5e7eb'}`, opacity: aplicando ? 0.65 : 1, transition: 'opacity 0.15s', overflow: 'hidden' }}>

      {/* Header — linha fina */}
      <div style={{ height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', background: headerBg, borderBottom: `1px solid ${color}20` }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color, display: 'flex', alignItems: 'center', gap: '6px' }}>
          {headerIcon} {headerLabel}
        </span>
        {varPct !== null && (
          <span style={{ fontSize: '12px', fontWeight: 800, color }}>
            {varPct > 0 ? '+' : ''}{varPct}%
          </span>
        )}
      </div>

      {/* Nomes */}
      <div style={{ padding: '12px 14px 0' }}>
        {isConjunto && campanhaNome && (
          <p style={{ margin: '0 0 3px', fontSize: '10px', fontWeight: 700, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {campanhaNome}
          </p>
        )}
        <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: txtHi, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nomePrincipal}
        </p>
      </div>

      {/* Budget */}
      {!isReativar && ant != null && nov != null && (
        <div style={{ padding: '10px 14px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', color: txtMid }}>R$ {ant}</span>
          <span style={{ fontSize: '12px', color: txtMid }}>→</span>
          <span style={{ fontSize: '13px', fontWeight: 700, color }}> R$ {nov}/dia</span>
        </div>
      )}

      {metricas.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '10px 14px 0' }}>
          {metricas.map(([label, value]) => (
            <span key={label} style={{ padding: '4px 7px', borderRadius: '999px', background: dark ? 'rgba(255,255,255,0.06)' : '#f3f4f6', color: txtMid, fontSize: '10px', fontWeight: 750 }}>{label}: {value}</span>
          ))}
        </div>
      )}

      {/* Separador + motivo expansível */}
      {acao.motivo && (
        <div style={{ padding: '10px 14px 0' }}>
          <div style={{ height: '1px', background: sepClr, marginBottom: '8px' }} />
          {acao.motivo.length <= 90 ? (
            <p style={{ margin: 0, fontSize: '12px', color: txtMid, lineHeight: 1.5 }}>{acao.motivo}</p>
          ) : (
            <p style={{ margin: 0, fontSize: '12px', color: txtMid, lineHeight: 1.5 }}>
              {motivoExpandido ? acao.motivo : acao.motivo.slice(0, 90) + '…'}
              {' '}
              <button
                onClick={() => setMotivoExpandido(v => !v)}
                style={{ fontSize: '11px', color: '#8b5cf6', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {motivoExpandido ? 'ver menos' : 'ver mais'}
              </button>
            </p>
          )}
        </div>
      )}

      {/* Sugestão detalhada para controlar_budget_fds */}
      {isControlarBudgetFds && (acao as any).sugestao && (
        <div style={{ padding: '8px 14px 0' }}>
          <div style={{ padding: '10px 12px', borderRadius: '8px', background: dark ? 'rgba(59,130,246,0.07)' : '#eff6ff', border: '1px solid rgba(59,130,246,0.18)' }}>
            <p style={{ margin: 0, fontSize: '12px', color: dark ? '#93c5fd' : '#1d4ed8', lineHeight: 1.5 }}>{(acao as any).sugestao}</p>
          </div>
        </div>
      )}

      {/* Guardrail note for increases */}
      {isIncrease && varPct !== null && (
        <div style={{ margin: '0 14px', padding: '7px 10px', borderRadius: '8px', background: dark ? 'rgba(245,158,11,0.06)' : '#fffbeb', border: '1px solid rgba(245,158,11,0.18)' }}>
          <p style={{ margin: 0, fontSize: '11px', color: dark ? '#fbbf24' : '#92400e', lineHeight: 1.4 }}>
            Aumento de {varPct}% — dentro do limite de 20% por análise. Você aprova, eu executo.
          </p>
        </div>
      )}

      {/* Botões */}
      <div style={{ display: 'flex', gap: '8px', padding: '12px 14px 14px' }}>
        <button onClick={onAplicar} disabled={aplicando}
          style={{ flex: 1, padding: '9px', borderRadius: '9px', border: 'none', background: aplicando ? bdr : '#8b5cf6', color: aplicando ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: aplicando ? 'default' : 'pointer', fontFamily: 'inherit', transition: 'background 0.15s' }}>
          {aplicando ? 'Aplicando…' : 'Aprovar'}
        </button>
        <button onClick={onIgnorar} disabled={aplicando}
          style={{ padding: '9px 14px', borderRadius: '9px', border: `1px solid ${bdr}`, background: 'transparent', color: txtMid, fontSize: '13px', fontWeight: 500, cursor: aplicando ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          Ignorar
        </button>
      </div>
    </div>
  );
}

function ActionCard({ acao, dark, origem }: { acao: any; dark: boolean; origem?: 'automatico' | 'usuario' }) {
  const tipo = (acao.tipo || '').toLowerCase();
  const isPause        = tipo.includes('pausar');
  const isRedistribuir = tipo.includes('redistribuir');
  const isConjunto     = tipo.includes('conjunto');
  const isUp           = tipo.includes('aumentar') || acao.direcao === 'aumento';
  const isDown         = (tipo.includes('reduzir') && acao.direcao !== 'aumento') || (!isUp && !isPause && !isRedistribuir && tipo.includes('reduzir'));
  const isReduzirConjunto = tipo === 'reduzir_conjunto';
  const isBudget = tipo === 'ajustar_budget_campanha' || tipo === 'ajustar_budget_adset' || tipo.includes('budget') || tipo.includes('orcamento') || tipo.includes('orçamento');
  const hasError = acao.ok === false;

  const color = isRedistribuir ? '#3b82f6'
    : isPause ? '#71717a'
    : isUp ? '#10b981'
    : isDown ? '#f97316'
    : '#3b82f6';
  const bg = isRedistribuir ? 'rgba(59,130,246,0.05)'
    : isPause ? 'rgba(113,113,122,0.05)'
    : isUp ? 'rgba(16,185,129,0.05)'
    : isDown ? 'rgba(249,115,22,0.05)'
    : 'rgba(59,130,246,0.05)';
  const Icon = isRedistribuir ? RefreshCw
    : isPause ? Pause
    : isUp ? TrendingUp
    : isDown ? TrendingDown
    : hasError ? AlertTriangle
    : Zap;

  const txtHi = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#a1a1aa' : '#6b7280';
  const border = dark ? '#1e1e22' : '#e5e7eb';

  const variacaoPct = (isBudget || isReduzirConjunto) && acao.antigo_budget && acao.novo_budget
    ? Math.round(((Number(acao.novo_budget) - Number(acao.antigo_budget)) / Number(acao.antigo_budget)) * 100)
    : null;

  const label = isPause && isConjunto ? 'Pausei um conjunto'
    : isPause ? 'Pausei a campanha'
    : isRedistribuir ? 'Redistribuí o orçamento'
    : isUp && isConjunto ? 'Aumentei o orçamento do conjunto'
    : isUp ? 'Aumentei o orçamento'
    : isDown && isConjunto ? 'Reduzi o orçamento do conjunto'
    : isDown ? 'Reduzi o orçamento'
    : 'Fiz um ajuste';

  const truncMotivo = (str: string | undefined, max: number) => {
    if (!str) return '';
    const dot = str.indexOf('.');
    const s = dot > 0 && dot < str.length - 1 ? str.slice(0, dot + 1) : str;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  return (
    <div style={{ padding: '14px', borderRadius: '16px', background: dark ? '#161619' : '#fff', border: `1px solid ${border}`, display: 'flex', gap: '14px', alignItems: 'flex-start', opacity: hasError ? 0.5 : 1 }}>
      <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon size={18} color={color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </span>
        </div>

        {isRedistribuir && (
          <>
            <p style={{ fontSize: '13px', fontWeight: 700, color: txtHi, margin: '0 0 5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {acao.campanha_nome || acao.nome || '—'}
            </p>
            <p style={{ fontSize: '11.5px', color: txtMid, margin: '0 0 4px', lineHeight: 1.5 }}>
              ↓ {acao.conjunto_reduzido_nome}: R${acao.antigo_budget_reduzido}→R${acao.novo_budget_reduzido}/dia &nbsp;↑ {acao.conjunto_aumentado_nome}: R${acao.antigo_budget_aumentado}→R${acao.novo_budget_aumentado}/dia
            </p>
            {acao.motivo && (
              <p style={{ margin: 0, fontSize: '11px', color: dark ? '#52525b' : '#9ca3af', lineHeight: 1.4 }}>
                {truncMotivo(acao.motivo, 80)}
              </p>
            )}
          </>
        )}

        {isReduzirConjunto && (
          <>
            <p style={{ fontSize: '13px', fontWeight: 700, color: txtHi, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {acao.conjunto_nome || acao.nome || '—'}
            </p>
            <p style={{ fontSize: '11px', color: txtMid, margin: '0 0 5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              campanha: {acao.campanha_nome || '—'}
            </p>
            {acao.novo_budget != null && (
              <p style={{ fontSize: '12px', color: txtHi, margin: 0, display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                <span style={{ color: txtMid }}>R$ {acao.antigo_budget || '??'}</span>
                <span style={{ color: txtMid }}>→</span>
                <span style={{ color, fontWeight: 600 }}>R$ {acao.novo_budget}/dia</span>
                {acao.motivo && <span style={{ fontSize: '11px', color: dark ? '#52525b' : '#9ca3af' }}>· {truncMotivo(acao.motivo, 60)}</span>}
              </p>
            )}
          </>
        )}

        {!isRedistribuir && !isReduzirConjunto && (
          <>
            <p style={{ fontSize: '13.5px', fontWeight: 700, color: txtHi, margin: '0 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {acao.nome || acao.campanha_nome || '—'}
            </p>
            {isBudget && acao.novo_budget != null && (
              <p style={{ fontSize: '13px', fontWeight: 600, color: txtHi, margin: '4px 0 6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: txtMid, fontWeight: 400 }}>R$ {acao.antigo_budget || '??'}</span>
                <span style={{ color: txtMid }}>→</span>
                <span style={{ color }}>R$ {acao.novo_budget}/dia</span>
                {variacaoPct !== null && (
                  <span style={{ fontSize: '11px', fontWeight: 700, color: variacaoPct > 0 ? '#10b981' : '#f97316' }}>
                    ({variacaoPct > 0 ? '+' : ''}{variacaoPct}%)
                  </span>
                )}
              </p>
            )}
            {acao.motivo && <p style={{ margin: 0, fontSize: '11.5px', color: txtMid, lineHeight: 1.5 }}>{truncMotivo(acao.motivo, 80)}</p>}
          </>
        )}
        {hasError && (
          <p style={{ margin: '6px 0 0', fontSize: '11px', color: dark ? '#71717a' : '#9ca3af' }}>
            ⚠ Não foi possível executar esta ação
          </p>
        )}
      </div>
    </div>
  );
}
