import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/AppLayout';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/integrations/supabase/client';
import { Copy, CheckCircle2, Save, Settings, Plus, Pencil, Trash2, Check, X, Heart, FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/hooks/useTheme';
import { useOrgId } from '@/hooks/useOrgId';
import { usePlanFeatures } from '@/hooks/usePlanFeatures';
import { UpgradeModal } from '@/components/ui/UpgradeModal';
import { LeadReconciliation } from '@/components/webhook/LeadReconciliation';
import { IngestionHealth } from '@/components/webhook/IngestionHealth';

const URL_RECEBER_LEAD = 'https://obguidmfvfjaekaskgob.functions.supabase.co/receber-lead';

function isPrincipalWebhook(nome: string | null | undefined): boolean {
  return String(nome || '').trim().toLowerCase() === 'principal';
}

function generateWebhookToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function getWebhookUrl(nome: string, token: string | null): string {
  void nome;
  return token ? URL_RECEBER_LEAD + '?token=' + token : URL_RECEBER_LEAD;
}

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, sans-serif';

interface WebhookLog {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
}

interface Webhook {
  id: string;
  nome: string;
  token: string;
  ativo: boolean;
  created_at: string;
}

export default function WebhookPage() {
  const { leads, setConfiguracoes, configuracoes } = useAppStore();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const { orgId, ready: orgReady } = useOrgId();
  const { features, loading } = usePlanFeatures();
  const [showWebhookUpgrade, setShowWebhookUpgrade] = useState(false);

  const [activeAba, setActiveAba] = useState<'config' | 'health' | 'reconcile'>('config');

  const [logs, setLogs] = useState<WebhookLog[]>([]);
  const [usaQuizExterno, setUsaQuizExterno] = useState(false);
  const [scoreVerde, setScoreVerde] = useState(35);
  const [scoreAmarelo, setScoreAmarelo] = useState(25);
  const [savingScore, setSavingScore] = useState(false);

  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newNome, setNewNome] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNome, setEditNome] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    if (!orgReady || !orgId) return;

    supabase.from('organizations').select('usa_quiz_externo, score_corte_verde, score_corte_amarelo').eq('id', orgId).single()
      .then(({ data }) => {
        if (data) {
          setUsaQuizExterno(!!(data as any).usa_quiz_externo);
          setScoreVerde((data as any).score_corte_verde ?? 35);
          setScoreAmarelo((data as any).score_corte_amarelo ?? 25);
        }
      });

    fetchWebhooks();
  }, [orgId, orgReady]); // eslint-disable-line

  useEffect(() => {
    if (!orgReady || !orgId) return;

    supabase.from('webhook_logs').select('*').eq('org_id', orgId)
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => { if (data) setLogs(data as unknown as WebhookLog[]); });

    const channel = supabase.channel(`webhook-logs-${orgId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'webhook_logs', filter: `org_id=eq.${orgId}` },
        p => { setLogs(prev => [p.new as unknown as WebhookLog, ...prev].slice(0, 50)); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [orgId, orgReady]); // eslint-disable-line

  async function fetchWebhooks() {
    if (!orgId) return;
    setLoadingWebhooks(true);
    const { data } = await (supabase as any).from('webhooks').select('*').eq('org_id', orgId).order('created_at', { ascending: true });
    let rows = (data || []) as Webhook[];

    if (!rows.some(wh => isPrincipalWebhook(wh.nome))) {
      const token = generateWebhookToken();
      const { data: created, error } = await (supabase as any)
        .from('webhooks')
        .insert({ org_id: orgId, nome: 'Principal', token, ativo: true })
        .select('*')
        .single();

      if (!error && created) {
        rows = [created as Webhook, ...rows];
      }
    }

    setWebhooks(rows);
    setLoadingWebhooks(false);
  }

  async function createWebhook() {
    if (!orgId || !newNome.trim()) return;
    setCreating(true);
    const { error } = await (supabase as any).from('webhooks').insert({ org_id: orgId, nome: newNome.trim(), token: generateWebhookToken(), ativo: true });
    if (error) {
      toast.error('Erro ao criar webhook');
    } else {
      toast.success('Webhook criado!');
      setShowCreateModal(false);
      setNewNome('');
      fetchWebhooks();
    }
    setCreating(false);
  }

  async function toggleWebhook(wh: Webhook) {
    setTogglingId(wh.id);
    await (supabase as any).from('webhooks').update({ ativo: !wh.ativo }).eq('id', wh.id);
    setWebhooks(prev => prev.map(w => w.id === wh.id ? { ...w, ativo: !wh.ativo } : w));
    setTogglingId(null);
  }

  async function deleteWebhook(id: string) {
    await (supabase as any).from('webhooks').delete().eq('id', id);
    setWebhooks(prev => prev.filter(w => w.id !== id));
    setDeleteId(null);
    toast.success('Webhook excluído');
  }

  async function saveEditNome(id: string) {
    if (!editNome.trim()) return;
    await (supabase as any).from('webhooks').update({ nome: editNome.trim() }).eq('id', id);
    setWebhooks(prev => prev.map(w => w.id === id ? { ...w, nome: editNome.trim() } : w));
    setEditingId(null);
  }

  function copyWebhookUrl(id: string, token: string | null, nome: string) {
    const u = getWebhookUrl(nome, token);
    navigator.clipboard.writeText(u);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  const handleSaveScore = async () => {
    if (!orgId) return;
    setSavingScore(true);
    const { error } = await supabase.from('organizations').update({
      usa_quiz_externo: usaQuizExterno,
      score_corte_verde: scoreVerde,
      score_corte_amarelo: scoreAmarelo,
    }).eq('id', orgId);
    setSavingScore(false);
    if (error) {
      toast.error('Erro ao salvar configurações');
    } else {
      const base = configuracoes || { campos_perfil: [], faixas_score: { travas: [], vermelho_se_todas: false } };
      setConfiguracoes({ ...base, score_corte_verde: scoreVerde, score_corte_amarelo: scoreAmarelo } as any);
      toast.success('Configurações salvas!');
    }
  };

  // ── Style tokens ───────────────────────────────────────────
  const txt    = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#a1a1aa' : '#6b7280';
  const border = dark ? '#27272a' : '#e5e7eb';
  const cardBg = dark ? '#111113' : '#ffffff';
  const inputBg = dark ? '#0d0d0f' : '#f8fafc';
  const urlBg   = dark ? '#0d0d0f' : '#f8fafc';

  const inputStyle: React.CSSProperties = {
    padding: '8px 12px', borderRadius: '8px', border: `1px solid ${border}`,
    background: inputBg, color: txt, fontSize: '13px',
    outline: 'none', fontFamily: FONT, width: '100%', boxSizing: 'border-box' as const,
  };

  const sectionCard: React.CSSProperties = {
    background: cardBg,
    border: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.08)'}`,
    borderRadius: '18px', overflow: 'hidden',
    boxShadow: dark ? '0 4px 12px rgba(0,0,0,0.4)' : '0 2px 8px rgba(0,0,0,0.06)',
  };

  function fmtData(d: string) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  return (
    <AppLayout leadCount={leads.length}>
      <div style={{ padding: '32px', maxWidth: '800px', fontFamily: FONT }}>

        {/* ── Page header ───────────────────────────────────────── */}
        <div style={{ marginBottom: '28px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: txt, margin: 0, letterSpacing: '-0.03em' }}>Webhook</h1>
          <p style={{ fontSize: '13px', color: txtMid, marginTop: '4px', margin: '4px 0 0' }}>
            Gerencie os webhooks de integração com seus quizzes e ferramentas externas.
          </p>
        </div>

        {/* ── Tabs selector ───────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: '8px', borderBottom: `1px solid ${border}`, paddingBottom: '12px', marginBottom: '24px' }}>
          <button
            onClick={() => setActiveAba('config')}
            style={{
              padding: '8px 16px', borderRadius: '8px', border: 'none',
              background: activeAba === 'config' ? (dark ? '#27272a' : '#f4f4f5') : 'transparent',
              color: activeAba === 'config' ? txt : txtMid,
              fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              display: 'flex', alignItems: 'center', gap: '6px'
            }}
          >
            <Settings style={{ width: '14px', height: '14px' }} />
            Configurações
          </button>
          <button
            onClick={() => setActiveAba('health')}
            style={{
              padding: '8px 16px', borderRadius: '8px', border: 'none',
              background: activeAba === 'health' ? (dark ? '#27272a' : '#f4f4f5') : 'transparent',
              color: activeAba === 'health' ? txt : txtMid,
              fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              display: 'flex', alignItems: 'center', gap: '6px'
            }}
          >
            <Heart style={{ width: '14px', height: '14px' }} />
            Saúde & Fila
          </button>
          <button
            onClick={() => setActiveAba('reconcile')}
            style={{
              padding: '8px 16px', borderRadius: '8px', border: 'none',
              background: activeAba === 'reconcile' ? (dark ? '#27272a' : '#f4f4f5') : 'transparent',
              color: activeAba === 'reconcile' ? txt : txtMid,
              fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              display: 'flex', alignItems: 'center', gap: '6px'
            }}
          >
            <FileSpreadsheet style={{ width: '14px', height: '14px' }} />
            Reconciliação CSV
          </button>
        </div>

        {/* ── Aba 1: Configurações ─────────────────────────────────── */}
        {activeAba === 'config' && (
          <>
            {/* Meus Webhooks */}
            <div style={{ marginBottom: '32px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyBetween: 'space-between', justifyContent: 'space-between', marginBottom: '14px' }}>
                <h2 style={{ fontSize: '14px', fontWeight: 600, color: txt, margin: 0, letterSpacing: '-0.01em' }}>
                  Meus Webhooks
                  {!loadingWebhooks && webhooks.length > 0 && (
                    <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 500, color: txtMid, background: dark ? '#27272a' : '#f4f4f5', padding: '2px 7px', borderRadius: '99px' }}>
                      {webhooks.length}
                    </span>
                  )}
                </h2>
                <button
                  onClick={() => {
                    if (!loading && !features.webhooksIlimitados && webhooks.length >= 1) {
                      setShowWebhookUpgrade(true);
                      return;
                    }
                    setNewNome(webhooks.some(wh => isPrincipalWebhook(wh.nome)) ? '' : 'Principal');
                    setShowCreateModal(true);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px', border: 'none', background: '#3b82f6', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
                >
                  <Plus style={{ width: '13px', height: '13px' }} />
                  Criar novo webhook
                </button>
                {showWebhookUpgrade && (
                  <UpgradeModal
                    feature="webhooksIlimitados"
                    planoNecessario="Starter"
                    onClose={() => setShowWebhookUpgrade(false)}
                  />
                )}
              </div>

              {loadingWebhooks ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {[1, 2].map(i => (
                    <div key={i} style={{ height: '108px', borderRadius: '12px', background: dark ? '#18181b' : '#f8fafc', border: `1px solid ${border}`, animation: 'wh-pulse 1.5s ease-in-out infinite' }} />
                  ))}
                </div>
              ) : webhooks.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', background: dark ? '#111113' : '#fff', border: `1px solid ${border}`, borderRadius: '12px' }}>
                  <p style={{ fontSize: '13px', color: txtMid, margin: 0 }}>Nenhum webhook. Clique em "Criar novo webhook" para começar.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {webhooks.map(wh => {
                    const whUrl = getWebhookUrl(wh.nome, wh.token);
                    const isEditing  = editingId === wh.id;
                    const isCopied   = copiedId === wh.id;
                    const isToggling = togglingId === wh.id;

                    return (
                      <div
                        key={wh.id}
                        style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: '12px', overflow: 'hidden' }}
                      >
                        <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                            {isEditing ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
                                <input
                                  value={editNome}
                                  onChange={e => setEditNome(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveEditNome(wh.id); if (e.key === 'Escape') setEditingId(null); }}
                                  autoFocus
                                  style={{ ...inputStyle, height: '32px', padding: '0 10px', fontSize: '14px', fontWeight: 600, flex: 1 }}
                                />
                                <button onClick={() => saveEditNome(wh.id)} style={{ width: '28px', height: '28px', borderRadius: '7px', border: 'none', background: '#10b981', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <Check style={{ width: '12px', height: '12px' }} />
                                </button>
                                <button onClick={() => setEditingId(null)} style={{ width: '28px', height: '28px', borderRadius: '7px', border: `1px solid ${border}`, background: 'transparent', color: txtMid, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                  <X style={{ width: '12px', height: '12px' }} />
                                </button>
                              </div>
                            ) : (
                              <span style={{ fontSize: '15px', fontWeight: 600, color: txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wh.nome}</span>
                            )}
                          </div>

                          <button
                            onClick={() => !isToggling && toggleWebhook(wh)}
                            disabled={isToggling}
                            title={wh.ativo ? 'Pausar' : 'Ativar'}
                            style={{
                              flexShrink: 0, width: '36px', height: '20px', borderRadius: '99px', border: 'none',
                              background: wh.ativo ? '#10b981' : (dark ? '#3f3f46' : '#d1d5db'),
                              position: 'relative', cursor: 'pointer',
                              transition: 'background 0.2s', opacity: isToggling ? 0.6 : 1,
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: '2px', left: wh.ativo ? '18px' : '2px',
                              width: '16px', height: '16px', borderRadius: '50%',
                              background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                            }} />
                          </button>
                        </div>

                        <div style={{ padding: '0 16px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: urlBg, border: `1px solid ${border}`, borderRadius: '9px', padding: '9px 12px' }}>
                            <span style={{ flex: 1, fontSize: '12px', color: txtMid, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                              {whUrl}
                            </span>
                            <button
                              onClick={() => copyWebhookUrl(wh.id, wh.token, wh.nome)}
                              style={{
                                flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px',
                                padding: '4px 10px', borderRadius: '6px',
                                border: `1px solid ${isCopied ? '#10b981' : border}`,
                                background: isCopied ? (dark ? 'rgba(16,185,129,0.1)' : '#f0fdf4') : (dark ? '#18181b' : '#fff'),
                                color: isCopied ? '#10b981' : txtMid,
                                fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: FONT,
                                transition: 'all 0.15s',
                              }}
                            >
                              {isCopied
                                ? <><CheckCircle2 style={{ width: '12px', height: '12px' }} /> Copiado!</>
                                : <><Copy style={{ width: '12px', height: '12px' }} /> Copiar</>
                              }
                            </button>
                          </div>
                        </div>

                        <div style={{ padding: '10px 16px', borderTop: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.05)'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '12px', color: dark ? '#52525b' : '#9ca3af' }}>
                            Criado em {fmtData(wh.created_at)}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {!isEditing && !isPrincipalWebhook(wh.nome) && (
                              <button
                                onClick={() => { setEditingId(wh.id); setEditNome(wh.nome); }}
                                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '7px', border: `1px solid ${border}`, background: 'transparent', color: txtMid, fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: FONT }}
                              >
                                <Pencil style={{ width: '11px', height: '11px' }} />
                                Editar nome
                              </button>
                            )}
                            {!isPrincipalWebhook(wh.nome) && (
                              <button
                                onClick={() => setDeleteId(wh.id)}
                                title="Excluir webhook"
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '5px',
                                  padding: '5px 10px', borderRadius: '7px',
                                  border: '1px solid rgba(239,68,68,0.3)',
                                  background: 'transparent', color: '#ef4444',
                                  fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: FONT,
                                }}
                              >
                                <Trash2 style={{ width: '11px', height: '11px' }} />
                                Excluir
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Régua de pontuação */}
            <div style={sectionCard}>
              <div style={{ padding: '16px 20px', borderBottom: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.06)'}`, background: dark ? '#18181b' : '#fafafa', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Settings style={{ width: '16px', height: '16px', color: '#f59e0b' }} />
                <span style={{ fontSize: '14px', fontWeight: 600, color: txt }}>Régua de pontuação</span>
              </div>
              <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ padding: '14px 16px', background: dark ? '#18181b' : '#f8fafc', borderRadius: '12px', border: `1px solid ${border}` }}>
                  <p style={{ fontSize: '13px', color: txtMid, margin: 0, lineHeight: 1.6 }}>
                    Quando um lead chega pelo webhook, o sistema precisa saber se ela entra como
                    <span style={{ color: '#10b981', fontWeight: 700 }}> Verde</span> (prioridade alta) ou
                    <span style={{ color: '#f59e0b', fontWeight: 700 }}> Amarela</span> (prioridade normal),
                    baseado na pontuação que o quiz dela mandou. Defina aqui qual pontuação mínima
                    vale cada cor — você pode ajustar quando quiser.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                  <div>
                    <p style={{ fontSize: '14px', fontWeight: 600, color: txt, margin: '0 0 4px' }}>Usar pontuação do quiz externo</p>
                    <p style={{ fontSize: '13px', color: txtMid, margin: 0 }}>
                      {usaQuizExterno ? 'Ativo — os cortes abaixo estão sendo usados para classificar os leads.' : 'Inativo — os cortes são definidos dentro do Quiz Builder do Floow.'}
                    </p>
                  </div>
                  <button onClick={() => setUsaQuizExterno(v => !v)}
                    style={{ width: '44px', height: '24px', borderRadius: '999px', border: 'none', background: usaQuizExterno ? '#0044fd' : (dark ? '#3f3f46' : '#d1d5db'), cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}>
                    <span style={{ position: 'absolute', top: '3px', left: usaQuizExterno ? '23px' : '3px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
                  </button>
                </div>
                {usaQuizExterno && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      <div style={{ padding: '16px', background: dark ? '#18181b' : '#f0fdf4', borderRadius: '12px', border: `1px solid ${dark ? border : '#bbf7d0'}` }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: '#10b981', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>🟢 Verde — pontuação mínima</label>
                        <input type="number" min={1} max={200} value={scoreVerde} onChange={e => setScoreVerde(Number(e.target.value))}
                          style={{ width: '100%', padding: '10px 12px', borderRadius: '9px', border: `1px solid ${dark ? '#3f3f46' : '#bbf7d0'}`, background: dark ? '#111113' : '#fff', color: txt, fontSize: '20px', fontWeight: 700, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', textAlign: 'center' }} />
                        <p style={{ fontSize: '12px', color: txtMid, margin: '8px 0 0', textAlign: 'center' }}>{scoreVerde} pontos ou mais → Verde</p>
                      </div>
                      <div style={{ padding: '16px', background: dark ? '#18181b' : '#fffbeb', borderRadius: '12px', border: `1px solid ${dark ? border : '#fde68a'}` }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: '#f59e0b', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>🟡 Amarelo — pontuação mínima</label>
                        <input type="number" min={1} max={200} value={scoreAmarelo} onChange={e => setScoreAmarelo(Number(e.target.value))}
                          style={{ width: '100%', padding: '10px 12px', borderRadius: '9px', border: `1px solid ${dark ? '#3f3f46' : '#fde68a'}`, background: dark ? '#111113' : '#fff', color: txt, fontSize: '20px', fontWeight: 700, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', textAlign: 'center' }} />
                        <p style={{ fontSize: '12px', color: txtMid, margin: '8px 0 0', textAlign: 'center' }}>Entre {scoreAmarelo} e {scoreVerde - 1} pontos → Amarelo</p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', background: dark ? 'rgba(255,42,76,0.08)' : '#fff1f2', border: `1px solid ${dark ? 'rgba(255,42,76,0.2)' : '#fecaca'}`, borderRadius: '10px' }}>
                      <span style={{ fontSize: '18px' }}>🔴</span>
                      <span style={{ fontSize: '13px', color: dark ? '#f87171' : '#dc2626', lineHeight: 1.5 }}>
                        Abaixo de <strong>{scoreAmarelo}</strong> pontos → lead não entra no sistema (reprovada no quiz)
                      </span>
                    </div>
                  </div>
                )}
                <button onClick={handleSaveScore} disabled={savingScore}
                  style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 20px', borderRadius: '9px', border: 'none', background: '#0044fd', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: savingScore ? 'default' : 'pointer', opacity: savingScore ? 0.7 : 1, fontFamily: 'inherit' }}>
                  <Save style={{ width: '13px', height: '13px' }} />
                  {savingScore ? 'Salvando…' : 'Salvar régua'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Aba 2: Saúde e Fila ──────────────────────────────────── */}
        {activeAba === 'health' && orgId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <IngestionHealth orgId={orgId} />

            {/* Logs de Webhooks Recentes */}
            <div style={{ marginTop: '16px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 600, color: txt, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                Logs de Webhooks Recentes
              </h3>
              <div style={{ border: `1px solid ${border}`, borderRadius: '12px', overflow: 'hidden', background: cardBg }}>
                {logs.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px', color: txtMid }}>
                    Nenhum log de webhook registrado para esta organização.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '350px', overflowY: 'auto' }}>
                    {logs.map((log) => {
                      const isSuccess = log.status === 'success' || log.status === 'received';
                      return (
                        <div
                          key={log.id}
                          style={{
                            padding: '12px 16px',
                            borderBottom: `1px solid ${border}`,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: '12.5px',
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontWeight: 700, color: isSuccess ? '#10b981' : '#ef4444' }}>
                                {log.event_type}
                              </span>
                              <span style={{ fontSize: '11px', color: txtMid, padding: '1px 5px', borderRadius: '4px', background: dark ? '#27272a' : '#f4f4f5' }}>
                                {log.status}
                              </span>
                            </div>
                            <span style={{ color: txtMid, fontSize: '11.5px', fontFamily: 'monospace' }}>
                              {log.payload?.error ? String(log.payload.error) : (log.payload?.lead_id ? `Lead ID: ${log.payload.lead_id}` : (log.payload?.stage ? `Etapa: ${log.payload.stage}` : ''))}
                            </span>
                          </div>
                          <span style={{ color: txtMid, fontSize: '11px' }}>
                            {new Date(log.created_at).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Aba 3: Reconciliação CSV ────────────────────────────── */}
        {activeAba === 'reconcile' && orgId && (
          <LeadReconciliation orgId={orgId} />
        )}

        {/* ── Create Modal ───────────────────────────────────────── */}
        {showCreateModal && (
          <div onClick={() => setShowCreateModal(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: cardBg, borderRadius: '18px', border: `1px solid ${dark ? '#27272a' : 'rgba(0,0,0,0.08)'}`, width: '100%', maxWidth: '400px', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
              <div style={{ padding: '20px', borderBottom: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.06)'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: txt, margin: 0 }}>Novo webhook</h3>
                <button onClick={() => setShowCreateModal(false)} style={{ width: '28px', height: '28px', borderRadius: '7px', border: 'none', background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)', color: txtMid, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <X style={{ width: '13px', height: '13px' }} />
                </button>
              </div>
              <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{ fontSize: '11px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: '6px' }}>Nome do webhook</label>
                  <input
                    value={newNome}
                    onChange={e => setNewNome(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && newNome.trim()) createWebhook(); }}
                    placeholder="Ex: Pós-Webinar Becker"
                    autoFocus
                    style={inputStyle}
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px', paddingTop: '4px' }}>
                  <button onClick={() => setShowCreateModal(false)}
                    style={{ flex: 1, padding: '10px', borderRadius: '9px', border: `1px solid ${border}`, background: 'transparent', color: txtMid, fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                    Cancelar
                  </button>
                  <button onClick={createWebhook} disabled={creating || !newNome.trim()}
                    style={{ flex: 1, padding: '10px', borderRadius: '9px', border: 'none', background: creating || !newNome.trim() ? (dark ? '#27272a' : '#e5e7eb') : '#3b82f6', color: creating || !newNome.trim() ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: creating || !newNome.trim() ? 'default' : 'pointer', fontFamily: FONT, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                    {creating
                      ? <><span style={{ width: '12px', height: '12px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'wh-spin 0.7s linear infinite', display: 'inline-block' }} /> Criando…</>
                      : 'Criar webhook'
                    }
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Delete Confirmation Modal ──────────────────────────── */}
        {deleteId && (
          <div onClick={() => setDeleteId(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: cardBg, borderRadius: '18px', border: `1px solid ${dark ? '#27272a' : 'rgba(0,0,0,0.08)'}`, width: '100%', maxWidth: '340px', padding: '28px 24px', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
              <div style={{ fontSize: '28px', marginBottom: '14px' }}>🗑️</div>
              <h3 style={{ fontSize: '15px', fontWeight: 700, color: txt, margin: '0 0 8px' }}>Excluir webhook?</h3>
              <p style={{ fontSize: '13px', color: txtMid, margin: '0 0 22px', lineHeight: 1.55 }}>
                Integrações usando esta URL vão parar de funcionar imediatamente.
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => setDeleteId(null)}
                  style={{ flex: 1, padding: '10px', borderRadius: '9px', border: `1px solid ${border}`, background: 'transparent', color: txtMid, fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                  Cancelar
                </button>
                <button onClick={() => deleteWebhook(deleteId)}
                  style={{ flex: 1, padding: '10px', borderRadius: '9px', border: 'none', background: '#ef4444', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                  Excluir
                </button>
              </div>
            </div>
          </div>
        )}

        <style>{`
          @keyframes wh-spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
          @keyframes wh-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        `}</style>

      </div>
    </AppLayout>
  );
}
