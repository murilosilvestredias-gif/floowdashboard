import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { RefreshCw, Play, AlertOctagon, CheckCircle2, HelpCircle, Eye, EyeOff, Loader2, ArrowRight } from 'lucide-react';

interface IngestionHealthProps {
  orgId: string;
}

interface IngestionHealthData {
  org_id: string;
  organizacao: string;
  ultimo_webhook: string | null;
  ultima_lead: string | null;
  leads_1h: number;
  leads_6h: number;
  erros_6h: number;
  falhas_pendentes: number;
  integration_status: 'healthy' | 'degraded' | 'silent' | 'no_history';
}

interface FailedIngestion {
  id: string;
  org_id: string | null;
  request_id: string | null;
  provider: string;
  external_event_id: string | null;
  payload: Record<string, any>;
  lead_payload: Record<string, any> | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  status: 'pending' | 'retrying' | 'resolved' | 'failed';
  created_at: string;
  next_retry_at: string;
  last_retry_at: string | null;
  resolved_at: string | null;
  lead_id: number | null;
}

export function IngestionHealth({ orgId }: IngestionHealthProps) {
  const [health, setHealth] = useState<IngestionHealthData | null>(null);
  const [failures, setFailures] = useState<FailedIngestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [selectedFailure, setSelectedFailure] = useState<FailedIngestion | null>(null);
  const [showPayload, setShowPayload] = useState(false);

  const fetchHealthAndFailures = async () => {
    try {
      // 1. Fetch Ingestion Health View
      const { data: healthData, error: healthErr } = await supabase
        .from('org_lead_ingestion_health' as any)
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle();

      if (healthErr) throw healthErr;
      setHealth(healthData as unknown as IngestionHealthData);

      // 2. Fetch Failed Ingestions List
      const { data: failuresData, error: failuresErr } = await supabase
        .from('failed_lead_ingestions')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(30);

      if (failuresErr) throw failuresErr;
      setFailures(failuresData as unknown as FailedIngestion[]);
    } catch (err) {
      console.error('Fetch health data error:', err);
    } finally {
      setLoading(false);
      setRefetching(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchHealthAndFailures();
  }, [orgId]);

  const handleRefresh = () => {
    setRefetching(true);
    fetchHealthAndFailures();
  };

  const handleRetryFailure = async (failureId: string) => {
    try {
      // Trigger retry by resetting next_retry_at to now, status to pending, and retry_count to 0
      const { error } = await supabase
        .from('failed_lead_ingestions')
        .update({
          status: 'pending',
          next_retry_at: new Date().toISOString(),
          retry_count: 0,
          error_message: 'Fila resetada manualmente para reprocessamento',
        } as any)
        .eq('id', failureId);

      if (error) throw error;
      toast.success('Reprocessamento agendado! A fila tentará ingerir o lead em instantes.');
      fetchHealthAndFailures();
      if (selectedFailure?.id === failureId) {
        setSelectedFailure(null);
      }
    } catch (err: any) {
      toast.error(`Erro ao reprocessar: ${err.message}`);
    }
  };

  const handleResolveFailure = async (failureId: string) => {
    try {
      const { error } = await supabase
        .from('failed_lead_ingestions')
        .update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          error_message: 'Resolvido manualmente pelo painel de controle',
        } as any)
        .eq('id', failureId);

      if (error) throw error;
      toast.success('Lead marcado como resolvido manualmente.');
      fetchHealthAndFailures();
      if (selectedFailure?.id === failureId) {
        setSelectedFailure(null);
      }
    } catch (err: any) {
      toast.error(`Erro ao atualizar: ${err.message}`);
    }
  };

  const fmtDate = (d: string | null) => {
    if (!d) return 'Sem registro';
    return new Date(d).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'healthy':
        return <span className="px-2 py-1 bg-green-950 border border-green-800 text-green-400 rounded-lg text-xs font-bold">Saudável</span>;
      case 'degraded':
        return <span className="px-2 py-1 bg-red-950 border border-red-900 text-red-400 rounded-lg text-xs font-bold">Instável (Erros)</span>;
      case 'silent':
        return <span className="px-2 py-1 bg-amber-950 border border-amber-900 text-amber-400 rounded-lg text-xs font-bold font-semibold">Sem Webhook Recente</span>;
      default:
        return <span className="px-2 py-1 bg-zinc-900 border border-zinc-800 text-zinc-400 rounded-lg text-xs font-bold">Sem Histórico</span>;
    }
  };

  const getRowStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <span className="px-2 py-0.5 bg-zinc-950 border border-zinc-800 text-zinc-400 rounded text-[10px] font-bold">Pendente</span>;
      case 'retrying':
        return <span className="px-2 py-0.5 bg-blue-950 border border-blue-900 text-blue-400 rounded text-[10px] font-bold animate-pulse">Retentando</span>;
      case 'resolved':
        return <span className="px-2 py-0.5 bg-green-950 border border-green-900 text-green-400 rounded text-[10px] font-bold">Resolvido</span>;
      case 'failed':
        return <span className="px-2 py-0.5 bg-red-950 border border-red-900 text-red-400 rounded text-[10px] font-bold">Falhou</span>;
      default:
        return <span className="px-2 py-0.5 bg-zinc-900 text-zinc-400 rounded text-[10px] font-bold">{status}</span>;
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <Loader2 className="animate-spin text-blue-500" size={32} />
        <p className="text-xs text-zinc-400">Carregando dados de saúde da ingestão...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Health Overview */}
      {health && (
        <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-5 space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <span className="text-zinc-200 font-semibold text-sm">Saúde da Ingestão</span>
              {getStatusBadge(health.integration_status)}
            </div>
            <button
              onClick={handleRefresh}
              disabled={refetching}
              className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg transition disabled:opacity-50"
            >
              <RefreshCw size={14} className={refetching ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
            <div className="space-y-0.5">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold block">Último Webhook</span>
              <span className="text-xs font-medium text-zinc-300">{fmtDate(health.ultimo_webhook)}</span>
            </div>
            <div className="space-y-0.5">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold block">Última Lead Inserida</span>
              <span className="text-xs font-medium text-zinc-300">{fmtDate(health.ultima_lead)}</span>
            </div>
            <div className="space-y-0.5">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold block">Leads Criadas (1h / 6h)</span>
              <span className="text-xs font-semibold text-zinc-200">
                {health.leads_1h} <span className="text-zinc-500">/</span> {health.leads_6h}
              </span>
            </div>
            <div className="space-y-0.5">
              <span className="text-[10px] text-zinc-500 uppercase font-semibold block">Falhas Pendentes / Erros (6h)</span>
              <span className="text-xs font-semibold text-red-400">
                {health.falhas_pendentes} <span className="text-zinc-500">/</span> {health.erros_6h}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Failed Ingestions Queue List */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-semibold text-zinc-200">Fila de Recuperação</h3>
          <span className="text-xs font-medium text-zinc-500">Últimos 30 eventos com falha</span>
        </div>

        <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 overflow-hidden divide-y divide-zinc-800/80">
          {failures.length === 0 ? (
            <div className="p-12 text-center text-xs text-zinc-500 space-y-1">
              <CheckCircle2 className="mx-auto text-green-500/20" size={32} />
              <p className="font-semibold text-zinc-400">Fila limpa!</p>
              <p>Nenhuma falha de ingestão pendente na fila.</p>
            </div>
          ) : (
            failures.map((fail) => (
              <div
                key={fail.id}
                onClick={() => {
                  setSelectedFailure(fail);
                  setShowPayload(false);
                }}
                className={`p-3.5 flex justify-between items-center text-xs cursor-pointer hover:bg-zinc-800/40 transition ${selectedFailure?.id === fail.id ? 'bg-zinc-800/30' : ''}`}
              >
                <div className="space-y-1 flex-1 min-w-0 pr-4">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-zinc-300">
                      {fail.lead_payload?.nome || fail.payload?.nome || 'Lead Incompleto'}
                    </span>
                    {getRowStatusBadge(fail.status)}
                  </div>
                  <p className="text-zinc-500 truncate text-[11px] font-mono">
                    {fail.error_message || fail.error_code || 'Erro desconhecido'}
                  </p>
                </div>
                <div className="flex items-center space-x-3 text-right">
                  <div className="space-y-0.5">
                    <p className="text-zinc-400 text-[10px]">{fmtDate(fail.created_at)}</p>
                    <p className="text-zinc-500 text-[10px]">Tamanho: {fail.retry_count} retries</p>
                  </div>
                  <ArrowRight size={12} className="text-zinc-500" />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail Dialog/Modal for Selected Failure */}
      {selectedFailure && (
        <div
          onClick={() => setSelectedFailure(null)}
          className="fixed inset 0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          style={{ position: 'fixed', inset: 0 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-zinc-950 border border-zinc-800 w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]"
          >
            {/* Header */}
            <div className="p-4 border-b border-zinc-800 bg-zinc-900/40 flex justify-between items-center">
              <div>
                <h3 className="text-sm font-bold text-zinc-200">
                  {selectedFailure.lead_payload?.nome || selectedFailure.payload?.nome || 'Detalhes da Falha'}
                </h3>
                <span className="text-[10px] text-zinc-500 font-mono">ID: {selectedFailure.id}</span>
              </div>
              <button
                onClick={() => setSelectedFailure(null)}
                className="text-zinc-400 hover:text-zinc-200 text-xs font-semibold px-2 py-1 rounded hover:bg-zinc-800"
              >
                Fechar
              </button>
            </div>

            {/* Content */}
            <div className="p-5 space-y-4 overflow-y-auto flex-1 text-xs">
              {/* Error message */}
              <div className="bg-red-950/20 border border-red-900/30 rounded-xl p-3 flex space-x-2.5">
                <AlertOctagon className="text-red-500 shrink-0" size={16} />
                <div className="space-y-0.5">
                  <span className="font-semibold text-zinc-300 block">Mensagem de Erro ({selectedFailure.error_code})</span>
                  <p className="text-zinc-400 leading-relaxed font-mono text-[11px]">{selectedFailure.error_message}</p>
                </div>
              </div>

              {/* Status details */}
              <div className="grid grid-cols-2 gap-4 bg-zinc-900/20 border border-zinc-800/80 rounded-xl p-3">
                <div>
                  <span className="text-zinc-500 font-semibold text-[10px] uppercase block">Tentativas Realizadas</span>
                  <span className="text-zinc-300 font-medium">{selectedFailure.retry_count} / 5</span>
                </div>
                <div>
                  <span className="text-zinc-500 font-semibold text-[10px] uppercase block">Próxima Tentativa</span>
                  <span className="text-zinc-300 font-medium">{fmtDate(selectedFailure.next_retry_at)}</span>
                </div>
              </div>

              {/* Payload viewer toggle */}
              <div className="space-y-2">
                <button
                  onClick={() => setShowPayload(!showPayload)}
                  className="flex items-center space-x-1.5 text-zinc-400 hover:text-zinc-200 font-semibold"
                >
                  {showPayload ? <EyeOff size={12} /> : <Eye size={12} />}
                  <span>{showPayload ? 'Ocultar Payload Bruto' : 'Visualizar Payload Bruto'}</span>
                </button>

                {showPayload && (
                  <pre className="bg-zinc-950 border border-zinc-850 rounded-lg p-3 overflow-x-auto text-[10px] text-zinc-400 font-mono max-h-[150px]">
                    {JSON.stringify(selectedFailure.payload, null, 2)}
                  </pre>
                )}
              </div>
            </div>

            {/* Footer Buttons */}
            {selectedFailure.status !== 'resolved' && (
              <div className="p-4 bg-zinc-900/60 border-t border-zinc-800 flex justify-end space-x-2">
                <button
                  onClick={() => handleResolveFailure(selectedFailure.id)}
                  className="px-3.5 py-2 bg-transparent hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-lg text-xs font-semibold transition"
                >
                  Resolver Manualmente
                </button>
                <button
                  onClick={() => handleRetryFailure(selectedFailure.id)}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition flex items-center space-x-1"
                >
                  <Play size={10} />
                  <span>Reexecutar Retry</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
