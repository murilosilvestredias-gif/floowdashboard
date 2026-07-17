import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useTheme } from '@/hooks/useTheme';
import { toast } from 'sonner';
import { setAdminViewingOrg, clearAdminViewingOrg } from '@/hooks/useOrgId';
import { invalidateSubscriptionCache } from '@/components/ProtectedRoute';
import { invalidatePlanCache } from '@/hooks/usePlanFeatures';

const ADMIN_EMAIL = 'admin@floow.com';
const SUPERADMIN_USER_ID = '1d4eee3a-854b-416c-8934-35d1312c4390';
const EDGE_URL = 'https://obguidmfvfjaekaskgob.functions.supabase.co/criar-org';
const WEBHOOK_BASE = 'https://obguidmfvfjaekaskgob.functions.supabase.co/receber-lead';
const ATUALIZAR_USUARIO_URL = 'https://obguidmfvfjaekaskgob.functions.supabase.co/atualizar-usuario';
const DELETAR_USUARIO_URL = 'https://obguidmfvfjaekaskgob.functions.supabase.co/deletar-usuario';
const CRIAR_GESTOR_URL = 'https://obguidmfvfjaekaskgob.functions.supabase.co/criar-gestor';
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, sans-serif';

const PLANOS = ['gratuito', 'starter', 'pro', 'enterprise'];
const PLANO_LABELS: Record<string, string> = { basic: 'Gratuito', gratuito: 'Gratuito', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };
const STATUS_ORG = ['ativo', 'inadimplente', 'suspenso', 'cancelado'] as const;
type OrgStatus = typeof STATUS_ORG[number];

interface Org {
  id: string;
  nome: string;
  email_admin: string;
  plano: string;
  created_at: string;
  status: OrgStatus;
  sub_id?: string;
}

