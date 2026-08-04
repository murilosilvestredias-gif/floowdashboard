import { useState, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { useLocation, useNavigate } from 'react-router-dom';
import { Menu, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { getAdminViewingOrg, clearAdminViewingOrg, useOrgId } from '@/hooks/useOrgId';
import { TrialBanner } from './TrialBanner';
import { TutorialPopup } from './TutorialPopup';
import { supabase } from '@/integrations/supabase/client';
import { useAppStore } from '@/stores/appStore';

interface AppLayoutProps {
  children: React.ReactNode;
  leadCount?: number;
}

export function AppLayout({ children, leadCount = 0 }: AppLayoutProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const { orgId } = useOrgId();
  const { setConfiguracoes } = useAppStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Carrega configurações da org (campos_perfil, faixas_score, cortes de score)
  useEffect(() => {
    if (!orgId) return;
    supabase
      .from('organizations')
      .select('configuracoes, score_corte_verde, score_corte_amarelo, usa_quiz_externo')
      .eq('id', orgId)
      .single()
      .then(({ data }) => {
        if (!data) return;
        const base = (data as any).configuracoes ?? { campos_perfil: [], faixas_score: { travas: [], vermelho_se_todas: false } };
        setConfiguracoes({
          ...base,
          score_corte_verde: (data as any).score_corte_verde ?? 35,
          score_corte_amarelo: (data as any).score_corte_amarelo ?? 25,
          usa_quiz_externo: (data as any).usa_quiz_externo ?? false,
        });
      });
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [isMobile, setIsMobile] = useState(false);
  const [adminOrg, setAdminOrg] = useState<{ orgId: string; orgName: string } | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Relê o override do admin a cada troca de rota
  useEffect(() => {
    setAdminOrg(getAdminViewingOrg());
  }, [location.pathname]);

  function handleExitAdminView() {
    localStorage.removeItem('admin_viewing_org');
    localStorage.removeItem('admin_viewing_org_nome');
    window.location.href = '/admin'; // reload completo: limpa todo o estado React
  }

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Fecha gaveta ao mudar de rota
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const bg = isDark ? '#090909' : '#f4f4f5';

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - var(--banner-height, 0px))', overflow: 'hidden', background: bg, position: 'relative', transition: 'background-color 0.25s ease' }}>

      {/* Desktop sidebar */}
      {!isMobile && <Sidebar leadCount={leadCount} />}

      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          style={{
            position: 'fixed', top: 'var(--banner-height, 0px)', left: 0, right: 0, bottom: 0, zIndex: 60,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            animation: 'fadeIn 0.18s ease',
          }}
        />
      )}

      {/* Mobile sidebar drawer */}
      {isMobile && (
        <div style={{
          position: 'fixed', top: 'var(--banner-height, 0px)', left: 0, bottom: 0,
          zIndex: 61, width: '260px',
          transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.26s cubic-bezier(0.4,0,0.2,1)',
          willChange: 'transform',
        }}>
          <Sidebar leadCount={leadCount} onMobileClose={() => setMobileOpen(false)} />
        </div>
      )}

      {/* Main */}
      <main style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        background: bg,
        paddingTop: isMobile ? '56px' : '0',
        WebkitOverflowScrolling: 'touch',
        transition: 'background-color 0.25s ease',
      }}>
        {/* Banner admin impersonation */}
        {adminOrg && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 49, flexShrink: 0,
            background: 'linear-gradient(90deg, #ea580c, #dc2626)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 20px', height: '36px',
            boxShadow: '0 2px 8px rgba(220,38,38,0.35)',
          }}>
            <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
              👁 Visualizando: <strong>{adminOrg.orgName}</strong>
            </span>
            <button
              onClick={handleExitAdminView}
              style={{
                padding: '4px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.35)',
                background: 'rgba(255,255,255,0.15)', color: '#fff',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.28)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
            >
              Sair
            </button>
          </div>
        )}

        {/* Mobile top bar */}
        {isMobile && (
          <div style={{
            position: 'fixed', top: 'var(--banner-height, 0px)', left: 0, right: 0, height: '56px',
            background: isDark ? '#0f0f11' : '#ffffff',
            borderBottom: `1px solid ${isDark ? '#1e1e22' : 'rgba(0,0,0,0.08)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 16px', zIndex: 50,
            boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
          }}>
            {/* Botão hamburguer — abre E fecha a gaveta */}
            <button
              onClick={() => setMobileOpen(v => !v)}
              style={{
                width: '36px', height: '36px', borderRadius: '10px',
                background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Menu style={{ width: '18px', height: '18px', color: isDark ? '#fff' : '#111' }} />
            </button>

            {/* Logo clicável → dashboard */}
            <img
              src={isDark ? '/logo-light.png' : '/logo-dark.png'}
              alt="floow"
              onClick={() => navigate('/')}
              style={{ height: '22px', width: 'auto', objectFit: 'contain', cursor: 'pointer' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />

            <button
              onClick={toggleTheme}
              style={{
                width: '36px', height: '36px', borderRadius: '8px',
                background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {isDark
                ? <Sun style={{ width: '18px', height: '18px', color: '#f0c060' }} />
                : <Moon style={{ width: '18px', height: '18px', color: '#555' }} />
              }
            </button>
          </div>
        )}

        <TrialBanner />
        {children}
        {orgId && !isMobile && <TutorialPopup />}
      </main>

      <style>{`@keyframes fadeIn { from{opacity:0} to{opacity:1} }`}</style>
    </div>
  );
}
