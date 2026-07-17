create schema if not exists leadboard_internal;

create or replace function leadboard_internal.parse_lead_created_at(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_match text[];
  v_year integer;
begin
  if nullif(btrim(p_value), '') is null then
    return null;
  end if;

  v_match := regexp_match(
    btrim(p_value),
    '^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})(?:\s+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?'
  );

  if v_match is not null then
    v_year := v_match[3]::integer;
    if length(v_match[3]) = 2 then
      v_year := case when v_year < 70 then v_year + 2000 else v_year + 1900 end;
    end if;

    return make_timestamptz(
      v_year,
      v_match[2]::integer,
      v_match[1]::integer,
      coalesce(v_match[4], '0')::integer,
      coalesce(v_match[5], '0')::integer,
      coalesce(v_match[6], '0')::double precision,
      'America/Sao_Paulo'
    );
  end if;

  if btrim(p_value) ~ '^\d{4}-\d{2}-\d{2}' then
    if btrim(p_value) ~ '(Z|[+-]\d{2}(:?\d{2})?)$' then
      return btrim(p_value)::timestamptz;
    end if;

    return (replace(btrim(p_value), ' ', 'T') || '-03:00')::timestamptz;
  end if;

  return btrim(p_value)::timestamptz;
exception
  when others then
    return null;
end
$$;

alter table public.leads
  add column if not exists entrada_at timestamptz;

update public.leads
set entrada_at = leadboard_internal.parse_lead_created_at(created_at)
where entrada_at is null;

create or replace function leadboard_internal.sync_lead_entrada_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.entrada_at := coalesce(
      new.entrada_at,
      leadboard_internal.parse_lead_created_at(new.created_at),
      now()
    );
  elsif new.created_at is distinct from old.created_at then
    new.entrada_at := coalesce(
      leadboard_internal.parse_lead_created_at(new.created_at),
      new.entrada_at,
      now()
    );
  end if;

  return new;
end
$$;

drop trigger if exists sync_lead_entrada_at on public.leads;

create trigger sync_lead_entrada_at
before insert or update of created_at on public.leads
for each row
execute function leadboard_internal.sync_lead_entrada_at();

create index if not exists leads_org_entrada_at_idx
  on public.leads (org_id, entrada_at desc nulls last, id desc);

revoke all on function leadboard_internal.parse_lead_created_at(text)
  from public, anon, authenticated;
revoke all on function leadboard_internal.sync_lead_entrada_at()
  from public, anon, authenticated;
