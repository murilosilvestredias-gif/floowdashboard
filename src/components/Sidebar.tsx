import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, BarChart3, Megaphone, Image as ImageIcon,
  Webhook, MessageCircle, Settings, LogOut, ChevronLeft, Building2, ClipboardList,
  ChevronDown, Zap, User as UserIcon, CreditCard, ChevronUp, CircleDot, GitBranch,
  Calendar,
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { useOrgId } from '@/hooks/useOrgId';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { usePlanFeatures } from '@/hooks/usePlanFeatures';
import { UpgradeModal } from '@/components/ui/UpgradeModal';
import { useStatusConfig } from '@/hooks/useStatusConfig';
import { useModeloNegocio } from '@/hooks/useTerminology';

const NAV_MAIN = [
  { icon: LayoutDashboard, label: 'Dashboard', href: '/', badge: false },
  { icon: Users, label: 'Leads', href: '/leads', badge: true },
  { 
    icon: ClipboardList, 
    label: 'Quiz', 
    href: '/quiz-builder', 
    badge: false,
    children: [
      { label: 'Meu Quiz', href: '/quiz-builder' },
      { label: 'Respostas', href: '/quiz/respostas' }
    ]
  },
  { icon: BarChart3, label: 'Funil CRM', href: '/kanban', badge: false },
  { icon: GitBranch, label: 'Origens', href: '/origens', badge: false },
];

const NAV_META = [
  { icon: Megaphone, label: 'Campanhas', href: '/campanhas', badge: false },
  { icon: ImageIcon, label: 'Criativos', href: '/criativos', badge: false },
  {
    icon: MessageCircle,
    label: 'WhatsApp',
    href: '/whatsapp',
    badge: false,
    feature: 'whatsappOficial',
    children: [
      { label: 'Mensagens', href: '/whatsapp' },
      { label: 'Disparos', href: '/whatsapp/disparos' },
      { label: 'Configurações', href: '/whatsapp/configuracoes' }
    ]
  },
];

const NAV_INT = [
  {
    icon: Settings,
    label: 'Integrações',
    href: '/meta-ads',
    badge: false,
    children: [
      { label: 'Meta Ads', href: '/meta-ads' },
      { label: 'Webhook', href: '/webhook' }
    ]
  },
];

const NAV_ACCOUNT = [
  { icon: CreditCard, label: 'Assinatura', href: '/assinatura', badge: false },
];

const COLLAPSE_KEY = 'sidebar_collapsed';

interface SidebarProps {
  leadCount?: number;
  onMobileClose?: () => void;
}

