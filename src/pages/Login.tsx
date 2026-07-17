import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { TERMINOLOGY_PRESETS, DEFAULT_TERMINOLOGY, toDb } from '@/hooks/useTerminology';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, sans-serif';
const EDGE_URL = 'https://obguidmfvfjaekaskgob.functions.supabase.co/criar-org';

function mascaraDocumento(valor: string): string {
  const nums = valor.replace(/\D/g, '').slice(0, 14);
  if (nums.length <= 11) {
    return nums
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  return nums
    .replace(/(\d{2})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

type Mode = 'login' | 'cadastro' | 'forgot';

export default function LoginPage() {
  const { user, loading, signIn, resetPassword } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');

  // Login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Cadastro fields
  const [nomeEmpresa, setNomeEmpresa] = useState('');
  const [documento, setDocumento] = useState('');
  const [cadEmail, setCadEmail] = useState('');
  const [cadSenha, setCadSenha] = useState('');
  const [cadConfirmar, setCadConfirmar] = useState('');
  const [modeloNegocio, setModeloNegocio] = useState('revenda');

  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#090909' }}>
        <div style={{ width: '24px', height: '24px', border: '2px solid #fff', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  const inp: React.CSSProperties = {
    width: '100%', height: '44px',
    background: 'rgba(255,255,255,0.08)',
    color: '#f4f4f5',
    padding: '0 14px', borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.12)',
    fontSize: '14px', outline: 'none', fontFamily: FONT,
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  };

  const lbl: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, color: '#71717a',
    textTransform: 'uppercase', letterSpacing: '0.07em',
    display: 'block', marginBottom: '6px',
  };

  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = '#366fec'; };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; };

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const loginPromise = supabase.auth.signInWithPassword({ email, password });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10000)
      );
      const { data: _data, error } = await Promise.race([loginPromise, timeoutPromise]);
      if (error) {
        console.error('Erro de login:', error.message, error.status);
        if (error.status === 400 || error.message.includes('Invalid login credentials')) {
          toast.error('Email ou senha incorretos.');
        } else if (error.message.toLowerCase().includes('email not confirmed')) {
          toast.error('Confirme seu email antes de entrar.');
        } else {
          toast.error('Erro ao conectar. Tente novamente em alguns segundos.');
        }
      }
      // login ok — onAuthStateChange cuida da navegação
    } catch (err: any) {
      if (err.message === 'timeout') {
        toast.error('Conexão lenta. Verifique sua internet e tente novamente.');
      } else {
        toast.error('Erro inesperado. Tente novamente.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await resetPassword(email);
    if (error) toast.error(error.message);
    else toast.success('Email de recuperação enviado!');
    setSubmitting(false);
  }

  async function handleCadastro(e: React.FormEvent) {
    e.preventDefault();
    if (cadSenha.length < 8) { toast.error('Senha deve ter pelo menos 8 caracteres.'); return; }
    if (cadSenha !== cadConfirmar) { toast.error('As senhas não coincidem.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome_empresa: nomeEmpresa,
          email: cadEmail,
          senha: cadSenha,
          documento: documento.replace(/\D/g, '') || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast.error(data.erro || 'Erro ao criar conta. Tente novamente.');
      } else {
        toast.success('Conta criada! Plano gratuito ativado.');
        const { error: loginError } = await signIn(cadEmail, cadSenha);
        if (!loginError) {
          try {
            const { data: sessionData } = await supabase.auth.getSession();
            const userId = sessionData?.session?.user?.id;
            if (userId) {
              const { data: membership } = await (supabase as any)
                .from('memberships')
                .select('org_id')
                .eq('user_id', userId)
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();
              if (membership?.org_id) {
                const preset = TERMINOLOGY_PRESETS[modeloNegocio] ?? DEFAULT_TERMINOLOGY;
                await (supabase as any)
                  .from('organizations')
                  .update({ terminology: toDb(preset), modelo_negocio: modeloNegocio })
                  .eq('id', membership.org_id);
              }
            }
          } catch {
            // non-critical
          }
          navigate('/');
        } else {
          setMode('login');
          setEmail(cadEmail);
          setNomeEmpresa(''); setDocumento(''); setCadEmail(''); setCadSenha(''); setCadConfirmar('');
        }
      }
    } catch {
      toast.error('Não foi possível conectar. Verifique sua internet.');
    }
    setSubmitting(false);
  }

  const title = mode === 'login' ? 'Entrar no Floow' : mode === 'cadastro' ? 'Criar conta grátis' : 'Recuperar senha';
  const subtitle = mode === 'login' ? 'CRM para gestão de revendedoras' : mode === 'cadastro' ? 'Gratuito, sem cartão' : 'Insira seu email para receber o link';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#090909', padding: '24px', fontFamily: FONT }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <img
            src="/logo-light.png"
            alt="Floow"
            style={{ height: '22px', width: 'auto', objectFit: 'contain', display: 'block', margin: '0 auto 20px auto' }}
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#f4f4f5', margin: '0 0 6px', letterSpacing: '-0.03em' }}>
            {title}
          </h1>
          <p style={{ fontSize: '13px', color: '#71717a', margin: 0 }}>{subtitle}</p>
        </div>

        {/* Login */}
        {mode === 'login' && (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={lbl}>Email</label>
              <input style={inp} type="email" required placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <div>
              <label style={lbl}>Senha</label>
              <input style={inp} type="password" required placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <button type="submit" disabled={submitting} style={{ width: '100%', height: '44px', borderRadius: '8px', border: 'none', background: submitting ? '#27272a' : '#366fec', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: submitting ? 'default' : 'pointer', fontFamily: FONT, marginTop: '4px' }}>
              {submitting ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        )}

        {/* Cadastro */}
        {mode === 'cadastro' && (
          <form onSubmit={handleCadastro} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={lbl}>Nome da empresa</label>
              <input style={inp} type="text" required placeholder="Nome da sua empresa" value={nomeEmpresa} onChange={e => setNomeEmpresa(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <div>
              <label style={lbl}>CNPJ / CPF</label>
              <input style={inp} type="text" required placeholder="000.000.000-00 ou 00.000.000/0000-00" maxLength={18} value={documento} onChange={e => setDocumento(mascaraDocumento(e.target.value))} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <div>
              <label style={lbl}>Email</label>
              <input style={inp} type="email" required placeholder="seu@email.com" value={cadEmail} onChange={e => setCadEmail(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <div>
              <label style={lbl}>Senha</label>
              <input style={inp} type="password" required placeholder="Mínimo 8 caracteres" minLength={8} value={cadSenha} onChange={e => setCadSenha(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <div>
              <label style={lbl}>Confirmar senha</label>
              <input style={inp} type="password" required placeholder="Repita a senha" value={cadConfirmar} onChange={e => setCadConfirmar(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <div>
              <label style={lbl}>Modelo de negócio</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {([
                  { key: 'revenda', label: 'Revenda de produtos' },
                  { key: 'b2b', label: 'Vendas B2B' },
                  { key: 'corretor', label: 'Corretor / imóveis' },
                  { key: 'outro', label: 'Outro' },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setModeloNegocio(opt.key)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: `1px solid ${modeloNegocio === opt.key ? '#366fec' : 'rgba(255,255,255,0.12)'}`,
                      background: modeloNegocio === opt.key ? 'rgba(54,111,236,0.15)' : 'rgba(255,255,255,0.05)',
                      color: modeloNegocio === opt.key ? '#7aa6f5' : '#a1a1aa',
                      fontSize: '12px',
                      fontWeight: modeloNegocio === opt.key ? 600 : 400,
                      cursor: 'pointer',
                      fontFamily: FONT,
                      textAlign: 'left',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <button type="submit" disabled={submitting} style={{ width: '100%', height: '44px', borderRadius: '8px', border: 'none', background: submitting ? '#27272a' : '#366fec', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: submitting ? 'default' : 'pointer', fontFamily: FONT, marginTop: '4px' }}>
              {submitting ? 'Criando conta…' : 'Criar minha conta'}
            </button>
          </form>
        )}

        {/* Recuperar senha */}
        {mode === 'forgot' && (
          <form onSubmit={handleForgot} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={lbl}>Email</label>
              <input style={inp} type="email" required placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} onFocus={onFocus} onBlur={onBlur} />
            </div>
            <button type="submit" disabled={submitting} style={{ width: '100%', height: '44px', borderRadius: '8px', border: 'none', background: submitting ? '#27272a' : '#366fec', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: submitting ? 'default' : 'pointer', fontFamily: FONT }}>
              {submitting ? 'Enviando…' : 'Enviar link'}
            </button>
          </form>
        )}

        {/* Links */}
        <div style={{ marginTop: '20px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {mode === 'login' && (
            <>
              <button onClick={() => setMode('forgot')} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
                Esqueceu a senha?
              </button>
              <button onClick={() => setMode('cadastro')} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
                Não tem conta? <span style={{ color: '#366fec', fontWeight: 500 }}>Criar grátis</span>
              </button>
            </>
          )}
          {mode === 'cadastro' && (
            <button onClick={() => setMode('login')} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
              Já tem conta? <span style={{ color: '#366fec', fontWeight: 500 }}>Entrar</span>
            </button>
          )}
          {mode === 'forgot' && (
            <button onClick={() => setMode('login')} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: '13px', cursor: 'pointer', fontFamily: FONT }}>
              Voltar ao login
            </button>
          )}
        </div>
      </div>
      <style>{`input::placeholder { color: rgba(255,255,255,0.35) !important; }`}</style>
    </div>
  );
}
