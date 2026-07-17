import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AppLayout } from '@/components/AppLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useAppStore, Lead, STATUS_LABELS, STATUS_CONFIG, calcularFaixa } from '@/stores/appStore';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useOrgId } from '@/hooks/useOrgId';
import { useTerminology, useModeloNegocio } from '@/hooks/useTerminology';
import { useStatusConfig } from '@/hooks/useStatusConfig';
import { useNavigate } from 'react-router-dom';
import { useWhatsAppAccount } from '@/hooks/useWhatsAppAccount';
import { useTags, Tag as OrgTag, CORES_TAGS } from '@/hooks/useTags';
import { usePlanFeatures } from '@/hooks/usePlanFeatures';
import { Search, MessageCircle, Plus, Download, RefreshCw, Edit, Loader2, ChevronDown, Check, X, Trash2, Filter, Tag, Megaphone } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { LeadDrawer } from '@/components/ui/lead-drawer';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';
import { useMetaConfig } from '@/hooks/useMetaConfig';
import { formatarWhatsapp } from '@/utils/relativeTime';
import { safeName } from '@/utils/safeName';
import { getAvatarColor, getAvatarTextColor } from '@/utils/avatarColor';
import { aplicarTagOrigem } from '@/utils/tagOrigem';
import { pedirCustoIndicacao, precisaCustoIndicacaoParaConversao } from '@/utils/indicacao';
import { dispararCapiConversao } from '@/utils/capiEvento';

const STATUS_STYLE = STATUS_CONFIG;

const PERIOD_OPTIONS = [
  { label: 'Todos', value: 'all' },
  { label: 'Hoje', value: 'today' },
  { label: 'Ontem', value: 'yesterday' },
  { label: '7 dias', value: '7days' },
  { label: '30 dias', value: '30days' },
  { label: 'Este mês', value: 'month' },
  { label: 'Personalizado', value: 'custom' },
];

const STATUS_OPTIONS = [
  { label: 'Todos os status', value: 'all' },
  { label: '🆕 Novo',         value: 'novo' },
  { label: 'Em atendimento', value: '1', dot: STATUS_CONFIG[1]?.dot },
  { label: 'Reunião',        value: '2', dot: STATUS_CONFIG[2]?.dot },
  { label: 'Contrato/App',   value: '5', dot: STATUS_CONFIG[5]?.dot },
  { label: 'Aprovado',       value: '3', dot: STATUS_CONFIG[3]?.dot },
  { label: 'Sem Retorno',    value: '6', dot: STATUS_CONFIG[6]?.dot },
  { label: 'Reprovado',      value: '4', dot: STATUS_CONFIG[4]?.dot },
];

function getInitials(name: string) {
  if (!name || typeof name !== 'string') return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function parseLeadDate(str?: string | null): Date {
  if (!str) return new Date(0);
  if (str.includes('T')) {
    const cleaned = str.replace(/(\.\d{3})\d+/, '$1');
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d;
  }
  if (/^\d{4}-\d{2}-\d{2} /.test(str)) {
    const cleaned = str.replace(' ', 'T').replace('+00:00', 'Z').replace('+00', 'Z').replace(/(\.\d{3})\d+/, '$1');
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d;
  }
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/);
  if (m) {
    const [, d, mo, yStr, h = '0', mi = '0', s = '0'] = m;
    let y = parseInt(yStr);
    if (yStr.length === 2) {
      y = y + (y < 70 ? 2000 : 1900);
    }
    const dObj = new Date(`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi.padStart(2,'0')}:${s.padStart(2,'0')}-03:00`);
    if (!isNaN(dObj.getTime())) return dObj;
  }
  const dFallback = new Date(str.replace(/(\.\d{3})\d+/, '$1'));
  return isNaN(dFallback.getTime()) ? new Date(0) : dFallback;
}

function getLeadEntryValue(lead: Lead): string | null | undefined {
  const normalized = lead.entrada_at;
  return typeof normalized === 'string' && normalized ? normalized : lead.created_at;
}

function leadDateBR(str?: string | null): string {
  try {
    const d = parseLeadDate(str);
    if (!d || isNaN(d.getTime()) || d.getTime() === 0) return '';
    // UTC-3 fixo (Brasil), independente do fuso do browser
    const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return br.toISOString().slice(0, 10);
  } catch { return ''; }
}

function todayBR(): string {
  try {
    const d = new Date();
    // UTC-3 fixo
    const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return br.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
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

function subDays(dateStr: string, n: number): string {
  try {
    const d = new Date(dateStr + 'T12:00:00Z');
    if (isNaN(d.getTime())) return dateStr;
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().split('T')[0];
  } catch { return dateStr; }
}

function filterByPeriod(leads: Lead[], period: string, customFrom?: string, customTo?: string, getRef?: (l: Lead) => string | null | undefined): Lead[] {
  if (period === 'all') return leads;
  const today = todayBR();
  const dateRef = getRef ?? getLeadEntryValue;
  const ok = (l: Lead, from: string, to: string) => {
    const d = leadDateBR(dateRef(l));
    return !!d && d >= from && d <= to;
  };
  switch (period) {
    case 'today':     return leads.filter(l => ok(l, today, today));
    case 'yesterday': { const y = subDays(today, 1); return leads.filter(l => ok(l, y, y)); }
    case '7days':     return leads.filter(l => ok(l, subDays(today, 6), today));
    case '30days':    return leads.filter(l => ok(l, subDays(today, 29), today));
    case 'month':     return leads.filter(l => ok(l, today.slice(0, 7) + '-01', today));
    case 'custom':    { if (!customFrom || !customTo) return leads; return leads.filter(l => ok(l, customFrom, customTo)); }
    default: return leads;
  }
}

function formatEntrada(str?: string | null): string {
  try {
    if (!str) return '—';
    const d = parseLeadDate(str);
    if (isNaN(d.getTime())) return '—';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch { return '—'; }
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g,'').slice(0,11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : '';
  if (digits.length <= 7) return `(${digits.slice(0,2)}) ${digits.slice(2)}`;
  return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
}

function normalizeCity(raw: string): string {
  if (!raw?.trim()) return '';
  let city = raw.trim();
  const ufMatch = city.match(/[\s\/\-,]+([A-Za-z]{2})\s*$/);
  let uf = '';
  if (ufMatch) { const c=ufMatch[1].toUpperCase(); const UFS=['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']; if(UFS.includes(c)){uf=c;city=city.slice(0,city.length-ufMatch[0].length).trim();} }
  const lower=new Set(['de','do','da','dos','das','e','em','com','no','na','nos','nas']);
  city=city.toLowerCase().replace(/[_\-\/]+/g,' ').replace(/\s+/g,' ').trim().split(' ').map((w,i)=>{ if(!w)return''; if(i>0&&lower.has(w))return w; return w.charAt(0).toUpperCase()+w.slice(1); }).join(' ');
  return uf?`${city} - ${uf}`:city;
}

function toStatusNum(s: any): number {
  if(s===null||s===undefined||s==='')return 1; const n=Number(s); if(isNaN(n)||n===0)return 1; return n;
}

const STATUS_TIMESTAMP_FIELD: Record<number, string> = {
  0: 'status_atendimento_at',
  1: 'status_atendimento_at',
  2: 'status_reuniao_at',
  3: 'status_aprovado_at',
  5: 'status_contrato_at',
  6: 'status_sem_retorno_at',
};

function getStatusMoveDate(lead: Lead, statusId = toStatusNum(lead.status)): string | null {
  const field = STATUS_TIMESTAMP_FIELD[statusId];
  const exact = field ? (lead as any)[field] : null;
  if (exact) return exact;
  if (toStatusNum(lead.status) === statusId) return (lead as any).ultimo_status_change || lead.created_at || null;
  return null;
}

function hasMovedToStatus(lead: Lead, statusId: number): boolean {
  return !!getStatusMoveDate(lead, statusId);
}

function extractCampaignName(utmCampaign: string | null | undefined): string {
  if (!utmCampaign) return '';
  const parts = String(utmCampaign).split('|');
  const name = (parts[0] || '').trim();
  if (!name && parts.length >= 2) return parts[1].trim();
  return name;
}

// Pills de status light — cores saturadas o suficiente para aparecer sobre zebrado #f9fafb
const LIGHT_STATUS_PILL: Record<number, { bg: string; color: string; dot: string; border: string }> = {
  0: { bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6', border: 'rgba(29,78,216,0.12)'   },
  1: { bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6', border: 'rgba(29,78,216,0.12)'   },
  2: { bg: '#ede9fe', color: '#6d28d9', dot: '#7e3beb', border: 'rgba(109,40,217,0.15)'  },
  5: { bg: '#ffedd5', color: '#9a3412', dot: '#f97316', border: 'rgba(154,52,18,0.12)'   },
  3: { bg: '#d1fae5', color: '#065f46', dot: '#10b981', border: 'rgba(6,95,70,0.12)'     },
  4: { bg: '#fee2e2', color: '#991b1b', dot: '#f43f5e', border: 'rgba(153,27,27,0.12)'   },
  6: { bg: '#f4f4f5', color: '#3f3f46', dot: '#71717a', border: 'rgba(63,63,70,0.12)'    },
};

// Pills de status dark
const DARK_STATUS_PILL: Record<number, { bg: string; color: string; dot: string; border: string }> = {
  0: { bg: 'rgba(59,130,246,0.20)',   color: '#93c5fd', dot: '#3b82f6', border: 'rgba(59,130,246,0.22)'  },
  1: { bg: 'rgba(59,130,246,0.20)',   color: '#93c5fd', dot: '#3b82f6', border: 'rgba(59,130,246,0.22)'  },
  2: { bg: 'rgba(139,92,246,0.28)',   color: '#c4b5fd', dot: '#8b5cf6', border: 'rgba(139,92,246,0.30)'  },
  5: { bg: 'rgba(249,115,22,0.20)',   color: '#fdba74', dot: '#f97316', border: 'rgba(249,115,22,0.22)'  },
  3: { bg: 'rgba(16,185,129,0.20)',   color: '#6ee7b7', dot: '#10b981', border: 'rgba(16,185,129,0.22)'  },
  4: { bg: 'rgba(244,63,94,0.20)',    color: '#fda4af', dot: '#f43f5e', border: 'rgba(244,63,94,0.22)'   },
  6: { bg: 'rgba(113,113,122,0.20)', color: '#a1a1aa', dot: '#71717a', border: 'rgba(113,113,122,0.22)'  },
};

function ScoreTag({ score, faixa, dark }: { score?: number | null; faixa?: string | null; dark: boolean }) {
  if (score == null) return <span style={{color:dark?'#3f3f46':'#d1d5db',fontSize:'12px'}}>—</span>;
  const isVerde = faixa === 'verde';
  const isAmarelo = faixa === 'amarelo';
  const color = isVerde ? (dark ? '#34d399' : '#15803d') : isAmarelo ? (dark ? '#fbbf24' : '#b45309') : (dark ? '#a1a1aa' : '#71717a');
  const bg = isVerde ? (dark ? 'rgba(16,185,129,0.12)' : '#dcfce7') : isAmarelo ? (dark ? 'rgba(245,158,11,0.12)' : '#fef3c7') : (dark ? 'rgba(113,113,122,0.12)' : '#f4f4f5');
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:'3px',padding:'2px 7px',borderRadius:'6px',background:bg,fontSize:'12px',fontWeight:700,color,whiteSpace:'nowrap'}}>
      <span style={{width:'5px',height:'5px',borderRadius:'50%',background:color,display:'inline-block',flexShrink:0}}/>
      {score} pts
    </span>
  );
}

function FaixaDot({ lead, dark }: { lead: Lead; dark: boolean }) {
  const { configuracoes } = useAppStore();
  const faixa = calcularFaixa(lead, configuracoes!) ?? (lead as any).faixa;
  if (!faixa || faixa === 'vermelho') return null;
  return <div style={{ width:'10px', height:'10px', borderRadius:'50%', flexShrink:0, background:faixa==='verde'?'#10b981':'#f59e0b', border:`2px solid ${dark?'#111113':'#ffffff'}` }}/>;
}

function FilterDropdown({ value, options, onChange, dark }: { value:string; options:{label:string;value:string;dot?:string}[]; onChange:(v:string)=>void; dark:boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const selected = options.find(o => o.value === value);
  function handleOpen() {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const menuWidth = 180;
      let left = r.right - menuWidth;
      if (left < 8) left = 8;
      if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
      setPos({ top: r.bottom + 6, left, width: Math.max(r.width, menuWidth) });
    }
    setOpen(v => !v);
  }
  return (
    <div>
      <button ref={btnRef} onClick={handleOpen} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'7px 10px', borderRadius:'9px', border:`1px solid ${dark?'#1e1e22':'#e5e7eb'}`, background:dark?'#111113':'#ffffff', color:dark?'#d4d4d8':'#374151', fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
        {selected?.dot && <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:selected.dot, flexShrink:0 }}/>}
        {selected?.label}<ChevronDown style={{ width:'13px', height:'13px', transform:open?'rotate(180deg)':'', transition:'transform 0.18s' }}/>
      </button>
      {open && createPortal(<>
        <div onClick={() => setOpen(false)} style={{ position:'fixed', inset:0, zIndex:9998 }}/>
        <div style={{ position:'fixed', top:pos.top, left:pos.left, width:pos.width, background:dark?'#111113':'#ffffff', border:`1px solid ${dark?'#1e1e22':'#e5e7eb'}`, borderRadius:'10px', padding:'4px', zIndex:9999, boxShadow:dark?'0 8px 32px rgba(0,0,0,0.5)':'0 8px 24px rgba(0,0,0,0.1)' }}>
          {options.map(o => (<button key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} style={{ width:'100%', display:'flex', alignItems:'center', gap:'7px', padding:'7px 10px', borderRadius:'7px', border:'none', background:value===o.value?(dark?'rgba(255,255,255,0.07)':'#eff6ff'):'transparent', color:value===o.value?(dark?'#fff':'#0044fd'):(dark?'#a1a1aa':'#374151'), fontSize:'13px', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
            {value===o.value?<Check style={{ width:'12px', height:'12px', flexShrink:0 }}/>:<span style={{ width:'12px', flexShrink:0 }}/>}
            {o.dot && <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:o.dot, flexShrink:0 }}/>}
            {o.label}
          </button>))}
        </div>
      </>, document.body)}
    </div>
  );
}

function CustomDateModal({ dark, customFrom, customTo, setCustomFrom, setCustomTo, onApply, onClear, onClose }: {
  dark:boolean; customFrom:string; customTo:string; setCustomFrom:(v:string)=>void; setCustomTo:(v:string)=>void; onApply:()=>void; onClear:()=>void; onClose:()=>void;
}) {
  const border=dark?'#1e1e22':'#e5e7eb'; const txtHi=dark?'#f4f4f5':'#111827'; const txtMid=dark?'#71717a':'#374151';
  const inputStyle: React.CSSProperties = { width:'100%', padding:'9px 12px', borderRadius:'9px', border:`1px solid ${border}`, background:dark?'#1a1a1e':'#f9fafb', color:dark?'#f4f4f5':'#111827', fontSize:'14px', outline:'none', fontFamily:'inherit', boxSizing:'border-box' as any };
  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9998, background:'rgba(0,0,0,0.3)', backdropFilter:'blur(4px)' }}/>
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', zIndex:9999, background:dark?'#111113':'#fff', border:`1px solid ${border}`, borderRadius:'16px', padding:'20px', width:'90%', maxWidth:'320px', boxShadow:dark?'0 24px 60px rgba(0,0,0,0.6)':'0 12px 40px rgba(0,0,0,0.15)', fontFamily:'inherit' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'16px' }}>
          <span style={{ fontSize:'14px', fontWeight:600, color:txtHi }}>Período personalizado</span>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:txtMid, display:'flex', padding:'4px' }}><X style={{ width:'16px', height:'16px' }}/></button>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:'12px' }}>
          <div><label style={{ fontSize:'12px', color:txtMid, display:'block', marginBottom:'5px', fontWeight:500 }}>Data inicial</label><input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={inputStyle}/></div>
          <div><label style={{ fontSize:'12px', color:txtMid, display:'block', marginBottom:'5px', fontWeight:500 }}>Data final</label><input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={inputStyle}/></div>
          <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
            <button onClick={onApply} style={{ flex:1, padding:'10px', borderRadius:'9px', background:'#0044fd', border:'none', color:'#fff', fontSize:'13px', fontWeight:500, cursor:'pointer' }}>Aplicar</button>
            <button onClick={onClear} style={{ flex:1, padding:'10px', borderRadius:'9px', border:`1px solid ${border}`, background:'transparent', color:txtMid, fontSize:'13px', cursor:'pointer' }}>Limpar</button>
          </div>
        </div>
      </div>
    </>
  );
}

