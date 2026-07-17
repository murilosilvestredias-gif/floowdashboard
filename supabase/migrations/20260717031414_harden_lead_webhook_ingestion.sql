create table if not exists public.webhook_idempotency (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  provider text not null,
  external_event_id text not null,
  lead_id integer,
  status text not null default 'processing',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error text,
  unique (org_id, provider, external_event_id)
);

create table if not exists public.failed_lead_ingestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  request_id text,
  provider text not null default 'unknown',
  external_event_id text,
  payload jsonb not null,
  lead_payload jsonb,
  error_code text,
  error_message text,
  retry_count integer not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  next_retry_at timestamptz not null default now(),
  last_retry_at timestamptz,
  resolved_at timestamptz,
  lead_id integer
);

alter table public.webhook_idempotency enable row level security;
alter table public.failed_lead_ingestions enable row level security;

revoke all on public.webhook_idempotency from public, anon, authenticated;
revoke all on public.failed_lead_ingestions from public, anon, authenticated;
grant all on public.webhook_idempotency to service_role;
grant all on public.failed_lead_ingestions to service_role;

create index if not exists leads_org_whatsapp_idx
  on public.leads (org_id, whatsapp);

create index if not exists webhook_logs_org_created_idx
  on public.webhook_logs (org_id, created_at desc);

create index if not exists webhook_logs_request_id_idx
  on public.webhook_logs ((payload ->> 'request_id'));

create index if not exists failed_lead_ingestions_retry_idx
  on public.failed_lead_ingestions (status, next_retry_at)
  where status in ('pending', 'retrying');

