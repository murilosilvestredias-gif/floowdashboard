import { create } from 'zustand';

export interface Lead {
  id: string;
  nome: string;
  whatsapp: string;
  cidade: string;
  instagram?: string;
  o_que_mais_te_atrai?: string;
  quanto_gostaria_de_ganhar_por_mes?: string;
  o_que_mais_gostaria_de_conquistar?: string;
  onde_se_imagina_em_6_meses?: string;
  qual_sua_idade?: string;
  tem_filhos?: string;
  idade_do_filho_mais_novo?: string;
  voce_tem_alguma_rede_de_apoio?: string;
  voce_mora_com_alguem?: string;
  por_quais_meios_pretende_vender?: string;
  quantas_horas_por_semana_vai_se_dedicar?: string;
  quando_gostaria_de_comecar?: string;
  situacao_atual?: string;
  experiencia_em_vendas?: string;
  ja_tentou_vender_semijoia?: string;
  para_comecar_no_consignado?: string;
  seu_nome_esta_negativado?: string;
  voce_aceita_as_regras_do_consignado?: string;
  status?: number | null;
  entrada?: string;
  wa_sent?: boolean;
  observacoes?: string;
  created_at?: string;
  entrada_at?: string;
  updated_at?: string;
  user_id?: string;
  utm_source?: string;
  quiz_data?: Record<string, unknown>;
  ultimo_status_change?: string;
  motivo_reprovacao?: string;
  status_atendimento_at?: string;
  status_reuniao_at?: string;
  status_contrato_at?: string;
  status_aprovado_at?: string;
  score?: number | null;
  faixa?: 'verde' | 'amarelo' | 'vermelho' | null;
  avaliado?: boolean;
  [key: string]: unknown;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  budget: number;
  budget_type: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  roas: number;
  leads_api: number;
  reach: number;
}

export interface Creative {
  id: string;
  name: string;
  thumbnail_url?: string;
  effective_status: string;
  adset_name?: string;
  campaign_name?: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  cpl?: number;
  leads?: number;
}

export interface CamposPerfil {
  label: string;
  campo: string;
}

export interface Trava {
  campo: string;
  contem: string;
}

export interface Configuracoes {
  campos_perfil: CamposPerfil[];
  faixas_score: {
    travas: Trava[];
    vermelho_se_todas: boolean;
  };
}

// Situações que limitam ao amarelo independente do score
const SITUACOES_LIMITANTES = [
  'desempregada', 'desempregado',
  'autônoma', 'autônomo', 'autonoma', 'autonomo',
  'renda informal', // pega "Autônoma / renda informal / revenda catálogo"
  'do lar', 'dona de casa',
  'aposentada', 'aposentado',
];

function getSituacaoAtual(lead: Lead): string {
  // Busca em todas as possíveis fontes
  return (
    String((lead as any).situacao_atual || '') ||
    String((lead as any).quiz_respostas?.situacao_atual || '') ||
    String((lead as any).quiz_data?.situacao_atual || '') ||
    ''
  ).toLowerCase();
}

export function calcularFaixa(
  lead: Lead,
  config: Configuracoes
): 'verde' | 'amarelo' | 'vermelho' | null {

  // 1. Calcula faixa base pelo score (nova lógica)
  // Score < 25 → barrada no quiz (não entra no sistema)
  // Score 25–34 → amarelo
  // Score ≥ 35 → verde
  let faixaCalculada: 'verde' | 'amarelo' | 'vermelho' | null = null;

  if (lead.score != null) {
    const score = Number(lead.score);
    const corteVerde = (config as any)?.score_corte_verde ?? 35;
    const corteAmarelo = (config as any)?.score_corte_amarelo ?? 25;
    if (score < corteAmarelo) faixaCalculada = 'vermelho';
    else if (score >= corteVerde) faixaCalculada = 'verde';
    else faixaCalculada = 'amarelo';
  } else if (lead.faixa) {
    // Sem score: usa faixa salva no banco como fallback
    faixaCalculada = lead.faixa;
  } else {
    // Fallback antigo por travas
    if (!config?.faixas_score?.travas?.length) return null;
    const { travas, vermelho_se_todas } = config.faixas_score;
    const travaAtivada = (trava: Trava): boolean => {
      const valor = String(lead[trava.campo] || '').toLowerCase();
      return valor.includes(trava.contem.toLowerCase());
    };
    const travaCount = travas.filter(travaAtivada).length;
    if (travaCount === 0) faixaCalculada = 'verde';
    else if (vermelho_se_todas && travaCount === travas.length) faixaCalculada = 'vermelho';
    else faixaCalculada = 'amarelo';
  }

  // 2. Regra de situação limitante — SEMPRE aplicada depois
  // Desempregada / autônoma / do lar → máximo amarelo, nunca verde
  if (faixaCalculada === 'verde') {
    const situacao = getSituacaoAtual(lead);
    const ehLimitante = SITUACOES_LIMITANTES.some(s => situacao.includes(s));
    if (ehLimitante) return 'amarelo';
  }

  return faixaCalculada;
}

