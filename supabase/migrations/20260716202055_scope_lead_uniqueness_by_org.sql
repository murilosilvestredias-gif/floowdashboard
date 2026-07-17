alter table public.leads
  drop constraint if exists leads_nome_whatsapp_unique;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leads'::regclass
      and conname = 'leads_org_nome_whatsapp_unique'
  ) then
    alter table public.leads
      add constraint leads_org_nome_whatsapp_unique
      unique (org_id, nome, whatsapp);
  end if;
end
$$;