export function Sidebar({ leadCount = 0, onMobileClose }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { orgId, ready } = useOrgId();
  const isDark = theme === 'dark';

  const { features, loading } = usePlanFeatures();
  const [lockedFeature, setLockedFeature] = useState<string | null>(null);

  const modelo = useModeloNegocio();
  const { config: statusConfig } = useStatusConfig(modelo);
  const navMain = useMemo(() => [
    ...NAV_MAIN.slice(0, 4),
    { icon: Calendar, label: 'Calendário', href: '/calendario', badge: false },
    ...NAV_MAIN.slice(4),
  ], []);

  const [alertBadges, setAlertBadges] = useState<Record<string, boolean>>({});
  const [waUnread, setWaUnread] = useState(0);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    if (location.pathname.startsWith('/quiz')) initial['/quiz-builder'] = true;
    if (location.pathname.startsWith('/whatsapp') || location.pathname === '/disparos') initial['/whatsapp'] = true;
    if (location.pathname.startsWith('/meta-ads') || location.pathname === '/webhook') initial['/meta-ads'] = true;
    return initial;
  });

  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setShowAccountMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!orgId) return;
    async function fetchBadges() {
      const [{ data: org }, { count }] = await Promise.all([
        supabase.from('organizations').select('meta_token').eq('id', orgId!).single(),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('org_id', orgId!),
      ]);
      setAlertBadges({
        '/webhook': (count ?? 0) === 0,
        '/meta-ads': !((org as any)?.meta_token),
      });
    }
    fetchBadges();
  }, [orgId, location.pathname]);


  useEffect(() => {
    if (!ready || !orgId) return;
    
    // Busca inicial
    const fetchUnread = async () => {
      const { data } = await supabase
        .from('whatsapp_conversations')
        .select('unread_count')
        .eq('org_id', orgId)
        .gt('unread_count', 0);
      const total = (data || []).length;
      setWaUnread(total);
    };
    
    fetchUnread();
    
    // Realtime
    const ch = supabase.channel('sidebar-wa-unread-' + orgId)
      .on('postgres_changes' as any, {
        event: '*', schema: 'public',
        table: 'whatsapp_conversations',
        filter: `org_id=eq.${orgId}`,
      }, fetchUnread)
      .subscribe();
    
    return () => { supabase.removeChannel(ch); };
  }, [orgId, ready]);

  const isWhatsApp = location.pathname.startsWith('/whatsapp');

  const [pinned, setPinned] = useState<boolean>(() => {
    if (isWhatsApp) return false;
    try { 
      const val = localStorage.getItem(COLLAPSE_KEY);
      if (val !== null) return val !== 'true';
      return true;
    } catch { return true; }
  });
  
  const [hovered, setHovered] = useState(false);

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    try { localStorage.setItem(COLLAPSE_KEY, String(!next)); } catch { }
  }

  function isActive(href: string) {
    return href === '/' ? location.pathname === '/' : location.pathname.startsWith(href);
  }

  const fullName = user?.user_metadata?.full_name || user?.user_metadata?.name || '';
  const firstNameMeta = user?.user_metadata?.first_name || '';
  const nameParts = (fullName || firstNameMeta).trim().split(/\s+/);
  const displayName = nameParts.length >= 2 ? `${nameParts[0]} ${nameParts[1]}` : nameParts[0] || 'Usuário';
  const userEmail = user?.email || '';
  const userInitial = displayName[0]?.toUpperCase() || 'U';

  const isMobileDrawer = !!onMobileClose;
  const isExpanded = isMobileDrawer ? true : (pinned || hovered);
  const isCollapsed = !isExpanded;

  // Dark sidebar tokens — #141416 base
  const sideBg  = isDark ? '#141416' : '#ffffff';
  const sideBdr = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
  const lblClr  = isDark ? '#6b6b78' : 'rgba(0,0,0,0.36)'; // labels de seção mais legíveis
  const mutClr  = isDark ? '#8a8a96' : 'rgba(0,0,0,0.58)'; // itens inativos
  const hovBg   = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';

  function NavGroup({ label, items }: { label: string; items: any[] }) {
    return (
      <div style={{ marginBottom: '18px' }}>
        {!isCollapsed && (
          <p style={{
            fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', padding: '0 12px', marginBottom: '4px',
            color: lblClr,
          }}>
            {label}
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          {items.map(item => {
            const active = isActive(item.href);
            const isWa = item.href === '/whatsapp';
            const hasChildren = item.children;
            const isOpen = expandedItems[item.href];

            const itemContent = (
              <div 
                title={isCollapsed ? item.label : undefined}
                style={{ display: 'flex', alignItems: 'center', justifyContent: isCollapsed ? 'center' : 'flex-start', gap: '10px', padding: isCollapsed ? '10px 0' : '9px 12px', borderRadius: '8px', fontSize: '13.5px', fontWeight: active ? 600 : 500, transition: 'background 0.12s, color 0.12s, box-shadow 0.12s', background: active && !hasChildren ? (isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,68,253,0.07)') : 'transparent', color: active && !hasChildren ? (isDark ? '#f0f0f0' : '#0044fd') : mutClr, boxShadow: active && !hasChildren && isDark ? 'inset 2px 0 0 #0044fd' : 'none', position: 'relative', cursor: 'pointer' }}
                onMouseEnter={e => { if (!(active && !hasChildren)) { e.currentTarget.style.background = hovBg; e.currentTarget.style.color = isDark ? '#a0a0a8' : '#111'; } }}
                onMouseLeave={e => { if (!(active && !hasChildren)) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = mutClr; } }}
              >
                <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                  <item.icon style={{ width: '20px', height: '20px', strokeWidth: active ? 2.2 : 1.7 }} />
                  {isWa && waUnread > 0 && (
                    <span style={{
                      position: 'absolute', top: '-6px', right: '-8px',
                      background: '#25d366', color: '#fff',
                      fontSize: '9px', fontWeight: 700,
                      minWidth: '16px', height: '16px',
                      borderRadius: '99px', padding: '0 4px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: isDark ? '2px solid #141416' : '2px solid white',
                      zIndex: 10
                    }}>
                      {waUnread > 99 ? '99+' : waUnread}
                    </span>
                  )}
                </div>
                {!isCollapsed && (
                  <>
                    <span style={{ flex: 1, letterSpacing: '-0.01em' }}>{item.label}</span>
                    {hasChildren && <ChevronDown style={{ width: '12px', height: '12px', opacity: 0.5, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />}
                    {alertBadges[item.href] && !hasChildren && (
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', flexShrink: 0, boxShadow: '0 0 4px rgba(239,68,68,0.5)' }} />
                    )}
                    {item.badge && leadCount > 0 && (
                      <span style={{ fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '20px', background: isDark ? '#0044fd' : (active ? '#dbeafe' : '#e5e7eb'), color: isDark ? '#fff' : (active ? '#1d4ed8' : '#374151'), minWidth: '22px', textAlign: 'center' }}>
                        {leadCount}
                      </span>
                    )}
                  </>
                )}
              </div>
            );

            // Feature-locked items render differently
            const isLocked = !loading && item.feature && !(features[item.feature as keyof typeof features] as boolean);
            if (isLocked) {
              return (
                <div key={item.href} style={{ position: 'relative' }} onClick={() => setLockedFeature(item.feature!)}>
                  <div style={{ opacity: 0.45, pointerEvents: 'none', userSelect: 'none' }}>
                    {itemContent}
                  </div>
                  {!isCollapsed && (
                    <span style={{
                      position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                      fontSize: '11px', background: 'rgba(0,0,0,0.45)', color: '#fff',
                      padding: '2px 5px', borderRadius: '4px', pointerEvents: 'none',
                    }}>
                      🔒
                    </span>
                  )}
                </div>
              );
            }

            return (
              <div key={item.href}>
                {hasChildren ? (
                  <div onClick={() => setExpandedItems(prev => ({ ...prev, [item.href]: !prev[item.href] }))}>
                    {itemContent}
                  </div>
                ) : (
                  <Link to={item.href} style={{ textDecoration: 'none' }} onClick={isMobileDrawer ? onMobileClose : undefined}>
                    {itemContent}
                  </Link>
                )}
                
                {isOpen && !isCollapsed && hasChildren && (
                  <div style={{ paddingLeft: '28px', marginTop: '1px', display: 'flex', flexDirection: 'column', gap: '1px' }}>
                    {item.children.map((child: any) => {
                      const childActive = location.pathname === child.href;
                      return (
                        <Link
                          key={child.href}
                          to={child.href}
                          onClick={isMobileDrawer ? onMobileClose : undefined}
                          style={{
                            display: 'flex', alignItems: 'center', padding: '7px 12px',
                            borderRadius: '6px', fontSize: '12.5px', fontWeight: childActive ? 600 : 400,
                            textDecoration: 'none', color: childActive ? (isDark ? '#fff' : '#111') : mutClr,
                            background: childActive ? hovBg : 'transparent',
                            transition: 'all 0.12s',
                          }}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <aside 
      onMouseEnter={() => !pinned && setHovered(true)}
      onMouseLeave={() => !pinned && setHovered(false)}
      style={{
        width: isExpanded ? '220px' : '56px',
        flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        background: sideBg,
        borderRight: `1px solid ${sideBdr}`,
        height: '100%',
        transition: isMobileDrawer ? 'none' : 'width 0.2s cubic-bezier(0.4,0,0.2,1)',
        overflow: 'hidden',
        zIndex: 40
      }}
    >

      {/* Header */}
      <div style={{
        height: '60px',
        padding: isExpanded ? '0 12px 0 16px' : '0',
        display: 'flex', alignItems: 'center',
        justifyContent: isExpanded ? 'space-between' : 'center',
        borderBottom: `1px solid ${sideBdr}`,
        flexShrink: 0,
      }}>
        {isExpanded ? (
          <>
            <img
              src={isDark ? '/logo-light.png' : '/logo-dark.png'}
              alt="floow"
              onClick={() => { navigate('/'); if (isMobileDrawer) onMobileClose?.(); }}
              style={{ height: '24px', width: 'auto', objectFit: 'contain', cursor: 'pointer' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
            {!isMobileDrawer && (
              <button
                onClick={togglePin}
                title={pinned ? 'Desafixar sidebar' : 'Fixar sidebar'}
                style={{
                  padding: '4px', borderRadius: '6px', border: 'none',
                  background: 'transparent', cursor: 'pointer',
                  color: pinned ? '#2563eb' : mutClr,
                  display: 'flex', alignItems: 'center',
                  transform: pinned ? 'rotate(0deg)' : 'rotate(45deg)',
                  transition: 'transform 0.2s, color 0.2s',
                  opacity: pinned ? 1 : 0.6
                }}
              >
                <CircleDot size={18} strokeWidth={pinned ? 2.5 : 1.8} />
              </button>
            )}
          </>
        ) : (
          <button
            onClick={togglePin}
            title={pinned ? 'Desafixar sidebar' : 'Fixar sidebar'}
            style={{
              padding: '4px', borderRadius: '6px', border: 'none',
              background: 'transparent', cursor: 'pointer',
              color: pinned ? '#2563eb' : mutClr,
              display: 'flex', alignItems: 'center',
              transform: pinned ? 'rotate(0deg)' : 'rotate(45deg)',
              transition: 'transform 0.2s, color 0.2s',
              opacity: pinned ? 1 : 0.6
            }}
          >
            <CircleDot size={18} strokeWidth={pinned ? 2.5 : 1.8} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '14px 6px 0', overflowY: 'auto', overflowX: 'hidden' }}>
        <NavGroup label="Principal" items={navMain} />
        <NavGroup label="Meta Ads" items={NAV_META} />
        <NavGroup label="Integrações" items={NAV_INT} />
        <NavGroup label="Conta" items={NAV_ACCOUNT} />
      </nav>

      {/* Footer */}
      <div style={{ padding: '6px', borderTop: `1px solid ${sideBdr}`, flexShrink: 0, position: 'relative' }}>
        
        {/* Account Menu Popover */}
        {showAccountMenu && (
          <div ref={accountMenuRef} style={{
            position: 'absolute',
            bottom: '100%',
            left: '6px',
            right: '6px',
            background: isDark ? '#1a1a1e' : '#fff',
            border: `1px solid ${sideBdr}`,
            borderRadius: '12px',
            marginBottom: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
            overflow: 'hidden',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            padding: '4px'
          }}>
            <button onClick={() => { navigate('/'); setShowAccountMenu(false); if (isMobileDrawer) onMobileClose?.(); }} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', border: 'none', background: 'transparent', color: isDark ? '#eee' : '#333', fontSize: '13px', fontWeight: 500, cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => e.currentTarget.style.background = hovBg}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <LayoutDashboard size={16} /> Dashboard
            </button>
            <button onClick={() => { navigate('/configuracoes'); setShowAccountMenu(false); if (isMobileDrawer) onMobileClose?.(); }} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', border: 'none', background: 'transparent', color: isDark ? '#eee' : '#333', fontSize: '13px', fontWeight: 500, cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => e.currentTarget.style.background = hovBg}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <UserIcon size={16} /> Minha conta
            </button>
            <div style={{ height: '1px', background: sideBdr, margin: '4px 8px' }} />
            <button onClick={signOut} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', border: 'none', background: 'transparent', color: '#ef4444', fontSize: '13px', fontWeight: 500, cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => e.currentTarget.style.background = isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <LogOut size={16} /> Sair
            </button>
          </div>
        )}

        {/* User profile toggle */}
        <div 
          onClick={() => setShowAccountMenu(!showAccountMenu)}
          style={{ 
            display: 'flex', alignItems: 'center', 
            justifyContent: isCollapsed ? 'center' : 'flex-start',
            gap: '9px', padding: isCollapsed ? '10px 0' : '9px 12px', 
            borderRadius: '8px', cursor: 'pointer', transition: 'background 0.12s',
            marginBottom: '4px'
          }}
          onMouseEnter={e => (e.currentTarget.style.background = hovBg)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <div style={{
            width: '32px', height: '32px', borderRadius: '50%',
            background: 'linear-gradient(135deg,#3b82f6,#2563eb)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: '13px', fontWeight: 700, flexShrink: 0,
          }}>
            {userInitial}
          </div>
          {!isCollapsed && (
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: isDark ? '#f4f4f5' : '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName}
              </p>
              <p style={{ margin: 0, fontSize: '11px', color: mutClr, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Configurações
              </p>
            </div>
          )}
          {!isCollapsed && (showAccountMenu ? <ChevronDown size={14} color={mutClr} /> : <ChevronUp size={14} color={mutClr} />)}
        </div>

        {/* Dark mode toggle — hidden in mobile drawer (accessible via header button) */}
        {!isMobileDrawer && <div onClick={toggleTheme} style={{
          display: 'flex', alignItems: 'center',
          justifyContent: isCollapsed ? 'center' : 'space-between',
          padding: isCollapsed ? '10px 0' : '9px 12px',
          borderRadius: '8px', cursor: 'pointer', transition: 'background 0.12s',
        }}
          onMouseEnter={e => (e.currentTarget.style.background = hovBg)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          {!isCollapsed && (
            <span style={{ fontSize: '13.5px', fontWeight: 500, color: mutClr }}>
              {isDark ? 'Modo claro' : 'Modo escuro'}
            </span>
          )}
          <div style={{
            width: '34px', height: '18px', borderRadius: '99px',
            background: isDark ? '#2563eb' : '#d1d5db',
            position: 'relative', flexShrink: 0, transition: 'background 0.2s',
          }}>
            <div style={{
              position: 'absolute', top: '2px',
              left: isDark ? '16px' : '2px',
              width: '14px', height: '14px', borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.2s cubic-bezier(0.4,0,0.2,1)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
            }} />
          </div>
        </div>}
      </div>

      {lockedFeature && (
        <UpgradeModal
          feature={lockedFeature}
          planoNecessario="Starter"
          onClose={() => setLockedFeature(null)}
        />
      )}
    </aside>
  );
}