export const STATUS_CONFIG: Record<number, { label: string; lightBg: string; lightText: string; darkBg: string; darkText: string; dot: string }> = {
  0: { label: 'Em atendimento', lightBg:'#eff6ff', lightText:'#2563eb', darkBg:'#1e3a8a', darkText:'#60a5fa', dot:'#3b82f6' },
  1: { label: 'Em atendimento', lightBg:'#eff6ff', lightText:'#2563eb', darkBg:'#1e3a8a', darkText:'#60a5fa', dot:'#3b82f6' },
  2: { label: 'Reunião', lightBg:'#f5f3ff', lightText:'#7c3aed', darkBg:'#4c1d95', darkText:'#a78bfa', dot:'#8b5cf6' },
  3: { label: 'Aprovado', lightBg:'#ecfdf5', lightText:'#059669', darkBg:'#064e3b', darkText:'#34d399', dot:'#10b981' },
  4: { label: 'Reprovado', lightBg:'#fff1f2', lightText:'#e11d48', darkBg:'#881337', darkText:'#fb7185', dot:'#f43f5e' },
  5: { label: 'Contrato/App', lightBg:'#fffbeb', lightText:'#d97706', darkBg:'#78350f', darkText:'#fbbf24', dot:'#f59e0b' },
  6: { label: 'Sem Retorno', lightBg:'#f4f4f5', lightText:'#52525b', darkBg:'rgba(113,113,122,0.15)', darkText:'#a1a1aa', dot:'#71717a' },
};

export const STATUS_SEQUENCE = [1, 2, 5, 3, 6, 4];

export const STATUS_LABELS = [
  'Em atendimento', // 0
  'Em atendimento', // 1
  'Reunião',        // 2
  'Aprovado',       // 3
  'Reprovado',      // 4
  'Contrato/App',   // 5
  'Sem Retorno',    // 6
];

export const STATUS_COLORS = [
  { bg: 'bg-blue-50',   text: 'text-blue-600',   dot: 'bg-blue-400'   }, // 0
  { bg: 'bg-blue-50',   text: 'text-blue-600',   dot: 'bg-blue-400'   }, // 1
  { bg: 'bg-violet-50', text: 'text-violet-600', dot: 'bg-violet-400' }, // 2
  { bg: 'bg-emerald-50',text: 'text-emerald-600',dot: 'bg-emerald-400'}, // 3
  { bg: 'bg-rose-50',   text: 'text-rose-600',   dot: 'bg-rose-400'   }, // 4
  { bg: 'bg-amber-50',  text: 'text-amber-600',  dot: 'bg-amber-400'  }, // 5
  { bg: 'bg-zinc-100',  text: 'text-zinc-600',   dot: 'bg-zinc-400'   }, // 6
];

interface AppState {
  leads: Lead[];
  campaigns: Campaign[];
  creatives: Creative[];
  configuracoes: Configuracoes | null;
  metaAccountId: string;
  metaToken: string;
  period: string;
  theme: 'light' | 'dark';

  setTheme: (theme: 'light' | 'dark') => void;
  toggleTheme: () => void;
  setLeads: (leads: Lead[]) => void;
  addLead: (lead: Lead) => void;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  setCampaigns: (campaigns: Campaign[]) => void;
  setCreatives: (creatives: Creative[]) => void;
  setPeriod: (period: string) => void;
  setMetaAccountId: (id: string) => void;
  setMetaToken: (token: string) => void;
  setConfiguracoes: (config: Configuracoes) => void;
}

export const useAppStore = create<AppState>((set) => ({
  leads: [],
  campaigns: [],
  creatives: [],
  configuracoes: null,
  metaAccountId: '',
  metaToken: '',
  period: 'last_30d',
  theme: (typeof window !== 'undefined'
    ? (localStorage.getItem('theme') as 'light' | 'dark') || 'light'
    : 'light'),

  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
  setLeads: (leads) => set({ leads }),
  addLead: (lead) => set((s) => ({ leads: [lead, ...s.leads] })),
  updateLead: (id, updates) =>
    set((s) => ({
      leads: s.leads.map((l) => (l.id === id ? { ...l, ...updates } : l)),
    })),
  setCampaigns: (campaigns) => set({ campaigns }),
  setCreatives: (creatives) => set({ creatives }),
  setPeriod: (period) => set({ period }),
  setMetaAccountId: (metaAccountId) => set({ metaAccountId }),
  setMetaToken: (metaToken) => set({ metaToken }),
  setConfiguracoes: (configuracoes) => set({ configuracoes }),
}));