function PhoneInput({ value, onChange, style: st }: { value:string; onChange:(v:string)=>void; style?:React.CSSProperties }) {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 11);
    let masked = '';
    if (digits.length === 0) masked = '';
    else if (digits.length <= 2) masked = `(${digits}`;
    else if (digits.length <= 7) masked = `(${digits.slice(0,2)}) ${digits.slice(2)}`;
    else masked = `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
    onChange(masked);
  }
  return <input type="tel" value={value} placeholder="(11) 91234-5678" onChange={handleChange} style={st}/>;
}

function FormStatusSelect({ value, onChange, dark, statusItems }: { value:number; onChange:(v:number)=>void; dark:boolean; statusItems: Array<{id:number;label:string;cor:string;ordem:number}> }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const options = [...statusItems].sort((a, b) => a.ordem - b.ordem).map(s => ({ value: s.id, label: s.label, dot: s.cor }));
  const selected = options.find(o => o.value === value) || options[0];
  const border = dark ? '#1e1e22' : '#e5e7eb';
  const bg = dark ? '#1a1a1e' : '#f9fafb';
  const txt = dark ? '#f4f4f5' : '#111827';
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(v => !v)} style={{ width:'100%', padding:'9px 12px', borderRadius:'9px', border:`1px solid ${border}`, background:bg, color:txt, fontSize:'13.5px', outline:'none', fontFamily:'inherit', cursor:'pointer', display:'flex', alignItems:'center', gap:'8px', textAlign:'left' }}>
        <span style={{ width:'8px', height:'8px', borderRadius:'50%', background:selected.dot, flexShrink:0 }}/>
        <span style={{ flex: 1 }}>{selected.label}</span>
        <ChevronDown style={{ width:'14px', height:'14px', color:txt }}/>
      </button>
      {open && (
        <div style={{ position:'absolute', top:'100%', left:0, right:0, marginTop:'4px', zIndex:9999, background:dark?'#111113':'#ffffff', border:`1px solid ${border}`, borderRadius:'10px', padding:'4px', boxShadow:dark?'0 8px 32px rgba(0,0,0,0.5)':'0 8px 24px rgba(0,0,0,0.1)' }}>
          {options.map(o => (
            <button type="button" key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} style={{ width:'100%', display:'flex', alignItems:'center', gap:'8px', padding:'8px 10px', borderRadius:'7px', border:'none', background:value===o.value?(dark?'rgba(255,255,255,0.07)':'#eff6ff'):'transparent', color:value===o.value?(dark?'#fff':'#0044fd'):(dark?'#a1a1aa':'#374151'), fontSize:'13px', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
              <span style={{ width:'8px', height:'8px', borderRadius:'50%', background:o.dot, flexShrink:0 }}/>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteConfirmDialog({ count, onConfirm, onCancel, loading, dark }: { count:number; onConfirm:()=>void; onCancel:()=>void; loading:boolean; dark:boolean }) {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:60, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.3)', backdropFilter:'blur(4px)' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background:dark?'#111113':'#fff', border:`1px solid ${dark?'#1e1e22':'#e5e7eb'}`, borderRadius:'16px', padding:'24px', width:'90%', maxWidth:'360px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'12px' }}>
          <div style={{ width:'36px', height:'36px', borderRadius:'10px', background:'#fff1f2', display:'flex', alignItems:'center', justifyContent:'center' }}><Trash2 style={{ width:'18px', height:'18px', color:'#dc2626' }}/></div>
          <h3 style={{ margin:0, fontSize:'15px', fontWeight:600, color:dark?'#fff':'#111827' }}>Excluir {count>1?`${count} leads`:'lead'}?</h3>
        </div>
        <p style={{ fontSize:'13px', color:dark?'#9ca3af':'#6b7280', margin:'0 0 20px' }}>Esta ação não pode ser desfeita.</p>
        <div style={{ display:'flex', gap:'8px' }}>
          <button onClick={onCancel} style={{ flex:1, padding:'9px', borderRadius:'9px', border:`1px solid ${dark?'#1e1e22':'#e5e7eb'}`, background:dark?'#1a1a1e':'#f9fafb', color:dark?'#d4d4d8':'#374151', fontSize:'13px', cursor:'pointer' }}>Cancelar</button>
          <button onClick={onConfirm} disabled={loading} style={{ flex:1, padding:'9px', borderRadius:'9px', border:'none', background:'#dc2626', color:'#fff', fontSize:'13px', cursor:'pointer', opacity:loading?0.7:1 }}>{loading?'Excluindo…':'Sim, excluir'}</button>
        </div>
      </div>
    </div>
  );
}

function isColorTooLight(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.7;
}
function darkenColor(hex: string): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - 80);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - 80);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - 80);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
function lightenColor(hex: string): string {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 60);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 60);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 60);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function ObsTooltip({ text, dark }: { text: string; dark: boolean }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, below: false });
  const ref = useRef<HTMLDivElement>(null);
  function calcPos() {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const tooltipWidth = 240;
    const tooltipHeight = 60;
    let left = r.left + r.width / 2;
    if (left - tooltipWidth / 2 < 8) left = tooltipWidth / 2 + 8;
    if (left + tooltipWidth / 2 > window.innerWidth - 8) left = window.innerWidth - tooltipWidth / 2 - 8;
    const spaceAbove = r.top;
    const below = spaceAbove < tooltipHeight + 16;
    const top = below ? r.bottom + 6 : r.top - 6;
    setPos({ top, left, below });
  }
  function handleEnter() { calcPos(); setShow(true); }
  return (
    <>
      <div ref={ref} style={{ position:'relative', display:'inline-flex', flexShrink:0 }} onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)} onClick={e => { e.stopPropagation(); calcPos(); setShow(v=>!v); }}>
        <div style={{ width:'16px', height:'16px', borderRadius:'50%', background:dark?'rgba(255,255,255,0.08)':'rgba(0,0,0,0.06)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={dark?'#9ca3af':'#6b7280'} strokeWidth="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
      </div>
      {show && createPortal(
        <div style={{ position:'fixed', top:pos.top, left:pos.left, transform:pos.below?'translate(-50%,0)':'translate(-50%,-100%)', zIndex:99999, background:'#1f2937', color:'#f9fafb', fontSize:'12px', lineHeight:1.5, padding:'8px 12px', borderRadius:'9px', maxWidth:'240px', minWidth:'120px', whiteSpace:'pre-wrap', wordBreak:'break-word', boxShadow:'0 4px 16px rgba(0,0,0,0.3)', pointerEvents:'none' }}>
          {text}
          {pos.below
            ? <div style={{ position:'absolute', bottom:'100%', left:'50%', transform:'translateX(-50%)', width:0, height:0, borderLeft:'5px solid transparent', borderRight:'5px solid transparent', borderBottom:'5px solid #1f2937' }}/>
            : <div style={{ position:'absolute', top:'100%', left:'50%', transform:'translateX(-50%)', width:0, height:0, borderLeft:'5px solid transparent', borderRight:'5px solid transparent', borderTop:'5px solid #1f2937' }}/>}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Campaign Filter Dropdown ──────────────────────────────────────────────────
function CampFilterDropdown({ dark, campaigns, pendingSelected, onToggle, onApply, onClear, onClose, pos }: {
  dark: boolean;
  campaigns: { name: string; count: number; isActive: boolean }[];
  pendingSelected: Set<string>;
  onToggle: (name: string) => void;
  onApply: () => void;
  onClear: () => void;
  onClose: () => void;
  pos?: { top: number; left: number };
}) {
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const border = dark ? '#27272a' : '#e5e7eb';
  const txtHi = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#71717a' : '#6b7280';
  const bg = dark ? '#111113' : '#fff';
  const rowBg = dark ? '#1a1a1e' : '#f9fafb';

  const activeCamps   = campaigns.filter(c => c.isActive);
  const inactiveCamps = campaigns.filter(c => !c.isActive);
  const hasInactive   = inactiveCamps.length > 0;
  const q = search.trim().toLowerCase();
  const visibleActive   = activeCamps.filter(c => !q || c.name.toLowerCase().includes(q));
  const visibleInactive = inactiveCamps.filter(c => !q || c.name.toLowerCase().includes(q));
  const selectedLeadCount = campaigns.filter(c => pendingSelected.has(c.name)).reduce((s, c) => s + c.count, 0);
  const hasSelection = pendingSelected.size > 0;

  function CampRow({ camp }: { camp: { name: string; count: number; isActive: boolean } }) {
    const isSel = pendingSelected.has(camp.name);
    return (
      <button
        onClick={() => onToggle(camp.name)}
        style={{ width:'100%', display:'flex', alignItems:'center', gap:'8px', padding:'6px 8px', borderRadius:'7px', border:'none', background:isSel?(dark?'rgba(0,68,253,0.1)':'#eff6ff'):'transparent', cursor:'pointer', textAlign:'left', fontFamily:'inherit', marginBottom:'1px' }}
      >
        <div style={{ width:'14px', height:'14px', borderRadius:'3px', border:`2px solid ${isSel?'#2563eb':(dark?'#3f3f46':'#d1d5db')}`, background:isSel?'#2563eb':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 0.1s' }}>
          {isSel && <Check style={{ width:'9px', height:'9px', color:'#fff' }}/>}
        </div>
        <span style={{ flex:1, fontSize:'12.5px', fontWeight:500, color:isSel?(dark?'#7ab0ff':'#0044fd'):txtHi, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:'5px' }}>
          {hasInactive && camp.isActive && <span style={{ width:'5px', height:'5px', borderRadius:'50%', background:'#10b981', flexShrink:0, display:'inline-block' }}/>}
          {camp.name || 'Sem campanha'}
        </span>
        <span style={{ fontSize:'11px', color:txtMid, background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.05)', padding:'1px 6px', borderRadius:'99px', flexShrink:0 }}>
          {camp.count}
        </span>
      </button>
    );
  }

  const menuWidth = 264;
  let leftPos = pos?.left ?? 0;
  if (leftPos + menuWidth > window.innerWidth - 8) {
    leftPos = window.innerWidth - menuWidth - 8;
  }
  if (leftPos < 8) leftPos = 8;
  const topPos = pos?.top ?? 0;

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9998 }} />
      <div onClick={e => e.stopPropagation()} style={{ position:'fixed', top:topPos, left:leftPos, zIndex:9999, background:bg, border:`1px solid ${border}`, borderRadius:'12px', width:`${menuWidth}px`, maxHeight:'370px', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:dark?'0 8px 24px rgba(0,0,0,0.4)':'0 8px 24px rgba(0,0,0,0.12)', fontFamily:'inherit' }}>
        {/* Search */}
        <div style={{ padding:'8px', borderBottom:`1px solid ${border}`, flexShrink:0 }}>
          <div style={{ position:'relative' }}>
            <Search style={{ position:'absolute', left:'8px', top:'50%', transform:'translateY(-50%)', width:'12px', height:'12px', color:txtMid }}/>
            <input
              autoFocus
              placeholder="Buscar campanha..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width:'100%', paddingLeft:'28px', paddingRight:'8px', paddingTop:'6px', paddingBottom:'6px', borderRadius:'7px', border:`1px solid ${border}`, background:rowBg, color:txtHi, fontSize:'12.5px', outline:'none', fontFamily:'inherit', boxSizing:'border-box' as any }}
            />
          </div>
        </div>

        {/* List */}
        <div style={{ overflowY:'auto', flex:1, padding:'6px' }}>
          {campaigns.length === 0 && (
            <div style={{ textAlign:'center', padding:'20px 0', color:txtMid, fontSize:'12px' }}>
              Nenhuma campanha encontrada
            </div>
          )}
          {visibleActive.map(camp => <CampRow key={camp.name} camp={camp} />)}
          {hasInactive && (
            <>
              <button
                onClick={() => setShowInactive(v => !v)}
                style={{ width:'100%', display:'flex', alignItems:'center', gap:'4px', padding:'5px 8px', borderRadius:'6px', border:'none', background:'transparent', cursor:'pointer', color:txtMid, fontSize:'11.5px', fontFamily:'inherit', textAlign:'left', marginTop:'2px' }}
              >
                <ChevronDown style={{ width:'11px', height:'11px', transform:showInactive?'rotate(180deg)':'rotate(0deg)', transition:'transform 0.15s' }}/>
                {showInactive ? 'Ocultar desativadas' : `Desativadas (${inactiveCamps.length})`}
              </button>
              {showInactive && visibleInactive.map(camp => <CampRow key={camp.name} camp={camp} />)}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'7px 8px', borderTop:`1px solid ${border}`, display:'flex', gap:'6px', flexShrink:0 }}>
          <button onClick={onClear} style={{ padding:'5px 10px', borderRadius:'7px', border:`1px solid ${border}`, background:'transparent', color:txtMid, fontSize:'12px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
            Limpar
          </button>
          <button
            onClick={onApply}
            style={{ flex:1, padding:'5px 10px', borderRadius:'7px', border:'none', background:'#0044fd', color:'#fff', fontSize:'12px', fontWeight:500, cursor:'pointer', fontFamily:'inherit' }}
          >
            {hasSelection ? `Aplicar (${selectedLeadCount})` : 'Aplicar'}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Bulk Tag Modal ────────────────────────────────────────────────────────────
type BulkTagOp  = { tagId: string; leadIds: string[] };
type BulkTagOps = { add: BulkTagOp[]; remove: BulkTagOp[] };

function BulkTagModal({ dark, tags, ids, leadTagsMap, selectedCount, onApply, onClose, onCreateTag }: {
  dark: boolean;
  tags: OrgTag[];
  ids: string[];
  leadTagsMap: Map<string, OrgTag[]>;
  selectedCount: number;
  onApply: (ops: BulkTagOps) => Promise<void>;
  onClose: () => void;
  onCreateTag: (nome: string, cor: string) => Promise<OrgTag | null>;
}) {
  const border = dark ? '#1e1e22' : '#e5e7eb';
  const txtHi = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#71717a' : '#6b7280';
  const bg = dark ? '#111113' : '#fff';

  const [localTags, setLocalTags] = useState<OrgTag[]>(tags);
  const [showNewTagForm, setShowNewTagForm] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagCor, setNewTagCor] = useState('#8b5cf6');
  const [creatingTag, setCreatingTag] = useState(false);

  // Computed once on mount: for each tag, how many selected leads currently have it
  const origState = useMemo(() => {
    const m = new Map<string, 'all' | 'some' | 'none'>();
    tags.forEach(tag => {
      const count = ids.filter(id => (leadTagsMap.get(id) || []).some(t => t.id === tag.id)).length;
      m.set(tag.id, count === 0 ? 'none' : count === ids.length ? 'all' : 'some');
    });
    return m;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // desired: null = unchanged | true = add to all | false = remove from all
  const [desired, setDesired] = useState<Map<string, boolean | null>>(() => new Map());
  const [applying, setApplying] = useState(false);

  function getVisual(tagId: string, prev: Map<string, boolean | null>): 'checked' | 'indeterminate' | 'unchecked' {
    const d = prev.get(tagId) ?? null;
    if (d === true) return 'checked';
    if (d === false) return 'unchecked';
    const orig = origState.get(tagId) ?? 'none';
    if (orig === 'all') return 'checked';
    if (orig === 'some') return 'indeterminate';
    return 'unchecked';
  }

  function clickTag(tagId: string) {
    setDesired(prev => {
      const n = new Map(prev);
      const vis = getVisual(tagId, prev);
      const orig = origState.get(tagId) ?? 'none';
      if (vis === 'checked') {
        n.set(tagId, orig === 'none' ? null : false);  // checked → unchecked
      } else {
        n.set(tagId, orig === 'all' ? null : true);    // indet/unchecked → checked
      }
      return n;
    });
  }

  const hasChanges = Array.from(desired.values()).some(v => v !== null);

  async function handleApply() {
    const add: BulkTagOp[] = [];
    const remove: BulkTagOp[] = [];
    localTags.forEach(tag => {
      const d = desired.get(tag.id) ?? null;
      if (d === null) return;
      if (d === true) {
        const missing = ids.filter(id => !(leadTagsMap.get(id) || []).some(t => t.id === tag.id));
        if (missing.length) add.push({ tagId: tag.id, leadIds: missing });
      } else {
        const having = ids.filter(id => (leadTagsMap.get(id) || []).some(t => t.id === tag.id));
        if (having.length) remove.push({ tagId: tag.id, leadIds: having });
      }
    });
    setApplying(true);
    await onApply({ add, remove });
    setApplying(false);
  }

  async function handleCreateNew() {
    if (!newTagName.trim()) return;
    setCreatingTag(true);
    const tag = await onCreateTag(newTagName.trim(), newTagCor);
    if (tag) {
      setLocalTags(prev => [...prev, tag]);
      setDesired(prev => { const n = new Map(prev); n.set(tag.id, true); return n; });
      setNewTagName('');
      setShowNewTagForm(false);
    }
    setCreatingTag(false);
  }

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9998, background:'rgba(0,0,0,0.4)', backdropFilter:'blur(4px)' }}/>
      <div onClick={e => e.stopPropagation()} style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', zIndex:9999, background:bg, border:`1px solid ${border}`, borderRadius:'16px', width:'90%', maxWidth:'400px', boxShadow:dark?'0 24px 60px rgba(0,0,0,0.6)':'0 12px 40px rgba(0,0,0,0.15)', fontFamily:'inherit', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:`1px solid ${border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
            <Tag style={{ width:'16px', height:'16px', color:'#8b5cf6' }}/>
            <span style={{ fontSize:'14px', fontWeight:600, color:txtHi }}>Tags — {selectedCount} lead{selectedCount !== 1 ? 's' : ''}</span>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:txtMid, display:'flex', padding:'4px' }}><X style={{ width:'16px', height:'16px' }}/></button>
        </div>

        {localTags.length === 0 ? (
          <div style={{ padding:'32px', textAlign:'center', color:txtMid, fontSize:'13px' }}>Nenhuma tag criada. Crie uma abaixo.</div>
        ) : (
          <div style={{ padding:'8px', maxHeight:'300px', overflowY:'auto' }}>
            {localTags.map(tag => {
              const vis = getVisual(tag.id, desired);
              const orig = origState.get(tag.id) ?? 'none';
              const d = desired.get(tag.id) ?? null;
              const countWith = ids.filter(id => (leadTagsMap.get(id) || []).some(t => t.id === tag.id)).length;
              const isActive = vis !== 'unchecked';
              return (
                <button key={tag.id} onClick={() => clickTag(tag.id)}
                  style={{ width:'100%', display:'flex', alignItems:'center', gap:'10px', padding:'9px 10px', borderRadius:'9px', border:'none', background:isActive?(dark?'rgba(139,92,246,0.08)':'#f5f3ff'):'transparent', cursor:'pointer', textAlign:'left', fontFamily:'inherit', marginBottom:'2px' }}>
                  <div style={{ width:'16px', height:'16px', borderRadius:'4px', border:`2px solid ${isActive?'#8b5cf6':(dark?'#3f3f46':'#d1d5db')}`, background:isActive?'#8b5cf6':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 0.12s' }}>
                    {vis === 'checked'       && <Check style={{ width:'10px', height:'10px', color:'#fff' }}/>}
                    {vis === 'indeterminate' && <div style={{ width:'8px', height:'2px', background:'#fff', borderRadius:'1px' }}/>}
                  </div>
                  <span style={{ flex:1, display:'flex', alignItems:'center', gap:'6px', minWidth:0 }}>
                    <span style={{ width:'8px', height:'8px', borderRadius:'50%', background:tag.cor, flexShrink:0 }}/>
                    <span style={{ fontSize:'13px', fontWeight:600, color:isActive?(dark?'#c4b5fd':'#7c3aed'):txtHi, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tag.nome}</span>
                  </span>
                  <span style={{ fontSize:'11px', flexShrink:0, whiteSpace:'nowrap',
                    color: d !== null ? (d ? '#8b5cf6' : '#ef4444') : txtMid }}>
                    {d !== null
                      ? (d ? '+ todos' : '− todos')
                      : orig === 'some' ? `${countWith}/${ids.length}`
                      : orig === 'all'  ? 'todos'
                      : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {localTags.length > 0 && (
          <div style={{ padding:'8px 14px 0', display:'flex', alignItems:'center', gap:'12px', fontSize:'10.5px', color:txtMid }}>
            <span>✓ todos</span><span>— alguns</span><span>□ nenhum</span>
          </div>
        )}

        {/* Formulário de nova tag inline */}
        {showNewTagForm && (
          <div style={{ margin:'8px 16px 0', padding:'12px', borderRadius:'10px', background:dark?'rgba(139,92,246,0.06)':'#f5f3ff', border:`1px solid ${dark?'rgba(139,92,246,0.2)':'#ddd6fe'}`, display:'flex', flexDirection:'column', gap:'8px' }}>
            <input
              value={newTagName}
              onChange={e => setNewTagName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateNew(); if (e.key === 'Escape') setShowNewTagForm(false); }}
              placeholder="Nome da nova tag…"
              autoFocus
              style={{ width:'100%', padding:'7px 10px', borderRadius:'8px', border:`1px solid ${dark?'#3f3f46':'#d1d5db'}`, background:dark?'#0d0d0f':'#fff', color:dark?'#f4f4f5':'#111827', fontSize:'13px', outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}
            />
            <div style={{ display:'flex', flexWrap:'wrap', gap:'5px' }}>
              {CORES_TAGS.map(cor => (
                <button key={cor} onClick={() => setNewTagCor(cor)}
                  style={{ width:'20px', height:'20px', borderRadius:'50%', background:cor, border:`2px solid ${newTagCor === cor ? (dark?'#fff':'#111') : 'transparent'}`, cursor:'pointer', padding:0, flexShrink:0, outline:newTagCor === cor ? `2px solid ${cor}` : 'none', outlineOffset:'1px' }} />
              ))}
            </div>
            <div style={{ display:'flex', gap:'6px' }}>
              <button onClick={() => setShowNewTagForm(false)} style={{ padding:'6px 12px', borderRadius:'8px', border:`1px solid ${border}`, background:'transparent', color:txtMid, fontSize:'12px', cursor:'pointer', fontFamily:'inherit' }}>Cancelar</button>
              <button onClick={handleCreateNew} disabled={creatingTag || !newTagName.trim()}
                style={{ flex:1, padding:'6px 12px', borderRadius:'8px', border:'none', background:newTagName.trim()?'#8b5cf6':(dark?'#27272a':'#e5e7eb'), color:newTagName.trim()?'#fff':txtMid, fontSize:'12px', fontWeight:600, cursor:newTagName.trim()?'pointer':'default', fontFamily:'inherit' }}>
                {creatingTag ? 'Criando…' : 'Criar e marcar'}
              </button>
            </div>
          </div>
        )}

        <div style={{ padding:'12px 16px', borderTop:`1px solid ${border}`, marginTop:'8px', display:'flex', flexDirection:'column', gap:'8px' }}>
          {!showNewTagForm && (
            <button onClick={() => setShowNewTagForm(true)}
              style={{ width:'100%', padding:'7px', borderRadius:'9px', border:`1px dashed ${dark?'rgba(139,92,246,0.4)':'#c4b5fd'}`, background:'transparent', color:'#8b5cf6', fontSize:'12.5px', fontWeight:500, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:'5px' }}>
              + Nova tag
            </button>
          )}
          <div style={{ display:'flex', gap:'8px' }}>
            <button onClick={onClose} style={{ padding:'9px 16px', borderRadius:'9px', border:`1px solid ${border}`, background:'transparent', color:txtMid, fontSize:'13px', cursor:'pointer', fontFamily:'inherit' }}>Cancelar</button>
            <button onClick={handleApply} disabled={applying}
              style={{ flex:1, padding:'9px', borderRadius:'9px', border:'none', background:hasChanges?'#8b5cf6':(dark?'#27272a':'#e5e7eb'), color:hasChanges?'#fff':txtMid, fontSize:'13px', fontWeight:500, cursor:applying?'not-allowed':'pointer', fontFamily:'inherit' }}>
              {applying ? 'Aplicando…' : hasChanges ? 'Confirmar' : 'Sem alterações'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Unified Selection + Actions Bar ───────────────────────────────────────────
function UnifiedSelectionBar({ selectedCount, allSystemSelected, hasActiveFilters, filteredCount, totalCount, allSelectedAreEvaluated, dark, isMobile, statusItems, onSelectAll, onClearSelection, onMoveStatus, onToggleAvaliado, onBulkTag, onDelete }: {
  selectedCount: number;
  allSystemSelected: boolean;
  hasActiveFilters: boolean;
  filteredCount: number;
  totalCount: number;
  allSelectedAreEvaluated: boolean;
  dark: boolean;
  isMobile: boolean;
  statusItems: Array<{id:number;label:string;cor:string;ordem:number}>;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onMoveStatus: (status: number) => void;
  onToggleAvaliado: () => void;
  onBulkTag: () => void;
  onDelete: () => void;
}) {
  const [showStatusDrop, setShowStatusDrop] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });
  const border = dark ? '#1e1e22' : '#e5e7eb';
  const barBorder = dark ? 'rgba(0,68,253,0.22)' : '#bfdbfe';
  const accentTxt = dark ? '#7ab0ff' : '#0044fd';
  const btnBg = dark ? '#111113' : '#fff';
  const btnBorder = dark ? '#2d3748' : '#d1d5db';
  const btnTxt = dark ? '#cbd5e1' : '#374151';

  const statusOpts = [...statusItems].sort((a, b) => a.ordem - b.ordem).map(s => ({ value: s.id, label: s.label, dot: s.cor }));

  function openDrop() {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
    }
    setShowStatusDrop(v => !v);
  }

  const selectAllLabel = hasActiveFilters
    ? `Ver todos (${filteredCount})`
    : `Ver todos (${totalCount})`;

  return (
    <div style={{ padding:'10px 14px', background:dark?'rgba(0,68,253,0.08)':'#eff6ff', border:`1px solid ${barBorder}`, borderRadius:'10px', marginBottom:'12px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>

      {/* Lado esquerdo: info de seleção */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap', minWidth:0, flex:1 }}>
        <span style={{ fontSize:'13px', fontWeight:600, color:accentTxt, display:'flex', alignItems:'center', gap:'5px', whiteSpace:'nowrap' }}>
          <Check style={{ width:'13px', height:'13px', flexShrink:0 }}/>
          {allSystemSelected
            ? `Todos os ${filteredCount} lead${filteredCount !== 1 ? 's' : ''} selecionados`
            : `${selectedCount} lead${selectedCount !== 1 ? 's' : ''} selecionado${selectedCount !== 1 ? 's' : ''}`}
        </span>
        {!allSystemSelected && (
          <>
            <span style={{ color:dark?'rgba(147,197,253,0.25)':'#bfdbfe', fontSize:'13px', flexShrink:0 }}>·</span>
            <button onClick={onSelectAll} style={{ background:'none', border:'none', cursor:'pointer', color:dark?'#6b9fff':'#0044fd', fontWeight:600, fontSize:'12.5px', padding:0, textDecoration:'underline', fontFamily:'inherit', whiteSpace:'nowrap' }}>
              {selectAllLabel}
            </button>
          </>
        )}
        <span style={{ color:dark?'rgba(147,197,253,0.25)':'#bfdbfe', fontSize:'13px', flexShrink:0 }}>·</span>
        <button onClick={onClearSelection} style={{ background:'none', border:'none', cursor:'pointer', color:dark?'#6b7280':'#9ca3af', fontSize:'12px', padding:0, fontFamily:'inherit', whiteSpace:'nowrap' }}>
          Limpar
        </button>
      </div>

      {/* Lado direito: botões de ação */}
      <div style={{ display:'flex', alignItems:'center', gap:'6px', flexShrink:0, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        {/* Mover para status */}
        <div style={{ position:'relative' }}>
          <button ref={btnRef} onClick={openDrop} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'6px 10px', borderRadius:'8px', border:`1px solid ${btnBorder}`, background:btnBg, color:btnTxt, fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
            Mover para <ChevronDown style={{ width:'11px', height:'11px', transform:showStatusDrop?'rotate(180deg)':'', transition:'transform 0.15s' }}/>
          </button>
          {showStatusDrop && (
            <>
              <div onClick={() => setShowStatusDrop(false)} style={{ position:'fixed', inset:0, zIndex:9998 }}/>
              <div style={{ position:'fixed', top:dropPos.top, left:dropPos.left, width:'190px', background:dark?'#111113':'#fff', border:`1px solid ${border}`, borderRadius:'10px', padding:'4px', zIndex:9999, boxShadow:dark?'0 8px 32px rgba(0,0,0,0.5)':'0 8px 24px rgba(0,0,0,0.12)' }}>
                {statusOpts.map(o => (
                  <button key={o.value} onClick={() => { onMoveStatus(o.value); setShowStatusDrop(false); }} style={{ width:'100%', display:'flex', alignItems:'center', gap:'8px', padding:'8px 10px', borderRadius:'7px', border:'none', background:'transparent', color:dark?'#d4d4d8':'#374151', fontSize:'13px', cursor:'pointer', textAlign:'left', fontFamily:'inherit' }}>
                    <span style={{ width:'7px', height:'7px', borderRadius:'50%', background:o.dot, flexShrink:0 }}/>
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Toggle avaliado */}
        <button onClick={onToggleAvaliado} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'6px 10px', borderRadius:'8px', border:`1px solid ${btnBorder}`, background:btnBg, color:btnTxt, fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
          {allSelectedAreEvaluated
            ? <><X style={{ width:'12px', height:'12px' }}/> Desavaliar</>
            : <><Check style={{ width:'12px', height:'12px' }}/> Avaliar</>}
        </button>

        {/* Tag em massa */}
        <button onClick={onBulkTag} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'6px 10px', borderRadius:'8px', border:`1px solid ${btnBorder}`, background:btnBg, color:'#8b5cf6', fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
          <Tag style={{ width:'12px', height:'12px' }}/> Tag
        </button>

        {/* Excluir */}
        <button onClick={onDelete} style={{ display:'flex', alignItems:'center', gap:'5px', padding:'6px 10px', borderRadius:'8px', border:'1px solid #fecaca', background:dark?'rgba(220,38,38,0.08)':'#fff1f2', color:'#dc2626', fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}>
          <Trash2 style={{ width:'12px', height:'12px' }}/> Excluir ({selectedCount})
        </button>
      </div>
    </div>
  );
}

// ── Confirm Dialog (reutilizável) ─────────────────────────────────────────────
function ConfirmDialog({ title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', onConfirm, onCancel, loading, dark, variant = 'default' }: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
  dark: boolean;
  variant?: 'default' | 'danger';
}) {
  const border = dark ? '#1e1e22' : '#e5e7eb';
  const confirmBg = variant === 'danger' ? '#dc2626' : '#2563eb';
  return (
    <div style={{ position:'fixed', inset:0, zIndex:60, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.3)', backdropFilter:'blur(4px)' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background:dark?'#111113':'#fff', border:`1px solid ${border}`, borderRadius:'16px', padding:'24px', width:'90%', maxWidth:'380px' }}>
        <h3 style={{ margin:'0 0 10px', fontSize:'15px', fontWeight:600, color:dark?'#fff':'#111827' }}>{title}</h3>
        <p style={{ fontSize:'13px', color:dark?'#9ca3af':'#6b7280', margin:'0 0 20px', lineHeight:1.5 }}>{message}</p>
        <div style={{ display:'flex', gap:'8px' }}>
          <button onClick={onCancel} disabled={loading} style={{ flex:1, padding:'9px', borderRadius:'9px', border:`1px solid ${border}`, background:dark?'#1a1a1e':'#f9fafb', color:dark?'#d4d4d8':'#374151', fontSize:'13px', cursor:loading?'not-allowed':'pointer', opacity:loading?0.5:1 }}>{cancelText}</button>
          <button onClick={onConfirm} disabled={loading} style={{ flex:1, padding:'9px', borderRadius:'9px', border:'none', background:confirmBg, color:'#fff', fontSize:'13px', cursor:loading?'not-allowed':'pointer', opacity:loading?0.7:1 }}>
            {loading ? '…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Main Page ─────────────────────────────────────────────────────────────────
function LeadsPage() {
  const navigate = useNavigate();
  const { updateLead, configuracoes, campaigns: storeCampaigns, setCampaigns: setStoreCampaigns } = useAppStore();
  const { metaToken, metaAccount } = useMetaConfig();
  const { theme } = useTheme();
  const { user } = useAuth();
  const { orgId, ready: orgReady } = useOrgId();
  const t = useTerminology();
  const modelo = useModeloNegocio();
  const { config: statusConfig } = useStatusConfig(modelo);
  const dark = theme === 'dark';
  const { plano, features, loading: planLoading } = usePlanFeatures();

  const [campDropPos, setCampDropPos] = useState({ top: 0, left: 0 });
  const [tagDropPos, setTagDropPos] = useState({ top: 0, left: 0 });

  const statusOptions = useMemo(() => {
    const sorted = [...statusConfig.statuses].sort((a, b) => a.ordem - b.ordem);
    return [
      { label: 'Todos os status', value: 'all' },
      { label: '🆕 Novo', value: 'novo' },
      ...sorted.map(s => ({ label: s.label, value: String(s.id), dot: s.cor })),
    ];
  }, [statusConfig]);

  const getStatusLabel = useCallback((statusId: number) => {
    return statusConfig.statuses.find(s => s.id === statusId)?.label
      ?? (STATUS_LABELS as Record<number, string>)[statusId]
      ?? String(statusId);
  }, [statusConfig]);

  const getStatusPillStyle = useCallback((statusId: number, isDark: boolean) => {
    const configStatus = statusConfig.statuses.find(s => s.id === statusId);
    if (configStatus) {
      const cor = configStatus.cor;
      const displayCor = isColorTooLight(cor) && !isDark ? darkenColor(cor) : cor;
      return {
        bg: isDark ? `${displayCor}25` : `${displayCor}18`,
        color: isDark ? lightenColor(displayCor) : darkenColor(displayCor),
        dot: displayCor,
        border: `${displayCor}30`,
      };
    }
    return isDark ? (DARK_STATUS_PILL[statusId] || DARK_STATUS_PILL[1]) : (LIGHT_STATUS_PILL[statusId] || LIGHT_STATUS_PILL[1]);
  }, [statusConfig]);

  const { hasWA } = useWhatsAppAccount();

  const handleWhatsApp = useCallback((lead: Lead) => {
    if (!lead.whatsapp) return;
    const clean = lead.whatsapp.replace(/\D/g, '');
    const phone = clean.startsWith('55') ? clean : `55${clean}`;
    if (hasWA) { navigate(`/whatsapp?phone=${phone}`); }
    else { window.open(`https://wa.me/${phone}`, '_blank'); }
  }, [navigate, hasWA]);

  const [isMobile, setIsMobile] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
  const longPressTriggered = useRef(false);

  useEffect(() => { const check=()=>setIsMobile(window.innerWidth<768); check(); window.addEventListener('resize',check); return()=>window.removeEventListener('resize',check); }, []);

  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const bgCancelRef = useRef(0);
  const INITIAL_SIZE = 200;
  const PAGE_SIZE = 100;

  // ── Filters ───────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [periodFilter, setPeriodFilter] = useState('all');
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(new Set());
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [pendingCampaigns, setPendingCampaigns] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const leadsPerPage = 20;
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [sortByScore, setSortByScore] = useState<'asc'|'desc'|null>(null);
  const [sortByDate, setSortByDate] = useState<'asc'|'desc'>('desc');

  // ── Tags ──────────────────────────────────────────────────────────────────
  const { tags: orgTags, createTag: createOrgTag, updateTag: updateOrgTag, deleteTag: deleteOrgTag } = useTags(orgId);
  const [leadTagsMap, setLeadTagsMap] = useState<Map<string, OrgTag[]>>(new Map());
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [newTagFilterName, setNewTagFilterName] = useState('');
  const [newTagFilterCor, setNewTagFilterCor] = useState('#8b5cf6');
  const [creatingTagFilter, setCreatingTagFilter] = useState(false);
  const orgTagsRef = useRef<OrgTag[]>([]);
  // ── Tag Manager Modal ─────────────────────────────────────────
  const [showTagManagerModal, setShowTagManagerModal] = useState(false);
  const [mgrEditId, setMgrEditId] = useState<string | null>(null);
  const [mgrEditNome, setMgrEditNome] = useState('');
  const [mgrEditCor, setMgrEditCor] = useState('');
  const [mgrDeleteId, setMgrDeleteId] = useState<string | null>(null);
  const [mgrNewNome, setMgrNewNome] = useState('');
  const [mgrNewCor, setMgrNewCor] = useState(CORES_TAGS[0]);
  const [mgrCreating, setMgrCreating] = useState(false);

  // ── Lead actions ──────────────────────────────────────────────────────────
  const [viewingLead, setViewingLead] = useState<Lead|null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead|null>(null);
  const [newLead, setNewLead] = useState({ nome:'', whatsapp:'', cidade:'', origem:'', origemCustom:'', status: statusConfig.entrada_status, observacoes:'' });
  const [custoIndicacaoInput, setCustoIndicacaoInput] = useState<string>('');
  const addingRef = useRef(false);
  const ORIGENS = ['Indicação', 'Tráfego Pago', 'Instagram Orgânico', 'Outro'];

  // ── Selection ─────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allSystemSelected, setAllSystemSelected] = useState(false);

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const [showDeleteConf, setShowDeleteConf] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showMoveStatusConfirm, setShowMoveStatusConfirm] = useState(false);
  const [pendingMoveStatus, setPendingMoveStatus] = useState<number|null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [showAvaliarConf, setShowAvaliarConf] = useState(false);
  const [showBulkTagModal, setShowBulkTagModal] = useState(false);
  const [campDeepFilter, setCampDeepFilter] = useState<{
    type: 'campaign'|'adset'|'ad';
    campaignId: string;
    campaignName?: string;
    adSetId?: string;
    adSetName?: string;
    adId?: string;
    adName?: string;
    showRevs: boolean;
    datePreset?: string;
  } | null>(null);

  const [targetLeadId, setTargetLeadId] = useState<string | null>(null);

  // ── URL params → filters (on mount only) ─────────────────────────────────
  const urlParamsApplied = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const periodo = params.get('periodo');
    const campanha = params.get('campanha');
    const de = params.get('de');
    const ate = params.get('ate');
    const status = params.get('status');
    const searchParam = params.get('search');
    const idParam = params.get('id');

    let hasUrlParams = false;
    if (periodo) { setPeriodFilter(periodo); hasUrlParams = true; }
    if (de) { setCustomFrom(de); hasUrlParams = true; }
    if (ate) { setCustomTo(ate); hasUrlParams = true; }
    if (campanha) {
      try { setSelectedCampaigns(new Set([decodeURIComponent(campanha).split('|')[0].trim()])); }
      catch { setSelectedCampaigns(new Set([campanha.split('|')[0].trim()])); }
      hasUrlParams = true;
    }
    if (status) { setStatusFilter(status); hasUrlParams = true; }
    if (searchParam) { setSearch(decodeURIComponent(searchParam)); hasUrlParams = true; }
    if (idParam) { setTargetLeadId(idParam); }

    urlParamsApplied.current = true;

    // Restore from localStorage only if no URL params
    if (!hasUrlParams && orgId) {
      try {
        const saved = localStorage.getItem(`leads_filters_${orgId}`);
        if (saved) {
          const f = JSON.parse(saved);
          if (f.periodFilter && f.periodFilter !== 'custom') setPeriodFilter(f.periodFilter);
          if (f.statusFilter) setStatusFilter(f.statusFilter);
          if (f.selectedCampaigns?.length) setSelectedCampaigns(new Set(f.selectedCampaigns));
          if (f.sortByDate) setSortByDate(f.sortByDate);
        }
      } catch {}
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load deep campaign filter from Campanhas page ────────────────────────
  const deepFilterApplied = useRef(false);
  useEffect(() => {
    if (!orgId || deepFilterApplied.current) return;
    deepFilterApplied.current = true;
    try {
      const raw = localStorage.getItem(`leads_campaign_filter_${orgId}`);
      if (raw) {
        const df = JSON.parse(raw);
        setCampDeepFilter(df);
        localStorage.removeItem(`leads_campaign_filter_${orgId}`);
        // Aplica o mesmo período que estava na página de Campanhas
        if (df.datePreset) {
          const periodMap: Record<string, string> = {
            today: 'today', yesterday: 'yesterday',
            last_7d: '7days', last_30d: '30days', this_month: 'month',
          };
          const mapped = periodMap[df.datePreset];
          if (mapped) setPeriodFilter(mapped);
        }
        if (df.showRevs) {
          setStatusFilter('3');
        }
        // Toast com nomes legíveis
        const campNm = df.campaignName || df.campaignId || 'Campanha';
        const asNm = df.adSetName || df.adSetId || '';
        const adNm = df.adName || df.adId || '';
        if (df.showRevs) {
          const term = (window as any).__terminology || { convertidoPlural: 'aprovados' };
          const src = df.type === 'ad' ? adNm : df.type === 'adset' ? asNm : campNm;
          toast(`Filtrando ${term.convertidoPlural} de: ${src}`);
        } else if (df.type === 'campaign') {
          toast(`Filtrando por: ${campNm}`);
        } else if (df.type === 'adset') {
          toast(`Filtrando por: ${campNm} → ${asNm}`);
        } else {
          toast(`Filtrando por: ${campNm} → ${asNm} → ${adNm}`);
        }
      } else {
      }
    } catch (err) {
      console.error('[FILTRO-DEEP] Erro ao ler filtro:', err);
    }
  }, [orgId]);

  // ── Persist filters to localStorage ──────────────────────────────────────
  useEffect(() => {
    if (!orgId || !urlParamsApplied.current) return;
    try {
      localStorage.setItem(`leads_filters_${orgId}`, JSON.stringify({
        periodFilter,
        statusFilter,
        selectedCampaigns: Array.from(selectedCampaigns),
        sortByDate,
      }));
    } catch {}
  }, [orgId, periodFilter, statusFilter, selectedCampaigns, sortByDate]);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadRestInBackground = useCallback(async (total: number, loaded: number) => {
    const gen = ++bgCancelRef.current;
    let from = loaded;
    while (from < total) {
      if (bgCancelRef.current !== gen) break;
      const to = Math.min(from + PAGE_SIZE - 1, total - 1);
      const { data } = await supabase
        .from('leads')
        .select(`id, nome, whatsapp, cidade, status, created_at, entrada_at, utm_source, utm_campaign, utm_medium, utm_content, score, faixa, observacoes, motivo_reprovacao, ultimo_status_change, status_aprovado_at, status_reuniao_at, status_contrato_at, status_atendimento_at, status_sem_retorno_at, org_id, wa_sent, avaliado, instagram, lead_tags(tag_id, tags(id, nome, cor))`)
        .order('entrada_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .eq('org_id', orgId)
        .range(from, to);
      if (bgCancelRef.current !== gen) break;
      if (data?.length) {
        const raw = data as any[];
        const tagBatch = new Map<string, OrgTag[]>();
        raw.forEach(l => {
          if (l.lead_tags?.length) {
            const tags = (l.lead_tags as any[]).filter(lt => lt.tags).map(lt => ({ id: lt.tags.id, nome: lt.tags.nome, cor: lt.tags.cor, org_id: orgId as string, created_at: '' }) as OrgTag);
            if (tags.length) tagBatch.set(l.id, tags);
          }
        });
        if (tagBatch.size > 0) setLeadTagsMap(prev => { const next = new Map(prev); tagBatch.forEach((tags, id) => next.set(id, tags)); return next; });
        setAllLeads(prev => {
          const seen = new Set(prev.map(l => l.id));
          const fresh = (raw as unknown as Lead[]).filter(l => !seen.has(l.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      }
      from += PAGE_SIZE;
      await new Promise(r => setTimeout(r, 200));
    }
  }, [orgId]);

  const fetchLeads = useCallback(async () => {
    if (!orgReady || !orgId) return;
    bgCancelRef.current++;
    setIsLoading(true);
    setAllLeads([]);

    const { count } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);
    setTotalCount(count || 0);

    // Read deep filter from localStorage to prioritize fetching relevant leads
    let deepFilter: any = null;
    try {
      const raw = localStorage.getItem(`leads_campaign_filter_${orgId}`);
      if (raw) deepFilter = JSON.parse(raw);
    } catch {}

    let initialData: any[] = [];
    if (deepFilter) {
      let query = supabase
        .from('leads')
        .select(`id, nome, whatsapp, cidade, status, created_at, entrada_at, utm_source, utm_campaign, utm_medium, utm_content, score, faixa, observacoes, motivo_reprovacao, ultimo_status_change, status_aprovado_at, status_reuniao_at, status_contrato_at, status_atendimento_at, status_sem_retorno_at, org_id, wa_sent, avaliado, instagram, lead_tags(tag_id, tags(id, nome, cor))`)
        .eq('org_id', orgId);
      
      if (deepFilter.showRevs) {
        query = query.eq('status', 3);
      }
      
      if (deepFilter.campaignId) {
        query = query.ilike('utm_campaign', `%${deepFilter.campaignId}%`);
      }
      
      const { data: prioritized } = await query
        .order('entrada_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(200);
      if (prioritized?.length) {
        initialData = prioritized;
      }
    }

    const { data, error } = await supabase
      .from('leads')
      .select(`id, nome, whatsapp, cidade, status, created_at, entrada_at, utm_source, utm_campaign, utm_medium, utm_content, score, faixa, observacoes, motivo_reprovacao, ultimo_status_change, status_aprovado_at, status_reuniao_at, status_contrato_at, status_atendimento_at, status_sem_retorno_at, org_id, wa_sent, avaliado, instagram, lead_tags(tag_id, tags(id, nome, cor))`)
      .order('entrada_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .eq('org_id', orgId)
      .range(0, INITIAL_SIZE - 1);

    if (error) { toast.error('Erro ao carregar leads'); setIsLoading(false); return; }
    
    // Combine and deduplicate
    const seen = new Set<string>();
    const combined: any[] = [];
    
    for (const l of [...initialData, ...(data || [])]) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        combined.push(l);
      }
    }

    const tagSeed = new Map<string, OrgTag[]>();
    combined.forEach(l => {
      if (l.lead_tags?.length) {
        const tags = (l.lead_tags as any[]).filter(lt => lt.tags).map(lt => ({ id: lt.tags.id, nome: lt.tags.nome, cor: lt.tags.cor, org_id: orgId as string, created_at: '' }) as OrgTag);
        if (tags.length) tagSeed.set(l.id, tags);
      }
    });
    if (tagSeed.size > 0) setLeadTagsMap(tagSeed);
    setAllLeads(combined as unknown as Lead[]);
    setIsLoading(false);

    if (count && count > INITIAL_SIZE) {
      loadRestInBackground(count, INITIAL_SIZE);
    }
  }, [orgId, orgReady, loadRestInBackground]);

  useEffect(() => {
    if (!orgReady || !orgId) return;
    fetchLeads();
  }, [orgId, orgReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch real-time campaign statuses from Meta Ads API
  useEffect(() => {
    if (!metaToken || !metaAccount) return;
    const normId = metaAccount.startsWith('act_') ? metaAccount : `act_${metaAccount}`;
    const url = `https://graph.facebook.com/v18.0/${normId}/campaigns?fields=id,name,status&limit=100&access_token=${metaToken}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (data?.data) {
          setStoreCampaigns(data.data.map((c: any) => ({
            id: c.id, name: c.name, status: c.status,
            objective: '', budget: 0, budget_type: 'daily',
            spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, roas: 0, leads_api: 0, reach: 0,
          })));
        }
      })
      .catch(() => {}); // silently ignore — fallback to UTM-only list
  }, [metaToken, metaAccount]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewLead = useCallback(async (lead: Lead) => {
    setViewingLead(lead);
    const { data } = await supabase.from('leads').select('*').eq('id', lead.id).single();
    if (data) setViewingLead(data as unknown as Lead);
  }, []);

  useEffect(() => {
    if (!orgReady || !orgId) return;
    const ch = supabase.channel(`leads-rt2-${orgId}`)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'leads',filter:`org_id=eq.${orgId}`},p=>{
        const novo=p.new as Lead;
        setAllLeads(prev => {
          if (prev.some(l => l.id === novo.id)) return prev;
          setTimeout(() => {
            setTotalCount(c => c + 1);
            toast.success(`Novo lead: ${novo.nome||'Sem nome'}`,{duration:3000,position:'bottom-left'});
          }, 0);
          return [novo, ...prev];
        });
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'leads',filter:`org_id=eq.${orgId}`},p=>{ setAllLeads(prev=>prev.map(l=>l.id===(p.new as Lead).id?p.new as Lead:l)); })
      .on('postgres_changes',{event:'DELETE',schema:'public',table:'leads'},p=>{ setAllLeads(prev=>prev.filter(l=>l.id!==(p.old as{id:string}).id)); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [orgId, orgReady]);

  // Keep orgTagsRef in sync with orgTags state (which is updated via realtime in useTags)
  useEffect(() => { orgTagsRef.current = orgTags; }, [orgTags]);

  useEffect(() => {
    if (!orgId) return;
    const ch = (supabase as any).channel(`lead-tags-leads-${orgId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lead_tags' }, (p: any) => {
        const { lead_id, tag_id } = p.new;
        const tag = orgTagsRef.current.find((t: OrgTag) => t.id === tag_id);
        if (!tag) return;
        setLeadTagsMap(prev => {
          const next = new Map(prev);
          const existing = next.get(lead_id) || [];
          if (existing.find((t: OrgTag) => t.id === tag_id)) return prev;
          next.set(lead_id, [...existing, tag]);
          return next;
        });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'lead_tags' }, (p: any) => {
        const { lead_id, tag_id } = p.old;
        setLeadTagsMap(prev => {
          const next = new Map(prev);
          const existing = next.get(lead_id);
          if (!existing) return prev;
          const updated = existing.filter((t: OrgTag) => t.id !== tag_id);
          if (updated.length === 0) next.delete(lead_id);
          else next.set(lead_id, updated);
          return next;
        });
      })
      .subscribe();
    return () => { (supabase as any).removeChannel(ch); };
  }, [orgId]); // eslint-disable-line

  useEffect(() => {
    if (!targetLeadId || isLoading) return;
    const lead = allLeads.find(l => String(l.id) === String(targetLeadId));
    if (lead) { handleViewLead(lead); setTargetLeadId(null); }
    else if (allLeads.length > 0) {
      supabase.from('leads').select('*').eq('id', targetLeadId).single()
        .then(({ data }) => { if (data) { handleViewLead(data as unknown as Lead); setTargetLeadId(null); } });
    }
  }, [targetLeadId, isLoading, allLeads]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Campaign options ───────────────────────────────────────────────────────
  // Active/inactive based on Meta Ads status (independent of period).
  // With Meta Ads: ALL campaigns appear (active = ACTIVE status, regardless of
  //   whether they have leads in the current period). Count is period-filtered.
  // Without Meta Ads: only campaigns that have leads in the current period, all marked active.
  const campaignOptions = useMemo(() => {
    const leadsForPeriod = filterByPeriod(allLeads, periodFilter, customFrom, customTo);
    const countMap = new Map<string, number>();
    leadsForPeriod.forEach(l => {
      const name = extractCampaignName((l as any).utm_campaign);
      if (name) countMap.set(name, (countMap.get(name) || 0) + 1);
    });

    // Base list: only UTM-derived campaign names (campaigns that actually have leads)
    const utmEntries = Array.from(countMap.entries());

    if (storeCampaigns.length === 0) {
      // No Meta Ads connection: no way to know status, show all as active
      return utmEntries
        .map(([name, count]) => ({ name, count, isActive: true }))
        .sort((a, b) => b.count - a.count);
    }

    // Meta Ads connected: status from API. Unknown names (old/deleted campaigns) → inactive.
    const metaByName = new Map(storeCampaigns.map(c => [c.name, c]));

    return utmEntries
      .map(([name, count]) => {
        const meta = metaByName.get(name);
        return {
          name,
          count,
          isActive: meta ? meta.status === 'ACTIVE' : false,
        };
      })
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.count - a.count;
      });
  }, [allLeads, periodFilter, customFrom, customTo, storeCampaigns]);

  const activeMoveStatus = useMemo(() => {
    if (statusFilter !== 'all' && statusFilter !== 'novo') return parseInt(statusFilter);
    if (campDeepFilter?.showRevs) return 3;
    return null;
  }, [statusFilter, campDeepFilter]);

  const getLeadMoveDateForView = useCallback((lead: Lead) => {
    if (!activeMoveStatus) return getLeadEntryValue(lead);
    return getStatusMoveDate(lead, activeMoveStatus) || getLeadEntryValue(lead);
  }, [activeMoveStatus]);

  // ── Filtered leads (all active filters, AND logic) ────────────────────────
  const filtered = useMemo(() => {
    let r = [...allLeads];

    // Escolhe a data de referência para o filtro de período baseado no status selecionado:
    // cada status tem seu próprio timestamp de quando o lead foi movido para aquele status.
    const getRef = (l: Lead): string | null | undefined => {
      if (statusFilter === 'all' && !campDeepFilter) return getLeadEntryValue(l);
      const statusDate = activeMoveStatus ? getStatusMoveDate(l, activeMoveStatus) : null;
      return statusDate || getLeadEntryValue(l);
    };

    r = filterByPeriod(r, periodFilter, customFrom, customTo, getRef);
    if (statusFilter === 'novo') r = r.filter(l => toStatusNum(l.status) === 1 && !l.avaliado);
    else if (statusFilter !== 'all') r = r.filter(l => toStatusNum(l.status) === parseInt(statusFilter));
    if (selectedCampaigns.size > 0) {
      r = r.filter(l => selectedCampaigns.has(extractCampaignName((l as any).utm_campaign)));
    }
    if (campDeepFilter) {

      const filterCampaignId = String(campDeepFilter.campaignId || '').trim();
      const filterCampaignName = String(campDeepFilter.campaignName || '').trim().toLowerCase();
      const hasAdSetFilter = !!(campDeepFilter.adSetId || campDeepFilter.adSetName);

      r = r.filter((lead) => {
        const utmRaw = ((lead as any).utm_campaign || '').trim();
        const utmMediumRaw = ((lead as any).utm_medium || '').trim();
        const utmContentRaw = ((lead as any).utm_content || '').trim();

        if (!utmRaw) return false;

        const parts = utmRaw.split('|').map((p: string) => p.trim());

        const leadCampaignName = parts[0].toLowerCase().trim();
        const leadCampaignId = String(parts[1] || '').trim();

        let matchCampaign = false;

        // 1) Match por ID na posição parts[1]
        if (leadCampaignId && filterCampaignId) {
          matchCampaign = leadCampaignId === filterCampaignId;
        }

        // 2) Match quando utm_campaign é só o ID numérico (sem separador)
        if (!matchCampaign && filterCampaignId && !leadCampaignId) {
          matchCampaign = leadCampaignName === filterCampaignId.toLowerCase();
        }

        // 3) Match por nome (limpo de sufixos CBO/ABO/LEAD)
        if (!matchCampaign && filterCampaignName) {
          matchCampaign = matchCampaignName(parts[0], filterCampaignName);
        }

        if (!matchCampaign) return false;

        if (campDeepFilter.type === 'campaign') return true;

        let leadAdSetName = '';
        let leadAdSetId = '';
        if (parts.length >= 4) {
          leadAdSetName = parts[2].toLowerCase().trim();
          leadAdSetId = String(parts[3] || '').trim();
        } else if (utmMediumRaw) {
          const mParts = utmMediumRaw.split('|').map((p: string) => p.trim());
          leadAdSetName = mParts[0].toLowerCase().trim();
          leadAdSetId = String(mParts[1] || '').trim();
        }

        if (hasAdSetFilter) {
          const filterAdSetId = String(campDeepFilter.adSetId || '').trim();
          const filterAdSetName = String(campDeepFilter.adSetName || '').trim().toLowerCase();
          let matchAdSet = false;

          // Match adset por ID (parts[3]) ou por ID puro em parts[2]
          if (leadAdSetId && filterAdSetId) {
            matchAdSet = leadAdSetId === filterAdSetId;
          }
          if (!matchAdSet && filterAdSetId && !leadAdSetId && leadAdSetName) {
            matchAdSet = leadAdSetName === filterAdSetId.toLowerCase();
          }

          // Match adset por nome exato
          if (!matchAdSet && filterAdSetName && leadAdSetName) {
            matchAdSet = leadAdSetName === filterAdSetName;
          }

          if (!matchAdSet) return false;
        }

        if (campDeepFilter.type === 'adset') return true;

        let leadAdName = '';
        let leadAdId = '';
        if (parts.length >= 6) {
          leadAdName = parts[4].toLowerCase().trim();
          leadAdId = String(parts[5] || '').trim();
        } else if (utmContentRaw) {
          const cParts = utmContentRaw.split('|').map((p: string) => p.trim());
          leadAdName = cParts[0].toLowerCase().trim();
          leadAdId = String(cParts[1] || '').trim();
        }

        const filterAdId = String(campDeepFilter.adId || '').trim();
        const filterAdName = String(campDeepFilter.adName || '').trim().toLowerCase();

        let matchAd = false;

        // Match ad por ID exato
        if (leadAdId && filterAdId) {
          matchAd = leadAdId === filterAdId;
        }
        // Match ad por ID puro em leadAdName
        if (!matchAd && filterAdId && !leadAdId && leadAdName) {
          matchAd = leadAdName === filterAdId.toLowerCase();
        }
        // Match ad por nome (exato primeiro, depois substring)
        if (!matchAd && filterAdName && leadAdName) {
          matchAd = leadAdName === filterAdName;
          if (!matchAd) {
            matchAd = leadAdName.includes(filterAdName) || filterAdName.includes(leadAdName);
          }
        }

        return matchAd;
      });

      if (campDeepFilter.showRevs) {
        r = r.filter(l => toStatusNum(l.status) === 3);
      }
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(l => { const la = l as any; return l.nome?.toLowerCase().includes(q) || l.whatsapp?.includes(search) || l.cidade?.toLowerCase().includes(q) || safeName((la.utm_campaign || '')).toLowerCase().includes(q); });
    }
    if (selectedTagIds.size > 0) {
      r = r.filter(l => {
        const lt = leadTagsMap.get(l.id);
        return lt ? lt.some(t => selectedTagIds.has(t.id)) : false;
      });
    }
    r = [...r].sort((a, b) => {
      if (sortByScore) {
        const sa = a.score ?? -1;
        const sb = b.score ?? -1;
        const scoreDiff = sortByScore === 'desc' ? sb - sa : sa - sb;
        if (scoreDiff !== 0) return scoreDiff;
      }

      const da = parseLeadDate(getLeadMoveDateForView(a)).getTime();
      const db = parseLeadDate(getLeadMoveDateForView(b)).getTime();
      const dateDiff = sortByScore || sortByDate === 'desc' ? db - da : da - db;
      if (dateDiff !== 0) return dateDiff;

      return String(b.id).localeCompare(String(a.id), 'pt-BR', { numeric: true });
    });
    return r;
  }, [allLeads, periodFilter, statusFilter, search, selectedCampaigns, campDeepFilter, customFrom, customTo, sortByScore, sortByDate, selectedTagIds, leadTagsMap, activeMoveStatus, getLeadMoveDateForView]);

  useEffect(() => {
    setCurrentPage(1);
    setSelectedIds(new Set());
    setAllSystemSelected(false);
  }, [periodFilter, statusFilter, search, selectedCampaigns, campDeepFilter, selectedTagIds, sortByScore, sortByDate]);

  // Lock body scroll when any filter dropdown is open
  useEffect(() => {
    document.body.style.overflow = (showTagFilter || showCampaignModal) ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [showTagFilter, showCampaignModal]);

  // Lead limit banner: count leads created this month
  const leadsNoMes = useMemo(() => {
    const start = new Date();
    start.setDate(1); start.setHours(0, 0, 0, 0);
    return allLeads.filter(l => parseLeadDate(getLeadEntryValue(l)) >= start).length;
  }, [allLeads]);
  const PLANO_LABELS_LEAD: Record<string, string> = { gratuito: 'Gratuito', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };
  const limiteLeads = features.limiteLeads;
  const showLeadLimitBanner = !planLoading && limiteLeads < Infinity && leadsNoMes >= limiteLeads * 0.8;

  const totalPages = Math.ceil(filtered.length / leadsPerPage);
  const paginatedLeads = useMemo(() => filtered.slice((currentPage - 1) * leadsPerPage, currentPage * leadsPerPage), [filtered, currentPage]);

  const pageIds = paginatedLeads.map(l => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));

  function handleCheckboxHeader() {
    const n = new Set(selectedIds);
    if (allPageSelected) { pageIds.forEach(id => n.delete(id)); setAllSystemSelected(false); }
    else { pageIds.forEach(id => n.add(id)); }
    setSelectedIds(n);
  }

  const hasActiveFilters = periodFilter !== 'all' || statusFilter !== 'all' || selectedCampaigns.size > 0 || !!search.trim() || !!campDeepFilter || selectedTagIds.size > 0;

  function handleSelectAllFiltered() {
    if (filtered.length <= 1000) {
      setSelectedIds(new Set(filtered.map(l => l.id)));
    }
    setAllSystemSelected(true);
  }

  function handleClearSelection() { setSelectedIds(new Set()); setAllSystemSelected(false); }

  // ── Selected leads derived state ──────────────────────────────────────────
  const selectedLeads = useMemo(() => {
    if (allSystemSelected) return filtered;
    return allLeads.filter(l => selectedIds.has(l.id));
  }, [selectedIds, allSystemSelected, filtered, allLeads]);

  const allSelectedAreEvaluated = useMemo(() => {
    if (selectedLeads.length === 0) return false;
    return selectedLeads.every(l => (l as any).avaliado === true);
  }, [selectedLeads]);

  // ── Bulk operations ───────────────────────────────────────────────────────
  async function handleBulkMoveStatus(newStatus: number) {
    setBulkLoading(true);
    const now = new Date().toISOString();
    const tsField: Record<number, string> = {
      1: 'status_atendimento_at', 2: 'status_reuniao_at', 5: 'status_contrato_at',
      3: 'status_aprovado_at', 6: 'status_sem_retorno_at',
      [statusConfig.convertido_status]: 'status_aprovado_at',
    };
    const updates: any = { status: newStatus, ultimo_status_change: now };
    if (tsField[newStatus]) updates[tsField[newStatus]] = now;

    try {
      const ids = allSystemSelected ? filtered.map(l => l.id) : Array.from(selectedIds);
      const leadsMovidos = allSystemSelected ? filtered : allLeads.filter(l => ids.includes(l.id));
      const indicacoesSemValor = leadsMovidos.filter(l => precisaCustoIndicacaoParaConversao(l, newStatus, statusConfig.convertido_status));
      let custoIndicacaoLeadId: string | null = null;
      let custoIndicacaoValor: number | null = null;
      if (indicacoesSemValor.length > 1) {
        toast.error(`${indicacoesSemValor.length} indicações estão sem valor. Atualize o valor antes de aprovar em massa.`);
        return;
      }
      if (indicacoesSemValor.length === 1) {
        const value = pedirCustoIndicacao(indicacoesSemValor[0]);
        if (value === null) {
          toast.error('Informe um valor maior que zero para aprovar esta indicação.');
          return;
        }
        custoIndicacaoLeadId = indicacoesSemValor[0].id;
        custoIndicacaoValor = value;
      }
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await supabase.from('leads').update(updates).in('id', ids.slice(i, i + CHUNK));
      }
      if (custoIndicacaoLeadId && custoIndicacaoValor !== null) {
        await supabase.from('leads').update({ custo_indicacao: custoIndicacaoValor }).eq('id', custoIndicacaoLeadId);
      }
      const idSet = new Set(ids);
      if (newStatus === statusConfig.convertido_status && orgId) {
        const leadsParaCapi = (allSystemSelected ? filtered : allLeads.filter(l => idSet.has(l.id)))
          .filter(l => !(l as any).capi_conversao_enviado);
        leadsParaCapi.forEach(l => dispararCapiConversao(l.id, orgId));
      }
      setAllLeads(prev => prev.map(l => idSet.has(l.id) ? { ...l, ...updates, ...(l.id === custoIndicacaoLeadId ? { custo_indicacao: custoIndicacaoValor } : {}) } : l));
      const label = statusConfig.statuses.find(s => s.id === newStatus)?.label ?? STATUS_LABELS[newStatus];
      toast.success(`${ids.length} lead${ids.length !== 1 ? 's' : ''} movido${ids.length !== 1 ? 's' : ''} para "${label}"`);
      setSelectedIds(new Set());
      setAllSystemSelected(false);
      setShowMoveStatusConfirm(false);
      setPendingMoveStatus(null);
    } catch {
      toast.error('Erro ao atualizar leads');
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleToggleAvaliado() {
    const newValue = !allSelectedAreEvaluated;
    const ids = allSystemSelected ? filtered.map(l => l.id) : Array.from(selectedIds);
    const count = ids.length;
    setBulkLoading(true);
    try {
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await supabase.from('leads').update({ avaliado: newValue }).in('id', ids.slice(i, i + CHUNK));
      }
      const idSet = new Set(ids);
      setAllLeads(prev => prev.map(l => idSet.has(l.id) ? { ...l, avaliado: newValue } : l));
      toast.success(`${count} lead${count !== 1 ? 's' : ''} ${newValue ? 'marcado' : 'desmarcado'}${count !== 1 ? 's' : ''} como ${newValue ? 'avaliado' : 'não avaliado'}!`);
      setSelectedIds(new Set());
      setAllSystemSelected(false);
    } catch {
      toast.error('Erro ao atualizar leads');
    } finally {
      setBulkLoading(false);
      setShowAvaliarConf(false);
    }
  }

  function closeTagManager() { setShowTagManagerModal(false); setMgrEditId(null); setMgrDeleteId(null); }
  async function handleMgrCreate() {
    if (!mgrNewNome.trim()) return;
    setMgrCreating(true);
    await createOrgTag(mgrNewNome.trim(), mgrNewCor);
    setMgrNewNome(''); setMgrNewCor(CORES_TAGS[0]);
    setMgrCreating(false);
  }
  async function handleMgrSaveEdit() {
    if (!mgrEditId) return;
    await updateOrgTag(mgrEditId, { nome: mgrEditNome.trim(), cor: mgrEditCor });
    setMgrEditId(null);
  }
  async function handleMgrDelete() {
    if (!mgrDeleteId) return;
    await deleteOrgTag(mgrDeleteId);
    setMgrDeleteId(null);
  }

  async function handleCreateTagFilter() {
    if (!newTagFilterName.trim()) return;
    setCreatingTagFilter(true);
    const tag = await createOrgTag(newTagFilterName.trim(), newTagFilterCor);
    if (tag) {
      setSelectedTagIds(prev => new Set([...prev, tag.id]));
      setNewTagFilterName('');
      setNewTagFilterCor('#8b5cf6');
    }
    setCreatingTagFilter(false);
  }

  async function handleBulkTag(ops: BulkTagOps) {
    if (ops.add.length === 0 && ops.remove.length === 0) { setShowBulkTagModal(false); return; }
    setBulkLoading(true);
    try {
      for (const { tagId, leadIds } of ops.add) {
        if (!leadIds.length) continue;
        const rows = leadIds.map(leadId => ({ lead_id: leadId, tag_id: tagId }));
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await (supabase as any).from('lead_tags').upsert(rows.slice(i, i + CHUNK), { onConflict: 'lead_id,tag_id' });
        }
      }
      for (const { tagId, leadIds } of ops.remove) {
        if (!leadIds.length) continue;
        await (supabase as any).from('lead_tags').delete().in('lead_id', leadIds).eq('tag_id', tagId);
      }
      setLeadTagsMap(prev => {
        const next = new Map(prev);
        for (const { tagId, leadIds } of ops.add) {
          const tagObj = orgTags.find(t => t.id === tagId);
          if (!tagObj) continue;
          leadIds.forEach(leadId => {
            const existing = next.get(leadId) || [];
            if (!existing.find(t => t.id === tagId)) next.set(leadId, [...existing, tagObj]);
          });
        }
        for (const { tagId, leadIds } of ops.remove) {
          leadIds.forEach(leadId => {
            const existing = next.get(leadId);
            if (!existing) return;
            const updated = existing.filter(t => t.id !== tagId);
            if (updated.length === 0) next.delete(leadId); else next.set(leadId, updated);
          });
        }
        return next;
      });
      const a = ops.add.length, r = ops.remove.length;
      const parts: string[] = [];
      if (a) parts.push(`${a} tag${a !== 1 ? 's' : ''} adicionada${a !== 1 ? 's' : ''}`);
      if (r) parts.push(`${r} tag${r !== 1 ? 's' : ''} removida${r !== 1 ? 's' : ''}`);
      toast.success(parts.join(' e ') + '!');
      setSelectedIds(new Set());
      setAllSystemSelected(false);
    } catch {
      toast.error('Erro ao atualizar tags');
    } finally {
      setBulkLoading(false);
      setShowBulkTagModal(false);
    }
  }

  const handleDeleteSelected = async () => {
    setDeleting(true);
    const ids = allSystemSelected ? filtered.map(l => l.id) : Array.from(selectedIds);
    await (supabase as any).from('lead_tags').delete().in('lead_id', ids);
    const { error } = await supabase.from('leads').delete().in('id', ids);
    setDeleting(false);
    if (error) { toast.error('Erro ao excluir'); return; }
    const idSet = new Set(ids);
    setAllLeads(prev => prev.filter(l => !idSet.has(l.id)));
    setSelectedIds(new Set());
    setAllSystemSelected(false);
    setShowDeleteConf(false);
    toast.success(`${ids.length} lead${ids.length !== 1 ? 's' : ''} excluído${ids.length !== 1 ? 's' : ''}!`);
  };

  const handleAddLead = async () => {
    if (addingRef.current) return;
    if (!newLead.nome.trim()) { toast.error('Nome obrigatório'); return; }
    if (!newLead.whatsapp.trim()) { toast.error('WhatsApp obrigatório'); return; }
    if (!newLead.cidade.trim()) { toast.error('Cidade obrigatória'); return; }
    if (!newLead.origem || (newLead.origem === 'Outro' && !newLead.origemCustom.trim())) { toast.error('Origem obrigatória'); return; }
    if (newLead.origem === 'Indicação' && custoIndicacaoInput === '') {
      toast.error('Informe o custo desta indicação (pode ser R$ 0)'); return;
    }
    addingRef.current = true;

    const cidadeNorm = normalizeCity(newLead.cidade);
    const phoneClean = newLead.whatsapp.replace(/\D/g, '');
    const finalUtmSource = newLead.origem === 'Outro'
      ? (newLead.origemCustom || 'Outro')
      : newLead.origem === 'Instagram Orgânico'
      ? 'instagram_organico'
      : (newLead.origem || null);
    let custoIndicacaoFinal = newLead.origem === 'Indicação' && custoIndicacaoInput !== ''
      ? parseFloat(custoIndicacaoInput) || 0
      : null;
    if (precisaCustoIndicacaoParaConversao({ nome: newLead.nome, utm_source: finalUtmSource, custo_indicacao: custoIndicacaoFinal }, Number(newLead.status), statusConfig.convertido_status)) {
      const value = pedirCustoIndicacao({ nome: newLead.nome, utm_source: finalUtmSource, custo_indicacao: custoIndicacaoFinal });
      if (value === null) {
        toast.error('Informe um valor maior que zero para aprovar esta indicação.');
        addingRef.current = false;
        return;
      }
      custoIndicacaoFinal = value;
    }

    const { data, error } = await supabase.from('leads').insert({
      nome: newLead.nome.trim(),
      whatsapp: phoneClean,
      cidade: cidadeNorm,
      status: newLead.status,
      score: null,
      faixa: null,
      observacoes: newLead.observacoes || null,
      utm_source: finalUtmSource,
      utm_campaign: null, utm_medium: null, utm_content: null, utm_term: null, utm_id: null,
      org_id: orgId,
      created_at: new Date().toISOString(),
      ...(newLead.origem === 'Indicação' && custoIndicacaoFinal !== null
        ? { custo_indicacao: custoIndicacaoFinal }
        : {}),
    } as any).select('*').single();

    if (error) { toast.error(`Erro: ${error.message}`); addingRef.current = false; return; }
    if (data) {
      setAllLeads(prev => [data as unknown as Lead, ...prev]);
      if (orgId) await aplicarTagOrigem(supabase as any, (data as any).id, orgId, finalUtmSource, null);
    }
    setNewLead({ nome:'', whatsapp:'', cidade:'', origem:'', origemCustom:'', status: statusConfig.entrada_status, observacoes:'' });
    setCustoIndicacaoInput('');
    setIsAddOpen(false);
    toast.success('Lead adicionado!');
    addingRef.current = false;
  };

  const handleEditLead = async () => {
    if (!editingLead) return;
    const editUtmSource = (editingLead as any).utm_source || null;
    const cidadeNorm = normalizeCity(editingLead.cidade || '');
    const originalLead = allLeads.find(l => l.id === editingLead.id);
    const newStatus = editingLead.status ?? 0;
    let custoIndicacaoFinal = (editingLead as any).custo_indicacao ?? null;
    if (precisaCustoIndicacaoParaConversao({ ...editingLead, utm_source: editUtmSource, custo_indicacao: custoIndicacaoFinal }, Number(newStatus), statusConfig.convertido_status)) {
      const value = pedirCustoIndicacao({ ...editingLead, utm_source: editUtmSource, custo_indicacao: custoIndicacaoFinal });
      if (value === null) {
        toast.error('Informe um valor maior que zero para aprovar esta indicação.');
        return;
      }
      custoIndicacaoFinal = value;
    }
    const updates: any = { nome: editingLead.nome, whatsapp: editingLead.whatsapp, cidade: cidadeNorm, status: newStatus, utm_source: editUtmSource, custo_indicacao: custoIndicacaoFinal };
    if (originalLead && Number(originalLead.status) !== Number(newStatus)) {
      const now = new Date().toISOString();
      const tsField: Record<number, string> = { 0:'status_atendimento_at', 1:'status_atendimento_at', 2:'status_reuniao_at', 5:'status_contrato_at', 3:'status_aprovado_at', 6:'status_sem_retorno_at' };
      updates.ultimo_status_change = now;
      if (tsField[Number(newStatus)]) updates[tsField[Number(newStatus)]] = now;
    }
    const { error } = await supabase.from('leads').update(updates).eq('id', editingLead.id);
    if (error) { toast.error(`Erro: ${error.message}`); return; }
    setAllLeads(prev => prev.map(l => l.id === editingLead.id ? { ...l, ...updates } : l));
    updateLead(editingLead.id, updates);
    if (orgId) await aplicarTagOrigem(supabase as any, editingLead.id as any, orgId, editUtmSource, (editingLead as any).utm_campaign ?? null);
    if (Number(newStatus) === statusConfig.convertido_status && !(editingLead as any).capi_conversao_enviado && orgId) {
      dispararCapiConversao(editingLead.id, orgId);
    }
    setIsEditOpen(false);
    setEditingLead(null);
    toast.success('Lead atualizado!');
  };

  const exportCSV = () => {
    let toExport: Lead[];
    if (selectedIds.size > 0 && !allSystemSelected) {
      toExport = allLeads.filter(l => selectedIds.has(l.id));
    } else {
      toExport = filtered;
    }
    if (!toExport.length) { toast.error('Nenhum lead para exportar'); return; }
    const allKeys = Array.from(new Set(toExport.flatMap(l => Object.keys(l as object))));
    const rows = toExport.map(l => allKeys.map(k => { const v = (l as any)[k]; if (v === null || v === undefined) return ''; const s = String(v).replace(/"/g, '""'); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s; }).join(',')).join('\n');
    const blob = new Blob([allKeys.join(',') + '\n' + rows], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `leads_${new Date().toISOString().split('T')[0]}.csv`; a.click();
    if (allSystemSelected) toast.success(`${toExport.length} leads exportados (todos os filtrados)`);
    else if (selectedIds.size > 0) toast.success(`${toExport.length} leads selecionados exportados`);
    else toast.success(`${toExport.length} leads exportados`);
  };

  function handlePeriodChange(v: string) {
    if (v === 'custom') { setShowCustom(true); }
    else { setPeriodFilter(v); setShowCustom(false); setCustomFrom(''); setCustomTo(''); }
  }

  // ── Style tokens ──────────────────────────────────────────────────────────
  // Dark tokens — sistema coerente
  const bg     = dark ? '#0f0f10' : '#f4f4f5';
  const cardBg = dark ? '#1b1b1d' : '#ffffff';
  const border = dark ? 'rgba(255,255,255,0.07)' : '#e5e7eb';
  const cardShadow = dark ? '0 1px 3px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)' : '0 1px 3px rgba(0,0,0,0.06)';
  const txtHi  = dark ? '#f0f0f0' : '#111827';
  const txtMid = dark ? '#a0a0a8' : '#6b7280';
  // No dark: sem bordas entre linhas de tabela — apenas zebrado diferencia linhas
  const divider = dark ? '' : 'border-gray-100';
  const bold   = dark ? 'text-[#f0f0f0]' : 'text-gray-900';
  const muted  = dark ? 'text-[#a0a0a8]' : 'text-gray-600';
  const theadBg = dark ? 'bg-[#141416]' : 'bg-gray-50';
  const hov    = dark ? 'hover:bg-[rgba(255,255,255,0.03)]' : 'hover:bg-blue-50/50';
  const card   = dark ? 'bg-[#1b1b1d] border-[rgba(255,255,255,0.07)]' : 'bg-white border-gray-100';
  const inputStyle: React.CSSProperties = { width:'100%', padding:'9px 12px', borderRadius:'9px', border:`1px solid ${dark ? 'rgba(255,255,255,0.1)' : '#e5e7eb'}`, background:dark?'#0f0f10':'#f9fafb', color:dark?'#f0f0f0':'#111827', fontSize:'13.5px', outline:'none', fontFamily:'inherit' };
  const btnGhost: React.CSSProperties = { display:'flex', alignItems:'center', gap:'5px', padding:'7px 10px', borderRadius:'9px', border:`1px solid ${dark ? 'rgba(255,255,255,0.1)' : '#e5e7eb'}`, background:dark?'#1b1b1d':'#ffffff', color:dark?'#a0a0a8':'#374151', fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit' };

  const activeBulkCount = allSystemSelected ? filtered.length : selectedIds.size;
  const showSelectionBar = selectedIds.size > 0 || allSystemSelected;
  const pendingMoveStatusLabel = pendingMoveStatus != null
    ? (statusConfig.statuses.find(s => s.id === pendingMoveStatus)?.label ?? STATUS_LABELS[pendingMoveStatus] ?? '')
    : '';

  // Add Lead dialog content (shared between mobile/desktop)
  const addLeadForm = (
    <div style={{ display:'flex', flexDirection:'column', gap:'10px', marginTop:'8px' }}>
      <input placeholder="Nome completo *" required value={newLead.nome} onChange={e => setNewLead(n => ({ ...n, nome: e.target.value }))} style={inputStyle}/>
      <PhoneInput value={newLead.whatsapp} onChange={v => setNewLead(n => ({ ...n, whatsapp: v }))} style={inputStyle}/>
      <input placeholder="Cidade *" required value={newLead.cidade} onChange={e => setNewLead(n => ({ ...n, cidade: e.target.value }))} style={inputStyle}/>
      <div>
        <label style={{ fontSize:'11px', color:txtMid, display:'block', marginBottom:'4px', fontWeight:600, textTransform:'uppercase' }}>Origem</label>
        <select value={newLead.origem} onChange={e => setNewLead(n => ({ ...n, origem: e.target.value }))} style={inputStyle}>
          <option value="">Selecionar origem...</option>
          {ORIGENS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        {newLead.origem === 'Outro' && (
          <input placeholder="Especifique a origem..." value={newLead.origemCustom} onChange={e => setNewLead(n => ({ ...n, origemCustom: e.target.value }))} style={{ ...inputStyle, marginTop:'8px' }}/>
        )}
        {newLead.origem === 'Indicação' && (
          <div style={{ marginTop:'8px' }}>
            <label style={{ fontSize:'11px', color:txtMid, display:'block', marginBottom:'4px', fontWeight:600, textTransform:'uppercase' }}>Custo da indicação (R$) *</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Ex: 100"
              value={custoIndicacaoInput}
              onChange={e => setCustoIndicacaoInput(e.target.value)}
              style={inputStyle}
            />
            <p style={{ fontSize:'11px', color:txtMid, margin:'4px 0 0' }}>Só será contabilizado no gasto quando o lead for convertido.</p>
          </div>
        )}
      </div>
      <div>
        <label style={{ fontSize:'11px', color:txtMid, display:'block', marginBottom:'4px', fontWeight:600, textTransform:'uppercase' }}>Status inicial</label>
        <FormStatusSelect value={newLead.status} onChange={v => setNewLead(n => ({ ...n, status: v }))} dark={dark} statusItems={statusConfig.statuses}/>
      </div>
      <div>
        <label style={{ fontSize:'11px', color:txtMid, display:'block', marginBottom:'4px', fontWeight:600, textTransform:'uppercase' }}>Observações</label>
        <textarea placeholder="Notas sobre o lead..." value={newLead.observacoes} onChange={e => setNewLead(n => ({ ...n, observacoes: e.target.value }))} style={{ ...inputStyle, height:'80px', resize:'none' }}/>
      </div>
      <button onClick={handleAddLead} style={{ padding:'10px', borderRadius:'9px', border:'none', background:'#0044fd', color:'#fff', fontSize:'13.5px', fontWeight:600, cursor:'pointer', marginTop:'8px' }}>Adicionar Lead</button>
    </div>
  );

  return (
    <AppLayout leadCount={totalCount}>
      <div style={{ padding: isMobile ? '12px' : '28px', background: bg, minHeight: '100vh' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'14px', gap:'8px', animation: 'headerIn 0.3s ease-out forwards' }}>
          <h1 style={{ fontSize: isMobile ? '22px' : '26px', fontWeight: 800, fontFamily: 'Inter, sans-serif', color: dark ? '#f0f0f0' : '#111827', margin: 0, letterSpacing: '-0.035em', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            Leads
            <span style={{ fontSize: isMobile ? '14px' : '16px', fontWeight: 400, color: txtMid, letterSpacing: '-0.01em' }}>({hasActiveFilters ? filtered.length : totalCount})</span>
          </h1>
          <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
            {isMobile ? (
              <>
                <button onClick={() => setShowFilters(v => !v)} style={{ ...btnGhost, gap:'4px' }}><Filter style={{ width:'14px', height:'14px' }}/> Filtros</button>
                <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                  <DialogTrigger asChild><button style={{ display:'flex', alignItems:'center', gap:'4px', padding:'7px 12px', borderRadius:'9px', border:'none', background:'#0044fd', color:'#fff', fontSize:'13px', fontWeight:500, cursor:'pointer' }}><Plus style={{ width:'14px', height:'14px' }}/> Add</button></DialogTrigger>
                  <DialogContent style={{ background:dark?'#111113':'#fff', border:`1px solid ${border}`, borderRadius:'16px' }}>
                    <DialogHeader><DialogTitle style={{ color:dark?'#fff':'#111827' }}>Adicionar Lead</DialogTitle></DialogHeader>
                    {addLeadForm}
                  </DialogContent>
                </Dialog>
              </>
            ) : (
              <>
                <div style={{ position:'relative' }}>
                  <Search style={{ position:'absolute', left:'10px', top:'50%', transform:'translateY(-50%)', width:'14px', height:'14px', color:dark?'#71717a':'#9ca3af' }}/>
                  <input placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)} style={{ paddingLeft:'32px', paddingRight:'12px', paddingTop:'7px', paddingBottom:'7px', borderRadius:'9px', border:`1px solid ${border}`, background:dark?'#111113':'#fff', color:dark?'#d4d4d8':'#374151', fontSize:'13px', outline:'none', width:'180px', fontFamily:'inherit' }}/>
                </div>
                <FilterDropdown value={statusFilter} options={statusOptions} onChange={setStatusFilter} dark={dark}/>
                <FilterDropdown value={periodFilter} options={PERIOD_OPTIONS} onChange={handlePeriodChange} dark={dark}/>

                {/* Campaign filter button */}
                <div style={{ position:'relative' }}>
                  <button
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setCampDropPos({ top: r.bottom + 6, left: r.left });
                      setPendingCampaigns(new Set(selectedCampaigns));
                      setShowCampaignModal(v => !v);
                    }}
                    style={{ display:'flex', alignItems:'center', gap:'5px', padding:'7px 10px', borderRadius:'9px', border:`1px solid ${selectedCampaigns.size > 0 ? '#0044fd' : border}`, background:selectedCampaigns.size > 0 ? (dark ? 'rgba(0,68,253,0.12)' : '#eff6ff') : (dark ? '#111113' : '#ffffff'), color:selectedCampaigns.size > 0 ? (dark ? '#7ab0ff' : '#2563eb') : (dark ? '#d4d4d8' : '#374151'), fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}
                  >
                    <Megaphone style={{ width:'12px', height:'12px' }}/>
                    Campanhas {selectedCampaigns.size > 0 && <span style={{ background:'#0044fd', color:'#fff', borderRadius:'99px', padding:'0px 5px', fontSize:'11px', fontWeight:700 }}>{selectedCampaigns.size}</span>}
                  </button>
                  {showCampaignModal && createPortal(
                    <CampFilterDropdown
                      dark={dark}
                      campaigns={campaignOptions}
                      pendingSelected={pendingCampaigns}
                      onToggle={name => { const n = new Set(pendingCampaigns); if (n.has(name)) n.delete(name); else n.add(name); setPendingCampaigns(n); }}
                      onApply={() => { setSelectedCampaigns(new Set(pendingCampaigns)); setShowCampaignModal(false); }}
                      onClear={() => { setPendingCampaigns(new Set()); }}
                      onClose={() => setShowCampaignModal(false)}
                      pos={campDropPos}
                    />,
                    document.body
                  )}
                </div>

                {/* Tags dropdown: pills de filtro + rodapé Gerenciar */}
                <div style={{ position:'relative' }}>
                  <button
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setTagDropPos({ top: r.bottom + 6, left: r.left });
                      setShowTagFilter(v => !v);
                    }}
                    style={{ display:'flex', alignItems:'center', gap:'5px', padding:'7px 10px', borderRadius:'9px', border:`1px solid ${selectedTagIds.size > 0 ? '#8b5cf6' : border}`, background:selectedTagIds.size > 0 ? (dark ? 'rgba(139,92,246,0.12)' : '#f5f3ff') : (dark ? '#111113' : '#ffffff'), color:selectedTagIds.size > 0 ? (dark ? '#c4b5fd' : '#7c3aed') : (dark ? '#d4d4d8' : '#374151'), fontSize:'12.5px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' }}
                  >
                    <Tag style={{ width:'12px', height:'12px' }}/> Tags {selectedTagIds.size > 0 && <span style={{ background:'#8b5cf6', color:'#fff', borderRadius:'99px', padding:'0px 5px', fontSize:'11px', fontWeight:700 }}>{selectedTagIds.size}</span>}
                  </button>
                  {showTagFilter && createPortal((() => {
                    const tagMenuWidth = 190;
                    let tagLeft = tagDropPos.left;
                    if (tagLeft + tagMenuWidth > window.innerWidth - 8) tagLeft = window.innerWidth - tagMenuWidth - 8;
                    if (tagLeft < 8) tagLeft = 8;
                    return (
                      <>
                        <div onClick={() => setShowTagFilter(false)} style={{ position:'fixed', inset:0, zIndex:9998 }} />
                        <div style={{ position:'fixed', top:tagDropPos.top, left:tagLeft, zIndex:9999, background:dark?'#111113':'#fff', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, borderRadius:'12px', padding:'8px', minWidth:`${tagMenuWidth}px`, boxShadow:dark?'0 8px 24px rgba(0,0,0,0.4)':'0 8px 24px rgba(0,0,0,0.12)', display:'flex', flexDirection:'column', gap:'1px' }}>
                          {orgTags.length === 0 ? (
                            <p style={{ fontSize:'12px', color:dark?'#52525b':'#9ca3af', margin:'4px 8px', padding:'8px 0' }}>Nenhuma tag criada.</p>
                          ) : (
                            orgTags.map(tag => {
                              const active = selectedTagIds.has(tag.id);
                              const hex = tag.cor || '#8b5cf6';
                              return (
                                <button key={tag.id} onClick={() => { const n = new Set(selectedTagIds); active ? n.delete(tag.id) : n.add(tag.id); setSelectedTagIds(n); }}
                                  style={{ width:'100%', display:'flex', alignItems:'center', gap:'7px', padding:'6px 8px', borderRadius:'8px', border:'none', background:active?(dark?'rgba(139,92,246,0.1)':'#f5f3ff'):'transparent', cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}>
                                  <span style={{ width:'8px', height:'8px', borderRadius:'50%', background:hex, flexShrink:0 }} />
                                  <span style={{ flex:1, fontSize:'12.5px', color:active?(dark?'#c4b5fd':'#7c3aed'):(dark?'#d4d4d8':'#374151'), fontWeight:active?600:400 }}>{tag.nome}</span>
                                  {active && <Check style={{ width:'11px', height:'11px', color:'#8b5cf6', flexShrink:0 }} />}
                                </button>
                              );
                            })
                          )}
                          {selectedTagIds.size > 0 && (
                            <button onClick={() => setSelectedTagIds(new Set())} style={{ width:'100%', padding:'5px 8px', borderRadius:'7px', border:'none', background:'transparent', color:dark?'#f87171':'#ef4444', fontSize:'11.5px', cursor:'pointer', fontFamily:'inherit', textAlign:'left', marginTop:'2px' }}>
                              Limpar filtro
                            </button>
                          )}
                          <div style={{ borderTop:`1px solid ${dark?'#27272a':'#e5e7eb'}`, marginTop:'4px', paddingTop:'6px' }}>
                            <button onClick={() => { setShowTagFilter(false); setShowTagManagerModal(true); }}
                              style={{ width:'100%', display:'flex', alignItems:'center', gap:'6px', padding:'6px 8px', borderRadius:'8px', border:'none', background:'transparent', color:dark?'#71717a':'#6b7280', fontSize:'12px', cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}>
                              <span style={{ fontSize:'13px' }}>⚙</span> Gerenciar tags
                            </button>
                          </div>
                        </div>
                      </>
                    );
                  })(), document.body)}
                </div>

                {hasActiveFilters && (
                  <button onClick={() => { setStatusFilter('all'); setPeriodFilter('all'); setSelectedCampaigns(new Set()); setCampDeepFilter(null); setSearch(''); setShowCustom(false); setCustomFrom(''); setCustomTo(''); setSelectedTagIds(new Set()); if (orgId) { try { localStorage.setItem(`leads_filters_${orgId}`, JSON.stringify({ periodFilter: 'all', statusFilter: 'all', selectedCampaigns: [], sortByDate })); } catch {} } }} style={{ ...btnGhost, color: dark ? '#f87171' : '#ef4444', borderColor: dark ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.3)', background: dark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.05)' }}>
                    <X style={{ width:'12px', height:'12px' }}/> Limpar filtros
                  </button>
                )}
                <button onClick={fetchLeads} style={btnGhost}><RefreshCw style={{ width:'13px', height:'13px' }}/></button>
                <button onClick={exportCSV} style={btnGhost}><Download style={{ width:'13px', height:'13px' }}/></button>
                <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                  <DialogTrigger asChild><button style={{ display:'flex', alignItems:'center', gap:'5px', padding:'7px 12px', borderRadius:'9px', border:'none', background:'#0044fd', color:'#fff', fontSize:'13px', fontWeight:500, cursor:'pointer' }}><Plus style={{ width:'14px', height:'14px' }}/> Adicionar</button></DialogTrigger>
                  <DialogContent style={{ background:dark?'#111113':'#fff', border:`1px solid ${border}`, borderRadius:'16px' }}>
                    <DialogHeader><DialogTitle style={{ color:dark?'#fff':'#111827' }}>Adicionar Lead</DialogTitle></DialogHeader>
                    {addLeadForm}
                  </DialogContent>
                </Dialog>
              </>
            )}
          </div>
        </div>

        {/* Mobile search + filters */}
        {isMobile && (
          <div style={{ marginBottom:'12px', display:'flex', flexDirection:'column', gap:'8px' }}>
            <div style={{ position:'relative' }}>
              <Search style={{ position:'absolute', left:'10px', top:'50%', transform:'translateY(-50%)', width:'14px', height:'14px', color:dark?'#71717a':'#9ca3af' }}/>
              <input placeholder="Buscar leads..." value={search} onChange={e => setSearch(e.target.value)} style={{ width:'100%', paddingLeft:'32px', paddingRight:'12px', paddingTop:'10px', paddingBottom:'10px', borderRadius:'10px', border:`1px solid ${border}`, background:cardBg, color:txtHi, fontSize:'14px', outline:'none', fontFamily:'inherit' }}/>
            </div>
            {showFilters && (
              <div style={{ display:'flex', gap:'6px', flexWrap:'wrap', padding:'10px', background:cardBg, borderRadius:'10px', border:`1px solid ${border}` }}>
                <FilterDropdown value={statusFilter} options={statusOptions} onChange={setStatusFilter} dark={dark}/>
                <FilterDropdown value={periodFilter} options={PERIOD_OPTIONS} onChange={handlePeriodChange} dark={dark}/>
                <div style={{ position:'relative' }}>
                  <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCampDropPos({ top: r.bottom + 6, left: r.left }); setPendingCampaigns(new Set(selectedCampaigns)); setShowCampaignModal(v => !v); }} style={{ ...btnGhost, border:`1px solid ${selectedCampaigns.size > 0 ? '#0044fd' : border}`, color:selectedCampaigns.size > 0 ? '#0044fd' : (dark ? '#a1a1aa' : '#374151') }}>
                    <Megaphone style={{ width:'13px', height:'13px' }}/> Campanhas {selectedCampaigns.size > 0 && `(${selectedCampaigns.size})`}
                  </button>
                  {showCampaignModal && (
                    <CampFilterDropdown
                      dark={dark}
                      campaigns={campaignOptions}
                      pendingSelected={pendingCampaigns}
                      onToggle={name => { const n = new Set(pendingCampaigns); if (n.has(name)) n.delete(name); else n.add(name); setPendingCampaigns(n); }}
                      onApply={() => { setSelectedCampaigns(new Set(pendingCampaigns)); setShowCampaignModal(false); }}
                      onClear={() => { setPendingCampaigns(new Set()); }}
                      onClose={() => setShowCampaignModal(false)}
                      pos={campDropPos}
                    />
                  )}
                </div>
                {hasActiveFilters && (
                  <button onClick={() => { setStatusFilter('all'); setPeriodFilter('all'); setSelectedCampaigns(new Set()); setCampDeepFilter(null); setSearch(''); setShowCustom(false); setCustomFrom(''); setCustomTo(''); if (orgId) { try { localStorage.setItem(`leads_filters_${orgId}`, JSON.stringify({ periodFilter: 'all', statusFilter: 'all', selectedCampaigns: [], sortByDate })); } catch {} } }} style={{ ...btnGhost, color: dark ? '#f87171' : '#ef4444', borderColor: dark ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.3)', background: dark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.05)' }}>
                    <X style={{ width:'12px', height:'12px' }}/> Limpar filtros
                  </button>
                )}
                <button onClick={fetchLeads} style={btnGhost}><RefreshCw style={{ width:'13px', height:'13px' }}/></button>
                <button onClick={exportCSV} style={btnGhost}><Download style={{ width:'13px', height:'13px' }}/></button>
              </div>
            )}
          </div>
        )}

        {/* Campaign filter chip */}
        {selectedCampaigns.size > 0 && (
          <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 12px', background:dark?'rgba(0,68,253,0.1)':'#eff6ff', border:`1px solid ${dark?'rgba(0,68,253,0.25)':'#bfdbfe'}`, borderRadius:'9px', marginBottom:'10px', fontSize:'12.5px' }}>
            <Megaphone style={{ width:'13px', height:'13px', color:dark?'#6b9fff':'#0044fd', flexShrink:0 }}/>
            <span style={{ color:dark?'#7ab0ff':'#0044fd', fontWeight:500 }}>Campanhas:</span>
            <span style={{ color:txtHi, fontWeight:600, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {Array.from(selectedCampaigns).slice(0, 3).join(', ')}{selectedCampaigns.size > 3 ? ` +${selectedCampaigns.size - 3}` : ''}
            </span>
            <button onClick={() => setSelectedCampaigns(new Set())} style={{ background:'none', border:'none', cursor:'pointer', color:dark?'#6b7280':'#9ca3af', fontSize:'14px', padding:'0 2px', lineHeight:1 }}>✕</button>
          </div>
        )}
        {/* Deep campaign filter chip (from Campanhas page) */}
        {campDeepFilter && (
          <div style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 12px', background:dark?'rgba(0,68,253,0.1)':'#eff6ff', border:`1px solid ${dark?'rgba(0,68,253,0.25)':'#bfdbfe'}`, borderRadius:'9px', marginBottom:'10px', fontSize:'12.5px' }}>
            <Tag style={{ width:'13px', height:'13px', color:dark?'#6b9fff':'#0044fd', flexShrink:0 }}/>
            <span style={{ color:dark?'#7ab0ff':'#0044fd', fontWeight:500 }}>
              {campDeepFilter.showRevs ? t.convertidoPlural : (campDeepFilter.type==='campaign'?'Campanha':campDeepFilter.type==='adset'?'Conjunto':'Anúncio')}:
            </span>
            <span style={{ color:txtHi, fontWeight:600, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {campDeepFilter.type==='campaign'
               ? (campDeepFilter.campaignName || campDeepFilter.campaignId)
               : campDeepFilter.type==='adset'
               ? `${campDeepFilter.campaignName||campDeepFilter.campaignId} → ${campDeepFilter.adSetName||campDeepFilter.adSetId||''}`
               : `${campDeepFilter.campaignName||campDeepFilter.campaignId} → ${campDeepFilter.adSetName||''} → ${campDeepFilter.adName||campDeepFilter.adId||''}`}
            </span>
            <button onClick={() => setCampDeepFilter(null)} style={{ background:'none', border:'none', cursor:'pointer', color:dark?'#6b7280':'#9ca3af', fontSize:'14px', padding:'0 2px', lineHeight:1 }}>✕</button>
          </div>
        )}

        {/* Lead limit banner */}
        {showLeadLimitBanner && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', padding:'10px 16px', background:'rgba(249,115,22,0.1)', border:'1px solid rgba(249,115,22,0.3)', borderRadius:'10px', marginBottom:'12px', flexWrap:'wrap' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px', flex:1, minWidth:0 }}>
              <span style={{ fontSize:'16px', flexShrink:0 }}>⚠️</span>
              <span style={{ fontSize:'13px', color: dark ? '#fdba74' : '#c2410c', lineHeight:1.4 }}>
                {leadsNoMes >= limiteLeads
                  ? `Você atingiu o limite de ${limiteLeads} leads do plano ${PLANO_LABELS_LEAD[plano] || plano}. Faça upgrade para continuar recebendo leads.`
                  : `Você usou ${leadsNoMes} de ${limiteLeads} leads do plano ${PLANO_LABELS_LEAD[plano] || plano} este mês.`}
              </span>
            </div>
            <a href="/assinatura" style={{ fontSize:'12.5px', fontWeight:600, color:'#f97316', background:'rgba(249,115,22,0.12)', border:'1px solid rgba(249,115,22,0.3)', padding:'5px 12px', borderRadius:'7px', textDecoration:'none', flexShrink:0, whiteSpace:'nowrap' }}>
              Ver planos →
            </a>
          </div>
        )}

        {/* Custom date modal */}
        {showCustom && (
          <CustomDateModal dark={dark} customFrom={customFrom} customTo={customTo} setCustomFrom={setCustomFrom} setCustomTo={setCustomTo}
            onApply={() => { if (customFrom && customTo) { setPeriodFilter('custom'); setShowCustom(false); } }}
            onClear={() => { setCustomFrom(''); setCustomTo(''); setPeriodFilter('all'); setShowCustom(false); }}
            onClose={() => setShowCustom(false)}
          />
        )}

        {/* Unified selection + actions bar */}
        {showSelectionBar && (
          <UnifiedSelectionBar
            selectedCount={activeBulkCount}
            allSystemSelected={allSystemSelected}
            hasActiveFilters={hasActiveFilters}
            filteredCount={filtered.length}
            totalCount={allLeads.length}
            allSelectedAreEvaluated={allSelectedAreEvaluated}
            dark={dark}
            isMobile={isMobile}
            statusItems={statusConfig.statuses}
            onSelectAll={handleSelectAllFiltered}
            onClearSelection={handleClearSelection}
            onMoveStatus={status => { setPendingMoveStatus(status); setShowMoveStatusConfirm(true); }}
            onToggleAvaliado={() => setShowAvaliarConf(true)}
            onBulkTag={() => setShowBulkTagModal(true)}
            onDelete={() => setShowDeleteConf(true)}
          />
        )}

        {/* Mobile cards */}
        {isMobile ? (
          <div style={{ display:'flex', flexDirection:'column', gap:'8px', overscrollBehavior:'contain' }}>
            {isLoading ? [...Array(5)].map((_, i) => <div key={i} style={{ height:'88px', borderRadius:'12px', background:dark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.04)', animation:'pulse 1.5s ease-in-out infinite' }}/>)
              : paginatedLeads.length === 0 ? <div style={{ textAlign:'center', padding:'40px 0', color:txtMid, fontSize:'13px' }}>Nenhum lead encontrado</div>
              : paginatedLeads.map(lead => {
                const s = toStatusNum(lead.status); const sel = selectedIds.has(lead.id);
                return (
                  <div key={lead.id}
                    onTouchStart={() => { longPressTriggered.current = false; pressTimer.current = setTimeout(() => { longPressTriggered.current = true; setSelectedIds(prev => { const n = new Set(prev); if (n.has(lead.id)) n.delete(lead.id); else n.add(lead.id); return n; }); if (window.navigator?.vibrate) window.navigator.vibrate(50); }, 450); }}
                    onTouchEnd={() => pressTimer.current && clearTimeout(pressTimer.current)}
                    onTouchMove={() => pressTimer.current && clearTimeout(pressTimer.current)}
                    onContextMenu={e => e.preventDefault()}
                    onClick={() => { if (longPressTriggered.current) { longPressTriggered.current = false; return; } if (selectedIds.size > 0) { const n = new Set(selectedIds); if (n.has(lead.id)) n.delete(lead.id); else n.add(lead.id); setSelectedIds(n); } else { handleViewLead(lead); } }}
                    style={{ background:cardBg, borderRadius:'12px', padding:'12px 14px', border:`1px solid ${sel ? '#0044fd' : border}`, boxShadow:sel ? '0 0 0 2px rgba(0,68,253,0.2)' : '0 1px 4px rgba(0,0,0,0.04)', cursor:'pointer', transition:'all 0.12s', userSelect:'none', WebkitUserSelect:'none', touchAction:'pan-y' }}
                  >
                    <div style={{ display:'flex', alignItems:'flex-start', gap:'10px' }}>
                      {selectedIds.size > 0 && <input type="checkbox" checked={sel} readOnly style={{ width:'15px', height:'15px', accentColor:'#0044fd', flexShrink:0, pointerEvents:'none', marginTop:'2px' }}/>}
                      <div style={{ position:'relative', flexShrink:0 }}>
                        {(()=>{ const ac=getAvatarColor(lead.nome, dark, lead.id); return <div style={{ width:'36px', height:'36px', borderRadius:'10px', background:ac, display:'flex', alignItems:'center', justifyContent:'center', color:getAvatarTextColor(ac), fontSize:'12px', fontWeight:700 }}>{getInitials(lead.nome)}</div>; })()}
                        <div style={{ position:'absolute', top:'-4px', right:'-4px' }}><FaixaDot lead={lead} dark={dark}/></div>
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:'14px', fontWeight:600, color:txtHi, margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{safeName(lead.nome) || 'Lead'}</p>
                        <p style={{ fontSize:'12px', color:txtMid, margin:'2px 0 0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{safeName(lead.cidade) ? normalizeCity(safeName(lead.cidade)) : ''}{safeName(lead.cidade) && lead.whatsapp ? ' · ' : ''}{lead.whatsapp ? formatarWhatsapp(lead.whatsapp) : ''}</p>
                        {(() => {
                          const lt = leadTagsMap.get(lead.id) || [];
                          if (!lt.length) return null;
                          const vis = lt.slice(0, 3); const rest = lt.slice(3);
                          return (
                            <div style={{ display:'flex', gap:'3px', flexWrap:'wrap', marginTop:'3px' }}>
                              {vis.map(tag => (
                                <span key={tag.id} style={{ display:'inline-flex', alignItems:'center', padding:'1px 5px', borderRadius:'99px', fontSize:'10px', fontWeight:600, lineHeight:'1.4', color:tag.cor, background:tag.cor+'20', border:`1px solid ${tag.cor}40`, whiteSpace:'nowrap' }}>{tag.nome}</span>
                              ))}
                              {rest.length > 0 && (
                                <span title={rest.map(t => t.nome).join(', ')} style={{ display:'inline-flex', alignItems:'center', padding:'1px 5px', borderRadius:'99px', fontSize:'10px', fontWeight:600, lineHeight:'1.4', color:'#6b7280', background:'rgba(107,114,128,0.1)', border:'1px solid rgba(107,114,128,0.2)', cursor:'default' }}>+{rest.length}</span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                      <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:'6px', flexShrink:0 }}>
                        {(() => {
                          const pill = getStatusPillStyle(s, dark);
                          return (
                            <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'5px', minWidth:'110px', padding:'4px 8px', borderRadius:'6px', fontSize:'11px', fontWeight:600, whiteSpace:'nowrap', background:pill.bg, color:pill.color, border:`1px solid ${pill.border}` }}>
                              <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:pill.dot, flexShrink:0, display:'inline-block' }}/>{getStatusLabel(s)}
                            </span>
                          );
                        })()}
                        <span style={{ fontSize:'11px', color:txtMid }}>{formatEntrada(getLeadMoveDateForView(lead) ?? lead.created_at)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            {!isLoading && totalPages > 1 && (
              <div style={{ display:'flex', justifyContent:'center', gap:'8px', padding:'8px 0' }}>
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} style={{ padding:'8px 16px', borderRadius:'8px', border:`1px solid ${border}`, background:cardBg, color:txtMid, fontSize:'13px', cursor:currentPage === 1 ? 'default' : 'pointer', opacity:currentPage === 1 ? 0.4 : 1 }}>Anterior</button>
                <span style={{ padding:'8px 12px', fontSize:'13px', color:txtMid }}>{currentPage}/{totalPages}</span>
                <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} style={{ padding:'8px 16px', borderRadius:'8px', border:`1px solid ${border}`, background:cardBg, color:txtMid, fontSize:'13px', cursor:currentPage === totalPages ? 'default' : 'pointer', opacity:currentPage === totalPages ? 0.4 : 1 }}>Próximo</button>
              </div>
            )}
          </div>
        ) : (
          <div className={`rounded-2xl border overflow-hidden ${card}`} style={{ animation: 'tableIn 0.4s ease-out 0.1s both', boxShadow: cardShadow }}>
            <table className="w-full text-sm" style={{ tableLayout:'fixed' }}>
              <colgroup>
                <col style={{ width:'40px' }}/>
                <col style={{ width:'23%' }}/>
                <col style={{ width:'88px' }}/>
                <col style={{ width:'14%' }}/>
                <col style={{ width:'12%' }}/>
                <col style={{ width:'16%' }}/>
                <col style={{ width:'120px' }}/>
                <col style={{ width:'72px' }}/>
              </colgroup>
              <thead>
                <tr className={`${dark ? '' : 'border-b'} ${divider} ${theadBg}`}>
                  <th className="pl-4 pr-2 py-3">
                    <input type="checkbox" checked={allPageSelected} onChange={handleCheckboxHeader} style={{ width:'15px', height:'15px', accentColor:'#0044fd', opacity:0.6, cursor:'pointer' }}/>
                  </th>
                  <th className={`text-left px-3 py-3 text-xs font-semibold uppercase tracking-wider ${muted}`}>Nome</th>
                  <th className={`text-left px-3 py-3`} style={{ whiteSpace:'nowrap' }}>
                    <button onClick={() => { setSortByScore(s => s === 'desc' ? 'asc' : 'desc'); setCurrentPage(1); }} style={{ display:'flex', alignItems:'center', gap:'4px', fontSize:'11px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.07em', color:sortByScore ? (dark ? '#6b9fff' : '#2563eb') : (dark ? '#6b6b75' : '#6b7280'), background:'none', border:'none', cursor:'pointer', padding:0, fontFamily:'inherit' }}>
                      Score {sortByScore ? (sortByScore === 'asc' ? '↑' : '↓') : ''}
                    </button>
                  </th>
                  {(['WhatsApp', 'Cidade'] as string[]).map(h => (
                    <th key={h} className={`text-left px-3 py-3 text-xs font-semibold uppercase tracking-wider ${muted}`}>{h}</th>
                  ))}
                  <th className={`text-center px-3 py-3 text-xs font-semibold uppercase tracking-wider ${muted}`}>Status</th>
                  <th className={`text-left px-3 py-3`} style={{ whiteSpace:'nowrap' }}>
                    <button onClick={() => { setSortByDate(s => s === 'desc' ? 'asc' : 'desc'); setSortByScore(null); setCurrentPage(1); }} style={{ display:'flex', alignItems:'center', gap:'4px', fontSize:'11px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.07em', color:!sortByScore ? (dark ? '#6b9fff' : '#2563eb') : (dark ? '#6b6b75' : '#6b7280'), background:'none', border:'none', cursor:'pointer', padding:0, fontFamily:'inherit' }}>
                      Entrada {sortByDate === 'desc' ? '↓' : '↑'}
                    </button>
                  </th>
                  <th className={`text-left px-3 py-3 text-xs font-semibold uppercase tracking-wider ${muted}`}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? ([...Array(10)].map((_, i) => (
                  <tr key={i}>
                    <td className="pl-4 pr-2 py-3"><div style={{ width:'15px', height:'15px', borderRadius:'3px', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite' }}/></td>
                    <td className="px-3 py-3"><div style={{ display:'flex', alignItems:'center', gap:'7px' }}><div style={{ width:'28px', height:'28px', borderRadius:'50%', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite', flexShrink:0 }}/><div style={{ height:'13px', borderRadius:'4px', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite', width:`${90 + Math.floor((i * 37) % 70)}px` }}/></div></td>
                    {[60, 90, 110, 90, 80].map((w, j) => (<td key={j} className="px-3 py-3"><div style={{ height:'13px', borderRadius:'4px', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite', width:`${w}px` }}/></td>))}
                    <td className="px-3 py-3"><div style={{ height:'13px', borderRadius:'4px', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite', width:'80px' }}/></td>
                    <td className="px-3 py-3"><div style={{ display:'flex', gap:'5px' }}><div style={{ width:'28px', height:'28px', borderRadius:'7px', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite' }}/><div style={{ width:'28px', height:'28px', borderRadius:'7px', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.06)', animation:'pulse 1.5s ease-in-out infinite' }}/></div></td>
                  </tr>
                )))
                  : paginatedLeads.length === 0 ? (<tr><td colSpan={8} className={`px-6 py-12 text-center text-sm ${muted}`}>Nenhum lead encontrado</td></tr>)
                  : paginatedLeads.map((lead, idx) => {
                    const s = toStatusNum(lead.status); const sel = selectedIds.has(lead.id); const obs = (lead as any).observacoes as string | null | undefined; const la = lead as any;
                    return (
                      <tr key={lead.id}
                        className={`${sel ? (dark ? 'bg-blue-950/30' : 'bg-blue-50/60') : ''} ${hov} transition-colors cursor-pointer ${dark ? '' : `border-b ${divider}`}`}
                        style={{ background: sel ? undefined : (idx % 2 === 0 ? 'transparent' : dark ? '#141416' : '#f5f5f5'), animationName:'rowIn', animationDuration:'0.25s', animationTimingFunction:'ease', animationFillMode:'backwards', animationDelay:`${Math.min(idx * 20, 300)}ms`, ...(idx === paginatedLeads.length - 1 ? { borderBottom: 'none' } : {}) }}
                        onClick={() => handleViewLead(lead)}>
                        <td className="pl-4 pr-2 py-3" onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={sel} onChange={e => { const n = new Set(selectedIds); e.target.checked ? n.add(lead.id) : n.delete(lead.id); setSelectedIds(n); if (!e.target.checked) setAllSystemSelected(false); }} onClick={e => e.stopPropagation()} style={{ width:'15px', height:'15px', accentColor:'#0044fd', opacity:0.5, cursor:'pointer' }}/>
                        </td>
                        <td className="px-3" style={{ overflow:'hidden', paddingTop:'12px', paddingBottom:'12px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                            {/* Avatar centralizado verticalmente */}
                            <div style={{ position:'relative', flexShrink:0, alignSelf:'center' }}>
                              {(()=>{ const ac=getAvatarColor(lead.nome, dark, lead.id); return <div style={{ width:'32px', height:'32px', borderRadius:'50%', background:ac, display:'flex', alignItems:'center', justifyContent:'center', color:getAvatarTextColor(ac), fontSize:'11px', fontWeight:700 }}>{getInitials(lead.nome)}</div>; })()}
                              {toStatusNum(lead.status) === 1 && !la.avaliado && <div style={{ position:'absolute', top:'-1px', right:'-1px', width:'10px', height:'10px', borderRadius:'50%', background:'#3b82f6', border:`1.5px solid ${dark?'#111113':'#ffffff'}`, boxShadow:'0 0 0 1px rgba(59,130,246,0.25)', zIndex:2 }}/>}
                            </div>
                            {/* Coluna: nome + tags, centralizada verticalmente */}
                            <div style={{ display:'flex', flexDirection:'column', justifyContent:'center', gap:'3px', minWidth:0 }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'4px', minWidth:0 }}>
                                <span style={{ fontSize:'13px', fontWeight:500, color:dark ? '#f0f0f0' : '#111827', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{safeName(lead.nome) || 'Lead'}</span>
                                {obs && obs.trim() && <ObsTooltip text={obs} dark={dark}/>}
                              </div>
                              {(() => {
                                const lt = leadTagsMap.get(lead.id) || [];
                                if (!lt.length) return null;
                                const vis = lt.slice(0, 2); const rest = lt.slice(2);
                                return (
                                  <div style={{ display:'flex', gap:'3px', flexWrap:'wrap' }}>
                                    {vis.map(tag => (
                                      <span key={tag.id} style={{ display:'inline-flex', alignItems:'center', padding:'1px 5px', borderRadius:'99px', fontSize:'10px', fontWeight:600, lineHeight:'1.3', color:tag.cor, background:tag.cor+'20', border:`1px solid ${tag.cor}40`, whiteSpace:'nowrap' }}>{tag.nome}</span>
                                    ))}
                                    {rest.length > 0 && (
                                      <span title={rest.map(t => t.nome).join(', ')} style={{ display:'inline-flex', alignItems:'center', padding:'1px 5px', borderRadius:'99px', fontSize:'10px', fontWeight:600, lineHeight:'1.3', color:'#6b7280', background:'rgba(107,114,128,0.1)', border:'1px solid rgba(107,114,128,0.2)', cursor:'default' }}>+{rest.length}</span>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3" style={{ whiteSpace:'nowrap', textAlign:'center' }}>
                          {(() => {
                            const score = la.score != null ? Number(la.score) : null;
                            if (score == null) return <span style={{color:dark?'#3f3f46':'#d1d5db',fontSize:'13px'}}>—</span>;
                            const faixaVal = calcularFaixa(lead, configuracoes!) ?? la.faixa;
                            const isVerde = faixaVal === 'verde';
                            const isAmarelo = faixaVal === 'amarelo';
                            const color = isVerde ? '#10b981' : isAmarelo ? '#f59e0b' : (dark ? '#6b6b75' : '#9ca3af');
                            return <span style={{fontSize:'13px',fontWeight:isVerde||isAmarelo?700:600,color}}>{score} pts</span>;
                          })()}
                        </td>
                        <td className="px-3 py-3" style={{ color: dark ? '#9090a0' : '#374151', fontSize:'12.5px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{lead.whatsapp ? formatarWhatsapp(lead.whatsapp) : '—'}</td>
                        <td className="px-3 py-3" style={{ color: dark ? '#9090a0' : '#374151', fontSize:'12.5px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{safeName(lead.cidade) ? normalizeCity(safeName(lead.cidade)) : '—'}</td>
                        <td className="px-3 py-3" style={{ textAlign:'center' }}>
                          {(() => {
                            const pill = getStatusPillStyle(s, dark);
                            return (
                              <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'5px', minWidth:'130px', padding:'4px 10px', borderRadius:'6px', fontSize:'11.5px', fontWeight:600, whiteSpace:'nowrap', background:pill.bg, color:pill.color, border:`1px solid ${pill.border}` }}>
                                <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:pill.dot, flexShrink:0, display:'inline-block' }}/>{getStatusLabel(s)}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-3" style={{ color: dark ? '#7a7a88' : '#374151', fontSize:'12px', whiteSpace:'nowrap' }}>{formatEntrada(getLeadMoveDateForView(lead) ?? lead.created_at)}</td>
                        <td className="px-3 py-3">
                          <div style={{ display:'flex', alignItems:'center', gap:'5px' }} onClick={e => e.stopPropagation()}>
                            <button onClick={() => handleWhatsApp(lead)} className={`w-7 h-7 rounded-lg inline-flex items-center justify-center transition-all ${dark ? 'bg-green-500/15 text-green-500 hover:bg-green-500/25' : 'bg-green-50 text-green-600 hover:bg-green-100'}`} style={{ border:'none', cursor:lead.whatsapp ? 'pointer' : 'default', opacity:lead.whatsapp ? 1 : 0.4, borderRadius:'8px' }}><MessageCircle className="w-3.5 h-3.5"/></button>
                            <button onClick={() => { setEditingLead(lead); setIsEditOpen(true); }} className={`w-7 h-7 rounded-lg inline-flex items-center justify-center transition-all ${dark ? 'bg-blue-500/15 text-blue-500 hover:bg-blue-500/25' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`} style={{ borderRadius:'8px' }}><Edit className="w-3.5 h-3.5"/></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {!isLoading && totalPages > 1 && (
              <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: `1px solid ${dark ? 'rgba(255,255,255,0.04)' : border}` }}>
                <p className={`text-sm ${muted}`}>Mostrando {(currentPage - 1) * leadsPerPage + 1}–{Math.min(currentPage * leadsPerPage, filtered.length)} de {filtered.length}</p>
                <div style={{ display:'flex', gap:'4px' }}>
                  <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} style={{ padding:'6px 12px', borderRadius:'8px', border:`1px solid ${border}`, background:cardBg, color:txtMid, fontSize:'13px', cursor:currentPage === 1 ? 'default' : 'pointer', opacity:currentPage === 1 ? 0.4 : 1 }}>Anterior</button>
                  <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} style={{ padding:'6px 12px', borderRadius:'8px', border:`1px solid ${border}`, background:cardBg, color:txtMid, fontSize:'13px', cursor:currentPage === totalPages ? 'default' : 'pointer', opacity:currentPage === totalPages ? 0.4 : 1 }}>Próximo</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {showDeleteConf && (
        <DeleteConfirmDialog
          count={activeBulkCount}
          onConfirm={handleDeleteSelected}
          onCancel={() => setShowDeleteConf(false)}
          loading={deleting}
          dark={dark}
        />
      )}

      {showMoveStatusConfirm && pendingMoveStatus !== null && (
        <ConfirmDialog
          title={`Mover ${activeBulkCount} lead${activeBulkCount !== 1 ? 's' : ''} para "${pendingMoveStatusLabel}"?`}
          message="Isso vai atualizar o status de todos os leads selecionados."
          confirmText="Sim, mover"
          onConfirm={() => handleBulkMoveStatus(pendingMoveStatus)}
          onCancel={() => { setShowMoveStatusConfirm(false); setPendingMoveStatus(null); }}
          loading={bulkLoading}
          dark={dark}
        />
      )}

      {showAvaliarConf && (
        <ConfirmDialog
          title={allSelectedAreEvaluated ? 'Desmarcar como avaliado?' : 'Marcar como avaliado?'}
          message={`Isso vai ${allSelectedAreEvaluated ? 'desmarcar' : 'marcar'} ${activeBulkCount} lead${activeBulkCount !== 1 ? 's' : ''} como ${allSelectedAreEvaluated ? 'não avaliado' : 'avaliado'}.`}
          confirmText={allSelectedAreEvaluated ? 'Sim, desmarcar' : 'Sim, marcar'}
          onConfirm={handleToggleAvaliado}
          onCancel={() => setShowAvaliarConf(false)}
          loading={bulkLoading}
          dark={dark}
        />
      )}

      {showBulkTagModal && (
        <BulkTagModal
          dark={dark}
          tags={orgTags}
          ids={allSystemSelected ? filtered.map(l => l.id) : Array.from(selectedIds)}
          leadTagsMap={leadTagsMap}
          selectedCount={activeBulkCount}
          onApply={handleBulkTag}
          onClose={() => setShowBulkTagModal(false)}
          onCreateTag={createOrgTag}
        />
      )}

      {/* Edit lead dialog */}
      <Dialog open={isEditOpen} onOpenChange={open => { setIsEditOpen(open); if (!open) setEditingLead(null); }}>
        <DialogContent style={{ background:dark ? '#111113' : '#fff', border:`1px solid ${border}`, borderRadius:'16px' }}>
          <DialogHeader><DialogTitle style={{ color:dark ? '#fff' : '#111827' }}>Editar Lead</DialogTitle></DialogHeader>
          {editingLead && (
            <div style={{ display:'flex', flexDirection:'column', gap:'10px', marginTop:'8px' }}>
              <input placeholder="Nome" value={editingLead.nome || ''} onChange={e => setEditingLead(l => l && ({ ...l, nome: e.target.value }))} style={inputStyle}/>
              <PhoneInput value={editingLead.whatsapp || ''} onChange={v => setEditingLead(l => l && ({ ...l, whatsapp: v }))} style={inputStyle}/>
              <input placeholder="Cidade" value={editingLead.cidade || ''} onChange={e => setEditingLead(l => l && ({ ...l, cidade: e.target.value }))} style={inputStyle}/>
              <div>
                <label style={{ fontSize:'11px', color:txtMid, display:'block', marginBottom:'4px', fontWeight:600, textTransform:'uppercase' }}>Origem</label>
                <select
                  value={(() => {
                    const src = (editingLead as any).utm_source || '';
                    if (src === 'FB') return 'Tráfego Pago';
                    if (src === 'instagram_organico') return 'Instagram Orgânico';
                    return ['Indicação','Tráfego Pago','Instagram Orgânico','Manual','Outro'].includes(src) ? src : src ? 'Outro' : '';
                  })()}
                  onChange={e => {
                    const val = e.target.value;
                    setEditingLead(l => l && ({
                      ...l,
                      utm_source: val === 'Instagram Orgânico' ? 'instagram_organico' : val,
                      ...(val !== 'Indicação' ? { custo_indicacao: null } : {}),
                    }));
                  }}
                  style={inputStyle}
                >
                  <option value="">Sem origem definida</option>
                  <option value="Indicação">Indicação</option>
                  <option value="Tráfego Pago">Tráfego Pago</option>
                  <option value="Instagram Orgânico">Instagram Orgânico</option>
                  <option value="Manual">Manual</option>
                  <option value="Outro">Outro</option>
                </select>
              </div>
              {(editingLead as any)?.utm_source === 'Indicação' && (
                <div>
                  <label style={{ fontSize:'11px', color:txtMid, display:'block', marginBottom:'4px', fontWeight:600, textTransform:'uppercase' }}>Custo da indicação (R$) *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Ex: 100"
                    value={(editingLead as any).custo_indicacao ?? ''}
                    onChange={e => setEditingLead(l => l && ({ ...l, custo_indicacao: e.target.value !== '' ? Number(e.target.value) : null } as any))}
                    style={inputStyle}
                  />
                  <p style={{ fontSize:'11px', color:txtMid, margin:'4px 0 0' }}>Só será contabilizado no gasto quando o lead for convertido.</p>
                </div>
              )}
              <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                <button onClick={handleEditLead} style={{ flex:1, padding:'10px', borderRadius:'9px', border:'none', background:'#0044fd', color:'#fff', fontSize:'13px', fontWeight:500, cursor:'pointer' }}>Salvar</button>
                <button onClick={() => setIsEditOpen(false)} style={{ flex:1, padding:'10px', borderRadius:'9px', border:`1px solid ${border}`, background:'transparent', color:txtMid, fontSize:'13px', cursor:'pointer' }}>Cancelar</button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <LeadDrawer lead={viewingLead} isOpen={!!viewingLead} onClose={() => setViewingLead(null)} onUpdate={updated => { updateLead(updated.id, updated); setAllLeads(prev => prev.map(l => l.id === updated.id ? updated : l)); setViewingLead(updated); }} onTagsChange={(leadId, tags) => setLeadTagsMap(prev => { const next = new Map(prev); if (tags.length === 0) next.delete(leadId); else next.set(leadId, tags); return next; })}/>

      {/* Tag Manager Modal */}
      {showTagManagerModal && createPortal(
        <>
          <div onClick={closeTagManager} style={{ position:'fixed', inset:0, zIndex:9998, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(4px)' }}/>
          <div onClick={e => e.stopPropagation()} style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', zIndex:9999, background:dark?'#111113':'#fff', borderRadius:'18px', border:`1px solid ${dark?'#27272a':'rgba(0,0,0,0.08)'}`, width:'90%', maxWidth:'420px', maxHeight:'82vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.4)', fontFamily:'inherit' }}>
            <div style={{ padding:'18px 20px', borderBottom:`1px solid ${dark?'#1e1e22':'rgba(0,0,0,0.06)'}`, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
              <h3 style={{ margin:0, fontSize:'15px', fontWeight:700, color:dark?'#f4f4f5':'#111827' }}>Gerenciar Tags</h3>
              <button onClick={closeTagManager} style={{ width:'28px', height:'28px', borderRadius:'7px', border:'none', background:dark?'rgba(255,255,255,0.06)':'rgba(0,0,0,0.05)', color:dark?'#71717a':'#6b7280', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <X style={{ width:'13px', height:'13px' }}/>
              </button>
            </div>
            <div style={{ overflow:'auto', flex:1, padding:'12px' }}>
              <div style={{ padding:'12px', borderRadius:'10px', background:dark?'#18181b':'#f8fafc', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, marginBottom:'12px', display:'flex', flexDirection:'column', gap:'8px' }}>
                <p style={{ margin:0, fontSize:'11px', fontWeight:700, color:dark?'#52525b':'#9ca3af', textTransform:'uppercase', letterSpacing:'0.05em' }}>Nova tag</p>
                <input placeholder="Nome da tag..." value={mgrNewNome} onChange={e => setMgrNewNome(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && mgrNewNome.trim()) handleMgrCreate(); }}
                  style={{ padding:'8px 10px', borderRadius:'8px', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, background:dark?'#111113':'#fff', color:dark?'#f4f4f5':'#111827', fontSize:'13px', outline:'none', fontFamily:'inherit' }}/>
                <div style={{ display:'flex', flexWrap:'wrap', gap:'5px' }}>
                  {CORES_TAGS.map(c => <button key={c} onClick={() => setMgrNewCor(c)} style={{ width:'20px', height:'20px', borderRadius:'50%', background:c, border:mgrNewCor===c?`3px solid ${dark?'#fff':'#111'}`:'3px solid transparent', cursor:'pointer', padding:0 }}/>)}
                </div>
                <button onClick={handleMgrCreate} disabled={!mgrNewNome.trim() || mgrCreating}
                  style={{ padding:'8px', borderRadius:'8px', border:'none', background:mgrNewNome.trim()?'#3b82f6':(dark?'#27272a':'#e5e7eb'), color:mgrNewNome.trim()?'#fff':(dark?'#52525b':'#9ca3af'), fontSize:'13px', fontWeight:600, cursor:mgrNewNome.trim()?'pointer':'default', fontFamily:'inherit' }}>
                  {mgrCreating?'Criando...':'Criar tag'}
                </button>
              </div>
              {orgTags.length === 0 ? (
                <p style={{ textAlign:'center', fontSize:'13px', color:dark?'#52525b':'#9ca3af', padding:'20px 0', margin:0 }}>Nenhuma tag criada ainda.</p>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                  {orgTags.map(tag => {
                    const isEditing = mgrEditId === tag.id;
                    const isDeleting = mgrDeleteId === tag.id;
                    return (
                      <div key={tag.id} style={{ padding:'10px 12px', borderRadius:'10px', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, background:dark?'#18181b':'#fafafa', display:'flex', flexDirection:'column', gap:'8px' }}>
                        {isEditing ? (
                          <>
                            <input value={mgrEditNome} onChange={e => setMgrEditNome(e.target.value)}
                              style={{ padding:'7px 10px', borderRadius:'8px', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, background:dark?'#111113':'#fff', color:dark?'#f4f4f5':'#111827', fontSize:'13px', outline:'none', fontFamily:'inherit' }}/>
                            <div style={{ display:'flex', flexWrap:'wrap', gap:'4px' }}>
                              {CORES_TAGS.map(c => <button key={c} onClick={() => setMgrEditCor(c)} style={{ width:'18px', height:'18px', borderRadius:'50%', background:c, border:mgrEditCor===c?`3px solid ${dark?'#fff':'#111'}`:'3px solid transparent', cursor:'pointer', padding:0 }}/>)}
                            </div>
                            <div style={{ display:'flex', gap:'6px' }}>
                              <button onClick={handleMgrSaveEdit} style={{ flex:1, padding:'7px', borderRadius:'7px', border:'none', background:'#10b981', color:'#fff', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>Salvar</button>
                              <button onClick={() => setMgrEditId(null)} style={{ flex:1, padding:'7px', borderRadius:'7px', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, background:'transparent', color:dark?'#a1a1aa':'#6b7280', fontSize:'12px', cursor:'pointer', fontFamily:'inherit' }}>Cancelar</button>
                            </div>
                          </>
                        ) : isDeleting ? (
                          <>
                            <p style={{ margin:0, fontSize:'12.5px', color:dark?'#f4f4f5':'#111827' }}>Excluir <strong>{tag.nome}</strong> de todos os leads? Não pode ser desfeito.</p>
                            <div style={{ display:'flex', gap:'6px' }}>
                              <button onClick={handleMgrDelete} style={{ flex:1, padding:'7px', borderRadius:'7px', border:'none', background:'#ef4444', color:'#fff', fontSize:'12px', fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>Excluir</button>
                              <button onClick={() => setMgrDeleteId(null)} style={{ flex:1, padding:'7px', borderRadius:'7px', border:`1px solid ${dark?'#27272a':'#e5e7eb'}`, background:'transparent', color:dark?'#a1a1aa':'#6b7280', fontSize:'12px', cursor:'pointer', fontFamily:'inherit' }}>Cancelar</button>
                            </div>
                          </>
                        ) : (
                          <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                            <span style={{ width:'10px', height:'10px', borderRadius:'50%', background:tag.cor, flexShrink:0 }}/>
                            <span style={{ flex:1, fontSize:'13px', fontWeight:500, color:dark?'#f4f4f5':'#111827' }}>{tag.nome}</span>
                            <button onClick={() => { setMgrEditId(tag.id); setMgrEditNome(tag.nome); setMgrEditCor(tag.cor); setMgrDeleteId(null); }} style={{ fontSize:'12px', color:dark?'#71717a':'#9ca3af', background:'none', border:'none', cursor:'pointer', padding:'2px 6px', borderRadius:'5px', fontFamily:'inherit' }}>Editar</button>
                            <button onClick={() => { setMgrDeleteId(tag.id); setMgrEditId(null); }} style={{ fontSize:'12px', color:'#ef4444', background:'none', border:'none', cursor:'pointer', padding:'2px 6px', borderRadius:'5px', fontFamily:'inherit' }}>Excluir</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>,
        document.body
      )}

      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes rowIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes headerIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes tableIn{from{opacity:0}to{opacity:1}}
      `}</style>
    </AppLayout>
  );
}

export default function LeadsPageExport() {
  return (
    <ErrorBoundary>
      <LeadsPage />
    </ErrorBoundary>
  );
}
