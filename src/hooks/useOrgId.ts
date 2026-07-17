import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const ADMIN_EMAIL = 'admin@floow.com';

export function setAdminViewingOrg(orgId: string, orgNome: string) {
  localStorage.setItem('admin_viewing_org', orgId);
  localStorage.setItem('admin_viewing_org_nome', orgNome);
}

export function clearAdminViewingOrg() {
  localStorage.removeItem('admin_viewing_org');
  localStorage.removeItem('admin_viewing_org_nome');
}

export function getAdminViewingOrg(): { orgId: string; orgName: string } | null {
  const orgId = localStorage.getItem('admin_viewing_org');
  if (!orgId) return null;
  return { orgId, orgName: localStorage.getItem('admin_viewing_org_nome') || '' };
}

// Cache em memória — evita re-fetch a cada mount do componente
const orgIdCache: Record<string, string | null> = {};

export function useOrgId() {
  const { user } = useAuth();

  // Tenta pegar do cache imediatamente para evitar flash
  const getCached = (): { orgId: string | null; ready: boolean } => {
    if (!user) return { orgId: null, ready: false };
    const adminViewing = localStorage.getItem('admin_viewing_org');
    if (user.email === ADMIN_EMAIL || adminViewing) {
      return { orgId: adminViewing, ready: true };
    }
    if (orgIdCache[user.id] !== undefined) {
      return { orgId: orgIdCache[user.id], ready: true };
    }
    return { orgId: null, ready: false };
  };

  const initial = getCached();
  const [orgId, setOrgId] = useState<string | null>(initial.orgId);
  const [ready, setReady] = useState(initial.ready);

  useEffect(() => {
    if (!user) { setReady(true); return; }

    // Admin ou gestor visualizando uma org
    const adminViewing = localStorage.getItem('admin_viewing_org');
    if (user.email === ADMIN_EMAIL || adminViewing) {
      setOrgId(adminViewing);
      setReady(true);
      return;
    }

    // Cache hit — não precisa buscar novamente
    if (orgIdCache[user.id] !== undefined) {
      setOrgId(orgIdCache[user.id]);
      setReady(true);
      return;
    }

    // Busca via memberships
    supabase
      .from('memberships')
      .select('org_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        const id = data?.org_id || null;
        orgIdCache[user.id] = id; // salva no cache
        setOrgId(id);
        setReady(true);
      })
      .catch(() => {
        orgIdCache[user.id] = null;
        setReady(true);
      });
  }, [user?.id]);

  return { orgId, ready };
}