create or replace function public.ingest_lead_webhook(
  p_org_id uuid,
  p_provider text,
  p_external_event_id text,
  p_request_id text,
  p_lead jsonb,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing public.leads%rowtype;
  v_lead_id integer;
  v_claimed boolean := true;
  v_event public.webhook_idempotency%rowtype;
  v_whatsapp text := regexp_replace(coalesce(p_lead ->> 'whatsapp', ''), '\D', '', 'g');
  v_nome text := regexp_replace(btrim(coalesce(p_lead ->> 'nome', '')), '\s+', ' ', 'g');
  v_now timestamptz := clock_timestamp();
  v_created boolean := false;
begin
  if p_org_id is null then
    raise exception using errcode = '22023', message = 'org_id is required';
  end if;

  if v_nome = '' and v_whatsapp = '' then
    raise exception using errcode = '22023', message = 'nome or whatsapp is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_whatsapp, 0));

  if nullif(p_external_event_id, '') is not null then
    insert into public.webhook_idempotency (
      org_id, provider, external_event_id, status
    )
    values (
      p_org_id, coalesce(nullif(p_provider, ''), 'unknown'), p_external_event_id, 'processing'
    )
    on conflict (org_id, provider, external_event_id) do nothing
    returning true into v_claimed;

    if not coalesce(v_claimed, false) then
      select *
        into v_event
        from public.webhook_idempotency
       where org_id = p_org_id
         and provider = coalesce(nullif(p_provider, ''), 'unknown')
         and external_event_id = p_external_event_id;

      if v_event.lead_id is not null then
        return jsonb_build_object(
          'ok', true,
          'lead_id', v_event.lead_id,
          'created', false,
          'updated', false,
          'duplicate', true,
          'idempotency_hit', true
        );
      end if;

      if v_event.created_at > v_now - interval '2 minutes' then
        return jsonb_build_object(
          'ok', true,
          'created', false,
          'updated', false,
          'duplicate', true,
          'processing', true,
          'idempotency_hit', true
        );
      end if;

      update public.webhook_idempotency
         set status = 'processing',
             error = null,
             created_at = v_now
       where id = v_event.id;
    end if;
  end if;

  select *
    into v_existing
    from public.leads
   where org_id = p_org_id
     and whatsapp = v_whatsapp
   order by id
   limit 1
   for update;

  if found then
    update public.leads
       set nome = coalesce(nullif(v_nome, ''), nome),
           cidade = coalesce(nullif(p_lead ->> 'cidade', ''), cidade),
           instagram = coalesce(nullif(p_lead ->> 'instagram', ''), instagram),
           utm_source = coalesce(nullif(p_lead ->> 'utm_source', ''), utm_source),
           utm_campaign = coalesce(nullif(p_lead ->> 'utm_campaign', ''), utm_campaign),
           utm_medium = coalesce(nullif(p_lead ->> 'utm_medium', ''), utm_medium),
           utm_content = coalesce(nullif(p_lead ->> 'utm_content', ''), utm_content),
           utm_term = coalesce(nullif(p_lead ->> 'utm_term', ''), utm_term),
           utm_id = coalesce(nullif(p_lead ->> 'utm_id', ''), utm_id),
           fbclid = coalesce(nullif(p_lead ->> 'fbclid', ''), fbclid),
           score = case
             when jsonb_typeof(p_lead -> 'score') = 'number' then (p_lead ->> 'score')::integer
             else score
           end,
           quiz_respostas = coalesce(quiz_respostas, '{}'::jsonb)
             || coalesce(p_lead -> 'quiz_respostas', '{}'::jsonb)
     where id = v_existing.id
     returning id into v_lead_id;
  else
    insert into public.leads (
      org_id,
      nome,
      whatsapp,
      cidade,
      instagram,
      status,
      wa_sent,
      created_at,
      quiz_respostas,
      utm_source,
      utm_campaign,
      utm_medium,
      utm_content,
      utm_term,
      utm_id,
      fbclid,
      score
    )
    values (
      p_org_id,
      nullif(v_nome, ''),
      nullif(v_whatsapp, ''),
      nullif(p_lead ->> 'cidade', ''),
      nullif(p_lead ->> 'instagram', ''),
      coalesce((p_lead ->> 'status')::smallint, 0),
      coalesce((p_lead ->> 'wa_sent')::boolean, false),
      coalesce(nullif(p_lead ->> 'created_at', ''), v_now::text),
      coalesce(p_lead -> 'quiz_respostas', '{}'::jsonb),
      nullif(p_lead ->> 'utm_source', ''),
      nullif(p_lead ->> 'utm_campaign', ''),
      nullif(p_lead ->> 'utm_medium', ''),
      nullif(p_lead ->> 'utm_content', ''),
      nullif(p_lead ->> 'utm_term', ''),
      nullif(p_lead ->> 'utm_id', ''),
      nullif(p_lead ->> 'fbclid', ''),
      case
        when jsonb_typeof(p_lead -> 'score') = 'number' then (p_lead ->> 'score')::integer
        else 0
      end
    )
    returning id into v_lead_id;
    v_created := true;
  end if;

  if nullif(p_external_event_id, '') is not null then
    update public.webhook_idempotency
       set lead_id = v_lead_id,
           status = 'completed',
           completed_at = v_now,
           error = null
     where org_id = p_org_id
       and provider = coalesce(nullif(p_provider, ''), 'unknown')
       and external_event_id = p_external_event_id;
  end if;

  insert into public.webhook_logs (org_id, event_type, status, payload)
  values (
    p_org_id,
    case when v_created then 'lead_created' else 'lead_updated' end,
    'success',
    jsonb_build_object(
      'request_id', p_request_id,
      'provider', coalesce(nullif(p_provider, ''), 'unknown'),
      'external_event_id', p_external_event_id,
      'lead_id', v_lead_id,
      'stage', 'database_transaction',
      'context', coalesce(p_context, '{}'::jsonb),
      'timestamp', v_now
    )
  );

  return jsonb_build_object(
    'ok', true,
    'lead_id', v_lead_id,
    'created', v_created,
    'updated', not v_created,
    'duplicate', not v_created,
    'idempotency_hit', false
  );
exception
  when unique_violation then
    select id into v_lead_id
      from public.leads
     where org_id = p_org_id
       and whatsapp = v_whatsapp
     order by id
     limit 1;

    if v_lead_id is not null then
      return jsonb_build_object(
        'ok', true,
        'lead_id', v_lead_id,
        'created', false,
        'updated', false,
        'duplicate', true,
        'constraint_recovered', true
      );
    end if;
    raise;
end
$$;

revoke all on function public.ingest_lead_webhook(uuid, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_lead_webhook(uuid, text, text, text, jsonb, jsonb)
  to service_role;

create or replace view public.org_lead_ingestion_health
with (security_invoker = true)
as
select
  o.id as org_id,
  o.nome as organizacao,
  max(wl.created_at) filter (
    where wl.event_type in ('request_received', 'webhook_post_recebido', 'webhook_recebido')
  ) as ultimo_webhook,
  max(l.created_at::timestamptz) as ultima_lead,
  count(distinct l.id) filter (
    where l.created_at::timestamptz >= now() - interval '1 hour'
  ) as leads_1h,
  count(distinct l.id) filter (
    where l.created_at::timestamptz >= now() - interval '6 hours'
  ) as leads_6h,
  count(distinct wl.id) filter (
    where wl.status = 'error'
      and wl.created_at >= now() - interval '6 hours'
  ) as erros_6h,
  count(distinct f.id) filter (
    where f.status in ('pending', 'retrying')
  ) as falhas_pendentes,
  case
    when max(wl.created_at) filter (
      where wl.event_type in ('request_received', 'webhook_post_recebido', 'webhook_recebido')
    ) is null then 'no_history'
    when max(wl.created_at) filter (
      where wl.event_type in ('request_received', 'webhook_post_recebido', 'webhook_recebido')
    ) < now() - interval '2 hours' then 'silent'
    when count(distinct wl.id) filter (
      where wl.status = 'error'
        and wl.created_at >= now() - interval '1 hour'
    ) > 0 then 'degraded'
    else 'healthy'
  end as integration_status
from public.organizations o
left join public.webhook_logs wl on wl.org_id = o.id
left join public.leads l on l.org_id = o.id
left join public.failed_lead_ingestions f on f.org_id = o.id
group by o.id, o.nome;

grant select on public.org_lead_ingestion_health to authenticated, service_role;