export default function AdminPage() {
  const { user, loading: authLoading } = useAuth();
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const navigate = useNavigate();

  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Create modal state ────────────────────────────────────────
  const [showModal, setShowModal] = useState(false);
  const [modalNome, setModalNome] = useState('');
  const [modalEmail, setModalEmail] = useState('');
  const [modalSenha, setModalSenha] = useState('');
  const [modalPlano, setModalPlano] = useState('gratuito');
  const [creating, setCreating] = useState(false);

  // ── Edit modal state ──────────────────────────────────────────
  const [editOrg, setEditOrg] = useState<Org | null>(null);
  const [editPlano, setEditPlano] = useState('gratuito');
  const [editStatus, setEditStatus] = useState<OrgStatus>('ativo');
  const [editEmail, setEditEmail] = useState('');
  const [editSenha, setEditSenha] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // ── Credentials modal state ───────────────────────────────────
  const [showCreds, setShowCreds] = useState(false);
  const [credsData, setCredsData] = useState<{ email: string; orgId: string; webhookUrl: string } | null>(null);
  const [credsLoading, setCredsLoading] = useState(false);

  // ── Delete modal state ────────────────────────────────────────
  const [deleteOrg, setDeleteOrg] = useState<Org | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── Abas ──────────────────────────────────────────────────────
  const [aba, setAba] = useState<'dashboard'|'empresas'|'gestores'|'contabilidade'>('dashboard');

  // ── Gestor state ──────────────────────────────────────────────
  const [gestores, setGestores] = useState<any[]>([]);
  const [showModalGestor, setShowModalGestor] = useState(false);
  const [modalGestorNome, setModalGestorNome] = useState('');
  const [modalGestorEmail, setModalGestorEmail] = useState('');
  const [modalGestorSenha, setModalGestorSenha] = useState('');
  const [creatingGestor, setCreatingGestor] = useState(false);
  const [designarGestor, setDesignarGestor] = useState<any|null>(null);
  const [gestorOrgsIds, setGestorOrgsIds] = useState<string[]>([]);
  const [savingDesignar, setSavingDesignar] = useState(false);

  // ── Dashboard state ───────────────────────────────────────────
  const [dashPeriodo, setDashPeriodo] = useState<'mes'|'trimestre'|'ano'>('mes');
  const [dashData, setDashData] = useState<any>(null);
  const [dashLoading, setDashLoading] = useState(false);

  // ── Contabilidade state ───────────────────────────────────────
  const [contas, setContas] = useState<any[]>([]);
  const [contaLoading, setContaLoading] = useState(false);
  const [showModalConta, setShowModalConta] = useState(false);
  const [contaTipo, setContaTipo] = useState<'custo'|'receita'>('custo');
  const [contaDescricao, setContaDescricao] = useState('');
  const [contaValor, setContaValor] = useState('');
  const [contaCategoria, setContaCategoria] = useState('');
  const [contaData, setContaData] = useState(new Date().toISOString().split('T')[0]);
  const [savingConta, setSavingConta] = useState(false);

  // ── Guard ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!authLoading && (!user || user.email !== ADMIN_EMAIL)) navigate('/');
  }, [user, authLoading]);

  // ── Fetch orgs ────────────────────────────────────────────────
  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return;
    fetchOrgs();
    fetchGestores();
    fetchContabilidade();
  }, [user]);

  useEffect(() => {
    if (!user || user.email !== ADMIN_EMAIL) return;
    fetchDashboard();
  }, [user, dashPeriodo]);

  async function fetchOrgs() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('*, subscriptions(id)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const merged: Org[] = (data || []).map((org: any) => {
        const sub = org.subscriptions?.[0] || null;
        return {
          id: org.id,
          nome: org.nome || '—',
          email_admin: org.email_admin || '—',
          plano: org.plano || 'gratuito',
          created_at: org.created_at,
          status: (org.status as OrgStatus) || (org.ativo !== false ? 'ativo' : 'suspenso'),
          sub_id: sub?.id || null,
        };
      });
      setOrgs(merged);
    } catch {
      toast.error('Erro ao carregar dados');
    }
    setLoading(false);
  }

  // ── Gestores ──────────────────────────────────────────────────
  async function fetchGestores() {
    const { data } = await supabase.from('gestores').select('*').order('created_at', { ascending: false });
    if (!data) return;
    const comOrgs = await Promise.all(data.map(async (g: any) => {
      const { count } = await supabase.from('gestor_orgs').select('*', { count: 'exact', head: true }).eq('gestor_user_id', g.user_id);
      return { ...g, total_orgs: count || 0 };
    }));
    setGestores(comOrgs);
  }

  async function handleCreateGestor() {
    if (!modalGestorNome || !modalGestorEmail || !modalGestorSenha) {
      toast.error('Preencha todos os campos');
      return;
    }
    if (modalGestorSenha.length < 8) {
      toast.error('Senha deve ter no mínimo 8 caracteres');
      return;
    }
    setCreatingGestor(true);
    try {
      const res = await fetch(CRIAR_GESTOR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: modalGestorNome, email: modalGestorEmail, senha: modalGestorSenha }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast.error(data.erro || 'Erro ao criar gestor');
        setCreatingGestor(false);
        return;
      }
      toast.success(`Gestor ${modalGestorNome} criado!`);
      setShowModalGestor(false);
      setModalGestorNome(''); setModalGestorEmail(''); setModalGestorSenha('');
      fetchGestores();
    } catch {
      toast.error('Erro de conexão');
    }
    setCreatingGestor(false);
  }

  async function abrirDesignarOrgs(g: any) {
    setDesignarGestor(g);
    const { data } = await supabase.from('gestor_orgs').select('org_id').eq('gestor_user_id', g.user_id);
    setGestorOrgsIds((data || []).map((x: any) => x.org_id));
  }

  async function salvarDesignarOrgs() {
    if (!designarGestor) return;
    setSavingDesignar(true);
    await supabase.from('gestor_orgs').delete().eq('gestor_user_id', designarGestor.user_id);
    if (gestorOrgsIds.length > 0) {
      await supabase.from('gestor_orgs').insert(gestorOrgsIds.map(org_id => ({ gestor_user_id: designarGestor.user_id, org_id })));
    }
    toast.success('Empresas designadas!');
    setSavingDesignar(false); setDesignarGestor(null); fetchGestores();
  }

  async function toggleGestorAtivo(g: any) {
    await supabase.from('gestores').update({ ativo: !g.ativo }).eq('id', g.id);
    fetchGestores();
  }

  // ── Dashboard ─────────────────────────────────────────────────
  async function fetchDashboard() {
    setDashLoading(true);
    const now = new Date();
    let start: Date;
    if (dashPeriodo === 'mes') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (dashPeriodo === 'trimestre') {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
    } else {
      start = new Date(now.getFullYear(), 0, 1);
    }
    const startStr = start.toISOString().split('T')[0];

    const TICKETS: Record<string, number> = { gratuito: 0, starter: 497, pro: 997, enterprise: 0 };

    const { data: orgsData } = await supabase
      .from('organizations')
      .select('id, plano, status, ativo, created_at, ravena_ativa');
    const { count: totalLeads } = await supabase
      .from('leads').select('*', { count: 'exact', head: true });
    const { count: ravenaCount } = await supabase
      .from('organizations').select('*', { count: 'exact', head: true }).eq('ravena_ativa', true);
    const { data: custosPeriodo } = await supabase
      .from('contabilidade' as any).select('valor').eq('tipo', 'custo').gte('data', startStr);

    const all = orgsData || [];
    const ativas = all.filter((o: any) => (o.status || (o.ativo !== false ? 'ativo' : 'suspenso')) === 'ativo');
    const canceladas = all.filter((o: any) => (o.status || '') === 'cancelado');
    const novos = all.filter((o: any) => new Date(o.created_at) >= start);

    const mrr = ativas
      .filter((o: any) => (o.plano || 'gratuito') !== 'gratuito')
      .reduce((s: number, o: any) => s + (TICKETS[o.plano] || 497), 0);
    const totalCustos = ((custosPeriodo as any[]) || []).reduce((s: number, c: any) => s + Number(c.valor), 0);
    const lucro = mrr - totalCustos;
    const churn = ativas.length + canceladas.length > 0
      ? Math.round((canceladas.length / (ativas.length + canceladas.length)) * 100) : 0;

    setDashData({
      mrr, lucro, ativas: ativas.length, churn,
      novos: novos.length, totalLeads: totalLeads || 0,
      ravenaAtiva: ravenaCount || 0,
    });
    setDashLoading(false);
  }

  // ── Contabilidade ─────────────────────────────────────────────
  async function fetchContabilidade() {
    setContaLoading(true);
    const { data } = await supabase
      .from('contabilidade' as any)
      .select('*')
      .order('data', { ascending: false });
    setContas((data as any[]) || []);
    setContaLoading(false);
  }

  async function handleSaveConta() {
    if (!contaDescricao || !contaValor || !contaCategoria) {
      toast.error('Preencha todos os campos');
      return;
    }
    setSavingConta(true);
    const { error } = await supabase.from('contabilidade' as any).insert({
      descricao: contaDescricao,
      categoria: contaCategoria || 'Outros',
      tipo: contaTipo,
      valor: parseFloat(contaValor.replace(',', '.')),
      data: contaData || new Date().toISOString().slice(0, 10),
    });
    if (error) {
      toast.error('Erro ao salvar: ' + error.message);
    } else {
      toast.success('Lançamento salvo!');
      setShowModalConta(false);
      setContaDescricao(''); setContaValor(''); setContaCategoria('');
      setContaTipo('custo'); setContaData(new Date().toISOString().split('T')[0]);
      fetchContabilidade();
      fetchDashboard();
    }
    setSavingConta(false);
  }

  async function handleDeleteConta(id: string) {
    await supabase.from('contabilidade' as any).delete().eq('id', id);
    toast.success('Lançamento excluído');
    fetchContabilidade();
    fetchDashboard();
  }

  // ── Create org ────────────────────────────────────────────────
  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      // 1. Cria usuário + org via edge function
      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome_empresa: modalNome, email: modalEmail, senha: modalSenha }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast.error(data.erro || 'Erro ao criar cliente'); setCreating(false); return; }

      // 2. Busca org recém-criada pelo email
      const { data: newOrg } = await supabase
        .from('organizations')
        .select('id')
        .eq('email_admin', modalEmail)
        .single();

      if (newOrg?.id) {
        // 3. Atualiza plano e status na org
        await supabase.from('organizations').update({ plano: modalPlano, status: 'ativo', ativo: true }).eq('id', newOrg.id);

        const { data: existingSuperadmin } = await supabase
          .from('memberships')
          .select('id')
          .eq('org_id', newOrg.id)
          .eq('user_id', SUPERADMIN_USER_ID)
          .maybeSingle();

        if (existingSuperadmin == null) {
          await supabase.from('memberships').insert({
            org_id: newOrg.id,
            user_id: SUPERADMIN_USER_ID,
            role: 'superadmin',
          });
        }

        // 4. Cria webhook Principal automaticamente
        const webhookToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        await (supabase as any).from('webhooks').insert({
          org_id: newOrg.id,
          nome: 'Principal',
          token: webhookToken,
          ativo: true,
        });
      }

      toast.success(`"${modalNome}" criada com sucesso!`);
      setShowModal(false);
      setModalNome(''); setModalEmail(''); setModalSenha('');
      setModalPlano('starter');
      fetchOrgs();
    } catch { toast.error('Erro de conexão'); }
    setCreating(false);
  }

  // ── Edit org ──────────────────────────────────────────────────
  function openEdit(org: Org) {
    setEditOrg(org);
    setEditPlano(org.plano || 'gratuito');
    setEditStatus(org.status || 'ativo');
    setEditEmail('');
    setEditSenha('');
  }

  async function handleVerCreds(org: Org) {
    setCredsData(null);
    setShowCreds(true);
    setCredsLoading(true);
    const { data } = await supabase
      .from('configuracoes_whatsapp')
      .select('webhook_token')
      .eq('org_id', org.id)
      .limit(1)
      .single();
    const token = (data as any)?.webhook_token || '';
    setCredsData({
      email: org.email_admin,
      orgId: org.id,
      webhookUrl: token ? `${WEBHOOK_BASE}?token=${token}` : '—',
    });
    setCredsLoading(false);
  }

  async function handleUpdateUser() {
    if (!editOrg) return;
    if (!editEmail && !editSenha) return;
    if (editSenha && editSenha.length < 8) {
      toast.error('Senha deve ter no mínimo 8 caracteres');
      return;
    }
    const { data: membership } = await supabase
      .from('memberships')
      .select('user_id')
      .eq('org_id', editOrg.id)
      .maybeSingle();
    if (!membership?.user_id) {
      toast.error('Usuário não encontrado para essa org');
      return;
    }
    const body: any = { user_id: membership.user_id };
    if (editEmail) body.email = editEmail;
    if (editSenha) body.password = editSenha;
    const res = await fetch(ATUALIZAR_USUARIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error(data.erro || 'Erro ao atualizar usuário');
    } else {
      toast.success('Dados de acesso atualizados!');
      if (editEmail) {
        await supabase
          .from('organizations')
          .update({ email_admin: editEmail })
          .eq('id', editOrg.id);
      }
    }
  }

  async function handleEditSave() {
    if (!editOrg) return;
    setEditSaving(true);
    try {
      // 1. Salva plano + status (ativo boolean fica em sync)
      const ativo = editStatus === 'ativo';
      await supabase.from('organizations').update({ plano: editPlano, status: editStatus, ativo }).eq('id', editOrg.id);
      invalidateSubscriptionCache();
      invalidatePlanCache(editOrg.id);
      toast.success('Atualizado!');

      // 2. Atualiza credenciais se preenchidas
      if (editEmail || editSenha) {
        await handleUpdateUser();
      }

      fetchOrgs();
    } catch {
      toast.error('Erro ao salvar');
    } finally {
      setEditSaving(false);
      setEditOrg(null);
    }
  }

  // ── Delete org ────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteOrg || deleteConfirm !== deleteOrg.nome) return;
    setDeleteLoading(true);
    try {
      // 0. Busca o user_id da membership
      const { data: membership } = await supabase
        .from('memberships' as any)
        .select('user_id')
        .eq('org_id', deleteOrg.id)
        .maybeSingle();

      // 1. Deleta o usuário do Auth
      if ((membership as any)?.user_id) {
        await fetch(DELETAR_USUARIO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: (membership as any).user_id }),
        });
      }

      // 2. Deleta os dados (ordem importa por causa das foreign keys)
      await supabase.from('subscriptions').delete().eq('org_id', deleteOrg.id);
      await supabase.from('ai_optimization_logs' as any).delete().eq('org_id', deleteOrg.id);
      await supabase.from('webhook_logs').delete().eq('org_id', deleteOrg.id);
      await supabase.from('leads').delete().eq('org_id', deleteOrg.id);
      await supabase.from('configuracoes_whatsapp').delete().eq('org_id', deleteOrg.id);
      await supabase.from('memberships' as any).delete().eq('org_id', deleteOrg.id);
      await supabase.from('organizations' as any).delete().eq('id', deleteOrg.id);
      toast.success(`Empresa "${deleteOrg.nome}" excluída com sucesso`);
      setDeleteOrg(null);
      setDeleteConfirm('');
      fetchOrgs();
    } catch {
      toast.error('Erro ao excluir');
    }
    setDeleteLoading(false);
  }

  // ── Actions ───────────────────────────────────────────────────
  function handleAcessar(org: Org) {
    localStorage.setItem('admin_viewing_org',      org.id);
    localStorage.setItem('admin_viewing_org_nome', org.nome);
    window.location.href = '/'; // reload completo: todos os hooks lêem o localStorage fresco
  }

  async function handleSignOut() {
    clearAdminViewingOrg();
    await supabase.auth.signOut();
    navigate('/login');
  }

  if (authLoading || (!user && !authLoading)) return null;
  if (user?.email !== ADMIN_EMAIL) return null;

  // ── Métricas ──────────────────────────────────────────────────
  const total = orgs.length;
  const ativas = orgs.filter(o => o.status === 'ativo').length;
  const TICKET: Record<string, number> = { gratuito: 0, starter: 497, pro: 997, enterprise: 0 };
  const mrr = orgs
    .filter(o => o.status === 'ativo' && (o.plano || 'gratuito') !== 'gratuito')
    .reduce((s, o) => s + (TICKET[o.plano] || 497), 0)
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // ── Estilos ───────────────────────────────────────────────────
  const bg = dark ? '#090909' : '#f4f4f5';
  const card = { background: dark ? '#111113' : '#fff', border: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.08)'}`, borderRadius: '16px', padding: '20px 24px' } as React.CSSProperties;
  const txt = dark ? '#f4f4f5' : '#111827';
  const txtMid = dark ? '#a1a1aa' : '#6b7280';
  const inp: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: dark ? '#0d0d0f' : '#f8fafc', color: txt, fontSize: '13px', outline: 'none', fontFamily: FONT, boxSizing: 'border-box' };
  const lbl: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: '5px' };

  function StatusBadge({ status }: { status?: string | null }) {
    const map: Record<string, { label: string; color: string; bg: string }> = {
      ativo:        { label: 'Ativo',        color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
      inadimplente: { label: 'Inadimplente', color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
      suspenso:     { label: 'Suspenso',     color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
      cancelado:    { label: 'Cancelado',    color: '#6b7280', bg: 'rgba(107,114,128,0.12)' },
    };
    const s = map[status || ''] || { label: status || '—', color: '#71717a', bg: 'rgba(113,113,122,0.12)' };
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 9px', borderRadius: '99px', background: s.bg, fontSize: '11.5px', fontWeight: 600, color: s.color }}>
        <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: s.color }} />
        {s.label}
      </span>
    );
  }

  function fmtDate(dateStr?: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('pt-BR');
  }

  // ── Shared modal styles ───────────────────────────────────────
  const modalBox: React.CSSProperties = {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    zIndex: 61, width: '90%', maxWidth: '400px',
    background: dark ? '#111113' : '#fff',
    border: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.08)'}`,
    borderRadius: '18px', padding: '24px',
    boxShadow: '0 24px 60px rgba(0,0,0,0.4)', fontFamily: FONT,
    maxHeight: '90vh', overflowY: 'auto',
  };
  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 60,
    background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
  };

  return (
    <div style={{ minHeight: '100vh', background: bg, fontFamily: FONT }}>

      {/* Header fixo */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, height: '56px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', background: dark ? 'rgba(9,9,9,0.92)' : 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)', borderBottom: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.08)'}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '26px', height: '26px', borderRadius: '7px', background: 'linear-gradient(135deg, #10b981, #3b82f6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
          </div>
          <span style={{ fontSize: '15px', fontWeight: 700, color: txt, letterSpacing: '-0.02em' }}>Floow CRM</span>
          <span style={{ fontSize: '11px', fontWeight: 500, color: '#10b981', background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: '99px', marginLeft: '4px' }}>Admin</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '12.5px', color: txtMid }}>{user?.email}</span>
          <button onClick={handleSignOut} style={{ padding: '6px 14px', borderRadius: '8px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '12.5px', cursor: 'pointer', fontFamily: FONT, transition: 'color 0.15s' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={e => (e.currentTarget.style.color = txtMid)}>
            Sair
          </button>
        </div>
      </div>

      {/* Conteúdo */}
      <div style={{ paddingTop: '56px' }}>
        <div style={{ padding: '32px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h1 style={{ fontSize: '22px', fontWeight: 700, color: txt, margin: 0, letterSpacing: '-0.03em' }}>Painel Admin</h1>
              <p style={{ fontSize: '13px', color: txtMid, margin: '3px 0 0' }}>Gerenciamento de clientes do Floow CRM</p>
            </div>
            {aba === 'empresas' && (
              <button onClick={() => setShowModal(true)}
                style={{ padding: '9px 18px', borderRadius: '10px', border: 'none', background: '#10b981', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                + Novo cliente
              </button>
            )}
            {aba === 'contabilidade' && (
              <button onClick={() => setShowModalConta(true)}
                style={{ padding: '9px 18px', borderRadius: '10px', border: 'none', background: '#2563eb', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                + Novo lançamento
              </button>
            )}
          </div>

          {/* Abas */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: `1px solid ${dark ? '#1e1e22' : '#e5e7eb'}`, overflowX: 'auto' }}>
            {([
              { key: 'dashboard',      label: '📊 Dashboard' },
              { key: 'empresas',       label: '🏢 Empresas' },
              { key: 'gestores',       label: '👥 Gestores' },
              { key: 'contabilidade',  label: '💰 Contabilidade' },
            ] as const).map(a => (
              <button key={a.key} onClick={() => setAba(a.key)} style={{
                padding: '8px 16px', border: 'none', background: 'transparent',
                color: aba === a.key ? '#2563eb' : txtMid,
                borderBottom: `2px solid ${aba === a.key ? '#2563eb' : 'transparent'}`,
                fontSize: '13px', fontWeight: aba === a.key ? 600 : 400,
                cursor: 'pointer', fontFamily: FONT, marginBottom: '-1px',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
              }}>{a.label}</button>
            ))}
          </div>

          {aba === 'empresas' && (<>
          {/* Cards métricas */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '24px' }}>
            {[
              { label: 'Total de orgs', value: String(total), color: '#3b82f6' },
              { label: 'Ativas', value: String(ativas), color: '#10b981' },
              { label: 'MRR estimado', value: mrr, color: '#a855f7' },
            ].map(m => (
              <div key={m.label} style={card}>
                <p style={{ fontSize: '11px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 6px' }}>{m.label}</p>
                <p style={{ fontSize: '22px', fontWeight: 700, color: m.color, margin: 0, letterSpacing: '-0.03em' }}>{m.value}</p>
              </div>
            ))}
          </div>

          {/* Tabela */}
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.06)'}`, background: dark ? '#18181b' : '#fafafa' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: txt }}>Clientes</span>
            </div>
            {loading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: txtMid, fontSize: '13px' }}>Carregando…</div>
            ) : orgs.length === 0 ? (
              <div style={{ padding: '40px', textAlign: 'center', color: txtMid, fontSize: '13px' }}>Nenhum cliente ainda</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: dark ? '#18181b' : '#f8fafc' }}>
                      {['Empresa', 'Email admin', 'Plano', 'Status', 'Criado em', ''].map(h => (
                        <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '10.5px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.map((org, i) => (
                      <tr key={org.id} style={{ borderTop: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.05)'}`, background: i % 2 === 0 ? 'transparent' : (dark ? 'rgba(255,255,255,0.01)' : 'rgba(0,0,0,0.01)') }}>
                        <td style={{ padding: '12px 16px', color: txt, fontWeight: 500, whiteSpace: 'nowrap' }}>{org.nome}</td>
                        <td style={{ padding: '12px 16px', color: txtMid, whiteSpace: 'nowrap' }}>{org.email_admin}</td>
                        <td style={{ padding: '12px 16px', color: txtMid, whiteSpace: 'nowrap' }}>{PLANO_LABELS[org.plano] ?? org.plano}</td>
                        <td style={{ padding: '12px 16px' }}><StatusBadge status={org.status} /></td>
                        <td style={{ padding: '12px 16px', color: txtMid, whiteSpace: 'nowrap', fontSize: '12px' }}>{fmtDate(org.created_at)}</td>
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button onClick={() => handleVerCreds(org)}
                              style={{ padding: '5px 10px', borderRadius: '7px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: FONT }}>
                              Credenciais
                            </button>
                            <button onClick={() => openEdit(org)}
                              style={{ padding: '5px 10px', borderRadius: '7px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: FONT }}>
                              Editar
                            </button>
                            <button onClick={() => handleAcessar(org)}
                              style={{ padding: '5px 12px', borderRadius: '7px', border: 'none', background: '#2563eb', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                              Acessar
                            </button>
                            <button onClick={() => { setDeleteOrg(org); setDeleteConfirm(''); }}
                              style={{ padding: '5px 10px', borderRadius: '7px', border: 'none', background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                              Excluir
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          </>)}

          {/* ── Aba Dashboard ── */}
          {aba === 'dashboard' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Filtro de período */}
              <div style={{ display: 'flex', gap: '6px' }}>
                {([
                  { key: 'mes',        label: 'Este mês' },
                  { key: 'trimestre',  label: 'Trimestre' },
                  { key: 'ano',        label: 'Este ano' },
                ] as const).map(p => (
                  <button key={p.key} onClick={() => setDashPeriodo(p.key)} style={{
                    padding: '7px 14px', borderRadius: '8px', border: `1px solid ${dashPeriodo === p.key ? '#2563eb' : (dark ? '#27272a' : '#e5e7eb')}`,
                    background: dashPeriodo === p.key ? (dark ? 'rgba(37,99,235,0.12)' : '#eff6ff') : 'transparent',
                    color: dashPeriodo === p.key ? '#2563eb' : txtMid,
                    fontSize: '12.5px', fontWeight: dashPeriodo === p.key ? 600 : 400,
                    cursor: 'pointer', fontFamily: FONT, transition: 'all 0.15s',
                  }}>{p.label}</button>
                ))}
              </div>

              {dashLoading ? (
                <div style={{ padding: '40px', textAlign: 'center', color: txtMid, fontSize: '13px' }}>Carregando métricas…</div>
              ) : dashData ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                  {[
                    { label: 'MRR Estimado',     value: `R$ ${(dashData.mrr).toLocaleString('pt-BR')}`,    color: '#10b981', desc: 'Receita mensal recorrente' },
                    { label: 'Lucro Estimado',   value: `R$ ${(dashData.lucro).toLocaleString('pt-BR')}`,  color: dashData.lucro >= 0 ? '#10b981' : '#ef4444', desc: 'MRR - custos do período' },
                    { label: 'Clientes Ativos',  value: String(dashData.ativas),                            color: '#3b82f6', desc: 'Assinatura ativa' },
                    { label: 'Churn Rate',        value: `${dashData.churn}%`,                              color: dashData.churn > 5 ? '#ef4444' : '#10b981', desc: 'Cancelados / (ativos + cancelados)' },
                    { label: 'Novos no Período', value: String(dashData.novos),                             color: '#a855f7', desc: 'Orgs criadas no período' },
                    { label: 'Total de Leads',   value: String(dashData.totalLeads),                        color: '#f59e0b', desc: 'Leads em todas as orgs' },
                    { label: 'Ravena Ativa',     value: String(dashData.ravenaAtiva),                       color: '#8b5cf6', desc: 'Orgs com IA de tráfego ativa' },
                  ].map(m => (
                    <div key={m.label} style={{ ...card, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <p style={{ fontSize: '10.5px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0 }}>{m.label}</p>
                      <p style={{ fontSize: '24px', fontWeight: 700, color: m.color, margin: 0, letterSpacing: '-0.03em' }}>{m.value}</p>
                      <p style={{ fontSize: '11px', color: dark ? '#3f3f46' : '#d1d5db', margin: 0 }}>{m.desc}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* ── Aba Contabilidade ── */}
          {aba === 'contabilidade' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Cards resumo */}
              {(() => {
                const receitas = contas.filter(c => c.tipo === 'receita').reduce((s, c) => s + Number(c.valor), 0);
                const custos   = contas.filter(c => c.tipo === 'custo').reduce((s, c) => s + Number(c.valor), 0);
                const saldo    = receitas - custos;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                    {[
                      { label: 'Total Receitas', value: `R$ ${receitas.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, color: '#10b981' },
                      { label: 'Total Custos',   value: `R$ ${custos.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,   color: '#ef4444' },
                      { label: 'Saldo',          value: `R$ ${saldo.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,    color: saldo >= 0 ? '#10b981' : '#ef4444' },
                    ].map(m => (
                      <div key={m.label} style={card}>
                        <p style={{ fontSize: '10.5px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 6px' }}>{m.label}</p>
                        <p style={{ fontSize: '22px', fontWeight: 700, color: m.color, margin: 0, letterSpacing: '-0.03em' }}>{m.value}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Tabela lançamentos */}
              <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.06)'}`, background: dark ? '#18181b' : '#fafafa' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: txt }}>Lançamentos</span>
                </div>
                {contaLoading ? (
                  <div style={{ padding: '40px', textAlign: 'center', color: txtMid, fontSize: '13px' }}>Carregando…</div>
                ) : contas.length === 0 ? (
                  <div style={{ padding: '40px', textAlign: 'center', color: txtMid, fontSize: '13px' }}>Nenhum lançamento ainda</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ background: dark ? '#18181b' : '#f8fafc' }}>
                          {['Descrição', 'Categoria', 'Tipo', 'Valor', 'Data', ''].map(h => (
                            <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '10.5px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {contas.map((c: any, i: number) => (
                          <tr key={c.id} style={{ borderTop: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.05)'}`, background: i % 2 === 0 ? 'transparent' : (dark ? 'rgba(255,255,255,0.01)' : 'rgba(0,0,0,0.01)') }}>
                            <td style={{ padding: '12px 16px', color: txt, fontWeight: 500 }}>{c.descricao}</td>
                            <td style={{ padding: '12px 16px', color: txtMid, textTransform: 'capitalize' }}>{c.categoria}</td>
                            <td style={{ padding: '12px 16px' }}>
                              <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '99px', color: c.tipo === 'receita' ? '#10b981' : '#ef4444', background: c.tipo === 'receita' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)' }}>
                                {c.tipo === 'receita' ? 'Receita' : 'Custo'}
                              </span>
                            </td>
                            <td style={{ padding: '12px 16px', fontWeight: 600, color: c.tipo === 'receita' ? '#10b981' : '#ef4444' }}>
                              {c.tipo === 'custo' ? '−' : '+'}R$ {Number(c.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                            </td>
                            <td style={{ padding: '12px 16px', color: txtMid, fontSize: '12px' }}>
                              {new Date(c.data + 'T12:00:00').toLocaleDateString('pt-BR')}
                            </td>
                            <td style={{ padding: '12px 16px' }}>
                              <button onClick={() => handleDeleteConta(c.id)}
                                style={{ padding: '4px 10px', borderRadius: '6px', border: 'none', background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontSize: '12px', cursor: 'pointer', fontFamily: FONT }}>
                                Excluir
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {aba === 'gestores' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowModalGestor(true)} style={{ padding: '9px 18px', borderRadius: '10px', border: 'none', background: '#2563eb', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>+ Novo gestor</button>
              </div>
              <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.06)'}`, background: dark ? '#18181b' : '#fafafa' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: txt }}>Gestores ativos</span>
                </div>
                {gestores.length === 0 ? (
                  <div style={{ padding: '40px', textAlign: 'center', color: txtMid, fontSize: '13px' }}>Nenhum gestor cadastrado ainda</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: dark ? '#18181b' : '#f8fafc' }}>
                        {['Nome', 'Email', 'Empresas', 'Status', ''].map(h => (
                          <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '10.5px', fontWeight: 600, color: txtMid, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gestores.map((g, i) => (
                        <tr key={g.id} style={{ borderTop: `1px solid ${dark ? '#1e1e22' : 'rgba(0,0,0,0.05)'}`, background: i % 2 === 0 ? 'transparent' : (dark ? 'rgba(255,255,255,0.01)' : 'rgba(0,0,0,0.01)') }}>
                          <td style={{ padding: '12px 16px', color: txt, fontWeight: 500 }}>{g.nome}</td>
                          <td style={{ padding: '12px 16px', color: txtMid }}>{g.email}</td>
                          <td style={{ padding: '12px 16px' }}>
                            <span style={{ fontSize: '12px', color: '#2563eb', fontWeight: 600 }}>{g.total_orgs || 0} empresa{g.total_orgs !== 1 ? 's' : ''}</span>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, padding: '3px 9px', borderRadius: '99px', color: g.ativo ? '#10b981' : '#71717a', background: g.ativo ? 'rgba(16,185,129,0.1)' : 'rgba(113,113,122,0.1)' }}>
                              {g.ativo ? 'Ativo' : 'Inativo'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button onClick={() => abrirDesignarOrgs(g)} style={{ padding: '5px 10px', borderRadius: '7px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '12px', cursor: 'pointer', fontFamily: FONT }}>Designar empresas</button>
                              <button onClick={() => toggleGestorAtivo(g)} style={{ padding: '5px 10px', borderRadius: '7px', border: 'none', background: g.ativo ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)', color: g.ativo ? '#ef4444' : '#10b981', fontSize: '12px', cursor: 'pointer', fontFamily: FONT }}>{g.ativo ? 'Desativar' : 'Ativar'}</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Modal: Novo cliente ── */}
      {showModal && (
        <>
          <div onClick={() => setShowModal(false)} style={overlay} />
          <div style={modalBox}>
            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: txt }}>Novo cliente</h3>
            <form onSubmit={handleCreateOrg} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={lbl}>Nome da empresa</label>
                <input style={inp} type="text" required placeholder="Ex: Minha Loja" value={modalNome} onChange={e => setModalNome(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Email</label>
                <input style={inp} type="email" required placeholder="admin@empresa.com" value={modalEmail} onChange={e => setModalEmail(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Senha</label>
                <input style={inp} type="password" required minLength={8} autoComplete="new-password" placeholder="Mínimo 8 caracteres" value={modalSenha} onChange={e => setModalSenha(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Plano</label>
                <select style={inp} value={modalPlano} onChange={e => setModalPlano(e.target.value)}>
                  {PLANOS.map(p => <option key={p} value={p}>{PLANO_LABELS[p] ?? p}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button type="button" onClick={() => setShowModal(false)}
                  style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
                  Cancelar
                </button>
                <button type="submit" disabled={creating}
                  style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: creating ? (dark ? '#27272a' : '#e5e7eb') : '#10b981', color: creating ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: creating ? 'default' : 'pointer', fontFamily: FONT }}>
                  {creating ? 'Criando…' : 'Criar'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* ── Modal: Editar org ── */}
      {editOrg && (
        <>
          <div onClick={() => setEditOrg(null)} style={overlay} />
          <div style={modalBox}>
            <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 600, color: txt }}>Editar cliente</h3>
            <p style={{ fontSize: '12.5px', color: txtMid, margin: '0 0 16px' }}>{editOrg.nome}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={lbl}>Email</label>
                <input style={inp} type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder={editOrg?.email_admin || 'email@empresa.com'} />
              </div>
              <div>
                <label style={lbl}>Nova senha <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional, mín. 8 chars)</span></label>
                <input style={inp} type="password" value={editSenha} onChange={e => setEditSenha(e.target.value)} placeholder="Deixe em branco para não alterar" autoComplete="new-password" />
              </div>
              <div>
                <label style={lbl}>Plano</label>
                <select style={inp} value={editPlano} onChange={e => setEditPlano(e.target.value)}>
                  {PLANOS.map(p => <option key={p} value={p}>{PLANO_LABELS[p] ?? p}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Status</label>
                <select style={inp} value={editStatus} onChange={e => setEditStatus(e.target.value as OrgStatus)}>
                  <option value="ativo">Ativo — acesso completo</option>
                  <option value="inadimplente">Inadimplente — pagamento atrasado</option>
                  <option value="suspenso">Suspenso — bloqueio total</option>
                  <option value="cancelado">Cancelado — encerrado voluntariamente</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button type="button" onClick={() => setEditOrg(null)}
                  style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
                  Cancelar
                </button>
                <button onClick={handleEditSave} disabled={editSaving}
                  style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: editSaving ? (dark ? '#27272a' : '#e5e7eb') : '#2563eb', color: editSaving ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: editSaving ? 'default' : 'pointer', fontFamily: FONT }}>
                  {editSaving ? 'Salvando…' : 'Salvar'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {/* ── Modal: Excluir org ── */}
      {deleteOrg && (
        <>
          <div onClick={() => { setDeleteOrg(null); setDeleteConfirm(''); }} style={{ ...overlay, zIndex: 62 }} />
          <div style={{ ...modalBox, zIndex: 63, maxWidth: '420px' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 600, color: '#ef4444' }}>Excluir cliente</h3>
            <p style={{ fontSize: '13px', color: txtMid, margin: '0 0 16px', lineHeight: 1.6 }}>
              Esta ação é <strong style={{ color: txt }}>irreversível</strong>. Todos os dados serão apagados.<br />
              Digite <strong style={{ color: txt }}>{deleteOrg.nome}</strong> para confirmar.
            </p>
            <input
              style={inp}
              value={deleteConfirm}
              onChange={e => setDeleteConfirm(e.target.value)}
              placeholder={deleteOrg.nome}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <button
                onClick={() => { setDeleteOrg(null); setDeleteConfirm(''); }}
                style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}
              >
                Cancelar
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirm !== deleteOrg.nome || deleteLoading}
                style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: deleteConfirm !== deleteOrg.nome || deleteLoading ? (dark ? '#27272a' : '#e5e7eb') : '#ef4444', color: deleteConfirm !== deleteOrg.nome || deleteLoading ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: deleteConfirm !== deleteOrg.nome || deleteLoading ? 'default' : 'pointer', fontFamily: FONT }}
              >
                {deleteLoading ? 'Excluindo…' : 'Excluir definitivamente'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Modal: Criar gestor ── */}
      {showModalGestor && (
        <>
          <div onClick={() => setShowModalGestor(false)} style={overlay} />
          <div style={modalBox}>
            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: txt }}>Novo gestor</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div><label style={lbl}>Nome</label><input style={inp} value={modalGestorNome} onChange={e => setModalGestorNome(e.target.value)} placeholder="Nome do gestor" /></div>
              <div><label style={lbl}>Email</label><input style={inp} type="email" value={modalGestorEmail} onChange={e => setModalGestorEmail(e.target.value)} placeholder="gestor@email.com" /></div>
              <div><label style={lbl}>Senha</label><input style={inp} type="password" value={modalGestorSenha} onChange={e => setModalGestorSenha(e.target.value)} placeholder="Mínimo 8 caracteres" autoComplete="new-password" /></div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button onClick={() => setShowModalGestor(false)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>Cancelar</button>
                <button onClick={handleCreateGestor} disabled={creatingGestor} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: creatingGestor ? (dark ? '#27272a' : '#e5e7eb') : '#2563eb', color: creatingGestor ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: creatingGestor ? 'default' : 'pointer', fontFamily: FONT }}>{creatingGestor ? 'Criando…' : 'Criar gestor'}</button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Modal: Designar empresas ── */}
      {designarGestor && (
        <>
          <div onClick={() => setDesignarGestor(null)} style={overlay} />
          <div style={{ ...modalBox, maxWidth: '480px', maxHeight: '80vh' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 600, color: txt }}>Designar empresas</h3>
            <p style={{ fontSize: '12px', color: txtMid, margin: '0 0 16px' }}>{designarGestor.nome} — selecione as empresas sob responsabilidade dele</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '50vh', overflowY: 'auto', marginBottom: '16px' }}>
              {orgs.map(org => {
                const selecionada = gestorOrgsIds.includes(org.id);
                return (
                  <div key={org.id} onClick={() => setGestorOrgsIds(prev => selecionada ? prev.filter(id => id !== org.id) : [...prev, org.id])}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', cursor: 'pointer', border: `1px solid ${selecionada ? '#2563eb' : (dark ? '#27272a' : '#e5e7eb')}`, background: selecionada ? (dark ? 'rgba(37,99,235,0.1)' : '#eff6ff') : 'transparent', transition: 'all 0.12s' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '4px', flexShrink: 0, border: `2px solid ${selecionada ? '#2563eb' : (dark ? '#3f3f46' : '#d1d5db')}`, background: selecionada ? '#2563eb' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {selecionada && <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: '13px', fontWeight: 500, color: txt, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{org.nome}</p>
                      <p style={{ margin: 0, fontSize: '11px', color: txtMid }}>{org.email_admin}</p>
                    </div>
                    <StatusBadge status={org.status} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setDesignarGestor(null)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>Cancelar</button>
              <button onClick={salvarDesignarOrgs} disabled={savingDesignar} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: savingDesignar ? (dark ? '#27272a' : '#e5e7eb') : '#2563eb', color: savingDesignar ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: savingDesignar ? 'default' : 'pointer', fontFamily: FONT }}>{savingDesignar ? 'Salvando…' : `Salvar (${gestorOrgsIds.length} empresa${gestorOrgsIds.length !== 1 ? 's' : ''})`}</button>
            </div>
          </div>
        </>
      )}

      {/* ── Modal: Novo lançamento ── */}
      {showModalConta && (
        <>
          <div onClick={() => setShowModalConta(false)} style={overlay} />
          <div style={{ ...modalBox, maxWidth: '420px' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: txt }}>Novo lançamento</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

              {/* Toggle tipo */}
              <div>
                <label style={lbl}>Tipo</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {(['custo', 'receita'] as const).map(t => (
                    <button key={t} onClick={() => { setContaTipo(t); setContaCategoria(''); }}
                      style={{ flex: 1, padding: '9px', borderRadius: '10px', border: `2px solid ${contaTipo === t ? (t === 'receita' ? '#10b981' : '#ef4444') : (dark ? '#27272a' : '#e5e7eb')}`, background: contaTipo === t ? (t === 'receita' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)') : 'transparent', color: contaTipo === t ? (t === 'receita' ? '#10b981' : '#ef4444') : txtMid, fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                      {t === 'custo' ? '− Custo' : '+ Receita'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={lbl}>Descrição</label>
                <input style={inp} value={contaDescricao} onChange={e => setContaDescricao(e.target.value)} placeholder="Ex: Servidor AWS, Mensalidade cliente…" />
              </div>

              <div>
                <label style={lbl}>Valor (R$)</label>
                <input style={inp} type="number" step="0.01" min="0" value={contaValor} onChange={e => setContaValor(e.target.value)} placeholder="0,00" />
              </div>

              <div>
                <label style={lbl}>Categoria</label>
                <select style={inp} value={contaCategoria} onChange={e => setContaCategoria(e.target.value)}>
                  <option value="">Selecione…</option>
                  {contaTipo === 'custo'
                    ? ['Infraestrutura', 'APIs', 'Marketing', 'Salários', 'Ferramentas', 'Outros'].map(c => <option key={c} value={c.toLowerCase()}>{c}</option>)
                    : ['Mensalidade', 'Setup', 'Consultoria', 'Outros'].map(c => <option key={c} value={c.toLowerCase()}>{c}</option>)
                  }
                </select>
              </div>

              <div>
                <label style={lbl}>Data</label>
                <input style={inp} type="date" value={contaData} onChange={e => setContaData(e.target.value)} />
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button onClick={() => setShowModalConta(false)}
                  style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
                  Cancelar
                </button>
                <button onClick={handleSaveConta} disabled={savingConta}
                  style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: savingConta ? (dark ? '#27272a' : '#e5e7eb') : '#2563eb', color: savingConta ? txtMid : '#fff', fontSize: '13px', fontWeight: 600, cursor: savingConta ? 'default' : 'pointer', fontFamily: FONT }}>
                  {savingConta ? 'Salvando…' : 'Salvar lançamento'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Modal: Credenciais ── */}
      {showCreds && (
        <>
          <div onClick={() => setShowCreds(false)} style={overlay} />
          <div style={{ ...modalBox, maxWidth: '460px' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: txt }}>Credenciais do cliente</h3>
            {credsLoading ? (
              <p style={{ color: txtMid, fontSize: '13px' }}>Carregando…</p>
            ) : credsData ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {([
                  { label: 'Email', value: credsData.email },
                  { label: 'Org ID', value: credsData.orgId },
                  { label: 'Webhook URL', value: credsData.webhookUrl },
                ] as const).map(({ label, value }) => (
                  <div key={label}>
                    <p style={{ ...lbl, marginBottom: '4px' }}>{label}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: dark ? '#0d0d0f' : '#f8fafc', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, borderRadius: '9px', padding: '9px 12px' }}>
                      <span style={{ flex: 1, fontSize: '12.5px', color: txt, wordBreak: 'break-all', fontFamily: 'monospace' }}>{value}</span>
                      <button
                        onClick={() => navigator.clipboard.writeText(value).then(() => toast.success('Copiado!'))}
                        style={{ flexShrink: 0, padding: '4px 8px', borderRadius: '6px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '11px', cursor: 'pointer', fontFamily: FONT }}
                      >
                        Copiar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <button
              onClick={() => setShowCreds(false)}
              style={{ marginTop: '20px', width: '100%', padding: '10px', borderRadius: '10px', border: `1px solid ${dark ? '#27272a' : '#e5e7eb'}`, background: 'transparent', color: txtMid, fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}
            >
              Fechar
            </button>
          </div>
        </>
      )}
    </div>
  );
}
