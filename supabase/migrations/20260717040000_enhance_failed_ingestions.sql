-- 1. Enhance public.failed_lead_ingestions table
alter table public.failed_lead_ingestions
  add column if not exists token text,
  add column if not exists metadata jsonb;

-- 2. Update public.ingest_lead_webhook function with proper phone number normalization
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

  -- Remove 55 prefix for Brazilian phone numbers when needed (leaves 10 or 11 digits)
  if (length(v_whatsapp) = 12 or length(v_whatsapp) = 13) and left(v_whatsapp, 2) = '55' then
    v_whatsapp := substring(v_whatsapp from 3);
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

-- 3. Update leadboard_internal.retry_failed_lead_ingestions function
create or replace function leadboard_internal.retry_failed_lead_ingestions(
  p_batch_size integer default 20
)
returns integer
language plpgsql
security definer
set search_path = public, leadboard_internal
as $$
declare
  v_row public.failed_lead_ingestions%rowtype;
  v_result jsonb;
  v_processed integer := 0;
  v_retry_count integer;
  v_delay interval;
begin
  for v_row in
    select *
      from public.failed_lead_ingestions
     where status in ('pending', 'retrying')
       and error_code in ('database_ingestion_failed', 'unexpected_error', 'timeout')
       and lead_payload is not null
       and retry_count < 5
       and next_retry_at <= now()
     order by created_at
     limit greatest(1, least(p_batch_size, 100))
     for update skip locked
  loop
    begin
      -- Try to resolve org_id using the token if it is null
      if v_row.org_id is null and nullif(v_row.token, '') is not null then
        select org_id into v_row.org_id
          from public.webhooks
         where token = v_row.token
           and ativo = true
         limit 1;

        if v_row.org_id is not null then
          update public.failed_lead_ingestions
             set org_id = v_row.org_id
           where id = v_row.id;
        end if;
      end if;

      -- If org_id is still null, we cannot resolve the webhook, mark as failed
      if v_row.org_id is null then
        update public.failed_lead_ingestions
           set status = 'failed',
               error_message = 'Cannot resolve org_id (invalid token or webhook inactive)'
         where id = v_row.id;
        continue;
      end if;

      update public.failed_lead_ingestions
         set status = 'retrying',
             last_retry_at = now()
        where id = v_row.id;

      v_result := public.ingest_lead_webhook(
        v_row.org_id,
        v_row.provider,
        v_row.external_event_id,
        v_row.request_id,
        v_row.lead_payload,
        jsonb_build_object(
          'source', 'failed_ingestion_retry',
          'queue_id', v_row.id,
          'retry_count', v_row.retry_count + 1
        )
      );

      update public.failed_lead_ingestions
         set status = 'resolved',
             resolved_at = now(),
             lead_id = (v_result ->> 'lead_id')::integer,
             retry_count = retry_count + 1,
             error_message = null
       where id = v_row.id;

      insert into public.webhook_logs (org_id, event_type, status, payload)
      values (
        v_row.org_id,
        'retry_resolved',
        'success',
        jsonb_build_object(
          'request_id', v_row.request_id,
          'queue_id', v_row.id,
          'lead_id', v_result ->> 'lead_id',
          'retry_count', v_row.retry_count + 1,
          'timestamp', now()
        )
      );
    exception
      when others then
        v_retry_count := v_row.retry_count + 1;
        v_delay := case v_retry_count
          when 1 then interval '1 minute'
          when 2 then interval '5 minutes'
          when 3 then interval '15 minutes'
          when 4 then interval '1 hour'
          else interval '6 hours'
        end;

        update public.failed_lead_ingestions
           set retry_count = v_retry_count,
               status = case when v_retry_count >= 5 then 'failed' else 'pending' end,
               next_retry_at = now() + v_delay,
               last_retry_at = now(),
               error_message = sqlerrm
         where id = v_row.id;

        insert into public.webhook_logs (org_id, event_type, status, payload)
        values (
          v_row.org_id,
          case when v_retry_count >= 5 then 'retry_exhausted' else 'retry_scheduled' end,
          'error',
          jsonb_build_object(
            'request_id', v_row.request_id,
            'queue_id', v_row.id,
            'retry_count', v_retry_count,
            'next_retry_at', now() + v_delay,
            'error', sqlerrm,
            'timestamp', now()
          )
        );
    end;

    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end
$$;

-- 4. Enable Row Level Security and add policies for failed_lead_ingestions
alter table public.failed_lead_ingestions enable row level security;

drop policy if exists "Org members and gestores can view failed ingestions" on public.failed_lead_ingestions;
create policy "Org members and gestores can view failed ingestions" on public.failed_lead_ingestions
  for select using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = failed_lead_ingestions.org_id
    )
    or exists (
      select 1 from public.gestor_orgs go
      join public.gestores g on g.user_id = go.gestor_user_id
      where go.org_id = failed_lead_ingestions.org_id
        and go.gestor_user_id = auth.uid()
        and g.ativo = true
    )
  );

drop policy if exists "Org members and gestores can update failed ingestions" on public.failed_lead_ingestions;
create policy "Org members and gestores can update failed ingestions" on public.failed_lead_ingestions
  for update using (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = failed_lead_ingestions.org_id
    )
    or exists (
      select 1 from public.gestor_orgs go
      join public.gestores g on g.user_id = go.gestor_user_id
      where go.org_id = failed_lead_ingestions.org_id
        and go.gestor_user_id = auth.uid()
        and g.ativo = true
    )
  ) with check (
    exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = failed_lead_ingestions.org_id
    )
    or exists (
      select 1 from public.gestor_orgs go
      join public.gestores g on g.user_id = go.gestor_user_id
      where go.org_id = failed_lead_ingestions.org_id
        and go.gestor_user_id = auth.uid()
        and g.ativo = true
    )
  );

grant select, update on public.failed_lead_ingestions to authenticated;

