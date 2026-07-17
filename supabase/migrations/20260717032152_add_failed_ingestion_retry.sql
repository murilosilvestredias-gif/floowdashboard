create schema if not exists leadboard_internal;
revoke all on schema leadboard_internal from public, anon, authenticated;

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
       and error_code = 'database_ingestion_failed'
       and org_id is not null
       and lead_payload is not null
       and retry_count < 5
       and next_retry_at <= now()
     order by created_at
     limit greatest(1, least(p_batch_size, 100))
     for update skip locked
  loop
    begin
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

revoke all on function leadboard_internal.retry_failed_lead_ingestions(integer)
  from public, anon, authenticated;
grant execute on function leadboard_internal.retry_failed_lead_ingestions(integer)
  to service_role;

do $$
begin
  if not exists (
    select 1
      from cron.job
     where jobname = 'retry-failed-lead-ingestions'
  ) then
    perform cron.schedule(
      'retry-failed-lead-ingestions',
      '* * * * *',
      'select leadboard_internal.retry_failed_lead_ingestions(20);'
    );
  end if;
end
$$;
