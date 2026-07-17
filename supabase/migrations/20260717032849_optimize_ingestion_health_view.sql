create or replace view public.org_lead_ingestion_health
with (security_invoker = true)
as
with log_health as (
  select
    org_id,
    max(created_at) filter (
      where event_type in (
        'request_received',
        'webhook_post_recebido',
        'webhook_recebido',
        'webhook_resolved'
      )
    ) as ultimo_webhook,
    max(created_at) filter (
      where event_type in ('lead_created', 'lead_recebido')
        and status = 'success'
    ) as ultima_lead,
    count(*) filter (
      where event_type in ('lead_created', 'lead_recebido')
        and status = 'success'
        and created_at >= now() - interval '1 hour'
    ) as leads_1h,
    count(*) filter (
      where event_type in ('lead_created', 'lead_recebido')
        and status = 'success'
        and created_at >= now() - interval '6 hours'
    ) as leads_6h,
    count(*) filter (
      where status = 'error'
        and created_at >= now() - interval '6 hours'
    ) as erros_6h,
    count(*) filter (
      where status = 'error'
        and created_at >= now() - interval '1 hour'
    ) as erros_1h
  from public.webhook_logs
  where created_at >= now() - interval '30 days'
  group by org_id
),
queue_health as (
  select
    org_id,
    count(*) filter (
      where status in ('pending', 'retrying')
    ) as falhas_pendentes
  from public.failed_lead_ingestions
  group by org_id
)
select
  o.id as org_id,
  o.nome as organizacao,
  lh.ultimo_webhook,
  lh.ultima_lead,
  coalesce(lh.leads_1h, 0) as leads_1h,
  coalesce(lh.leads_6h, 0) as leads_6h,
  coalesce(lh.erros_6h, 0) as erros_6h,
  coalesce(qh.falhas_pendentes, 0) as falhas_pendentes,
  case
    when lh.ultimo_webhook is null then 'no_history'
    when lh.ultimo_webhook < now() - interval '2 hours' then 'silent'
    when coalesce(lh.erros_1h, 0) > 0 then 'degraded'
    else 'healthy'
  end as integration_status
from public.organizations o
left join log_health lh on lh.org_id = o.id
left join queue_health qh on qh.org_id = o.id;

grant select on public.org_lead_ingestion_health to authenticated, service_role;
