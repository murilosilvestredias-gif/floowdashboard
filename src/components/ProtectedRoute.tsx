import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { BloqueioAssinatura } from './BloqueioAssinatura';
import { GlobalWarningBanner } from './GlobalWarningBanner';

const EXEMPT_PATHS = ['/admin'];
const ADMIN_EMAIL = 'admin@floow.com';

// Mantém export para compatibilidade com Admin.tsx — BloqueioAssinatura faz query fresca a cada mount
export function invalidateSubscriptionCache() {}
export function invalidateOnboardingCache() {}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const isExempt = EXEMPT_PATHS.includes(location.pathname);
  const isAdmin = user?.email === ADMIN_EMAIL;

  // Initialize from sessionStorage so redirect fires on the same render as auth resolving
  const [gestorAtivo, setGestorAtivo] = useState<boolean | null>(() => {
    if (!user || isAdmin) return null;
    const v = sessionStorage.getItem(`gestor_${user.id}`);
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  });

  useEffect(() => {
    if (!user || isAdmin) { setGestorAtivo(false); return; }
    const cacheKey = `gestor_${user.id}`;
    supabase
      .from('gestores')
      .select('id, ativo')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        const isAtivo = data?.ativo === true;
        sessionStorage.setItem(cacheKey, isAtivo ? '1' : '0');
        setGestorAtivo(isAtivo);
      });
  }, [user?.id]);

  // Timeout de segurança: se loading não resolver em 5s, o refresh_token provavelmente
  // está inválido/expirado e o Supabase ficou travado. Força logout.
  useEffect(() => {
    if (!loading) return;
    const timeout = setTimeout(async () => {
      await supabase.auth.signOut();
      localStorage.clear();
      window.location.href = '/login';
    }, 5000);
    return () => clearTimeout(timeout);
  }, [loading]);

  if (loading || gestorAtivo === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  const adminViewingOrg = !!localStorage.getItem('admin_viewing_org');

  // Gestor ativo — redireciona para /gestor, mas não se estiver visualizando uma org
  if (gestorAtivo && !adminViewingOrg && location.pathname !== '/gestor') {
    return <Navigate to="/gestor" replace />;
  }

  // Admin sem impersonation só acessa /admin
  if (isAdmin && !adminViewingOrg && !isExempt) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <GlobalWarningBanner />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <BloqueioAssinatura />
        {children}
      </div>
    </div>
  );
}
