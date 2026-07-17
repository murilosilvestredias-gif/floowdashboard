import { useState, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Upload, CheckCircle2, AlertTriangle, Play, HelpCircle, Loader2 } from 'lucide-react';

interface LeadReconciliationProps {
  orgId: string;
}

interface ParsedLead {
  nome: string;
  whatsapp: string;
  cidade: string;
  created_at: string;
  utm_source: string;
  utm_campaign: string;
  utm_medium: string;
  utm_content: string;
  utm_term: string;
  utm_id: string;
  fbclid: string;
  score: number | null;
  rawRow: Record<string, string>;
}

interface ReconciliationResult {
  lead: ParsedLead;
  status: 'ausente' | 'existente' | 'duplicado_csv';
  dbId?: string | number;
}

export function LeadReconciliation({ orgId }: LeadReconciliationProps) {
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  
  // Mapping state
  const [mapping, setMapping] = useState<Record<string, string>>({
    nome: '',
    whatsapp: '',
    cidade: '',
    created_at: '',
    utm_source: '',
    utm_campaign: '',
    utm_medium: '',
    utm_content: '',
    utm_term: '',
    utm_id: '',
    fbclid: '',
    score: '',
  });

  const [step, setStep] = useState<'upload' | 'mapping' | 'preview' | 'importing' | 'completed'>('upload');
  const [results, setResults] = useState<ReconciliationResult[]>([]);
  const [activeTab, setActiveTab] = useState<'ausentes' | 'existentes' | 'todos'>('ausentes');
  const [importingProgress, setImportingProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse CSV helper
  const parseCSV = (text: string) => {
    const lines: string[][] = [];
    let row: string[] = [];
    let inQuotes = false;
    let currentField = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (inQuotes) {
        if (char === '"') {
          if (nextChar === '"') {
            currentField += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          currentField += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',' || char === ';') {
          row.push(currentField.trim());
          currentField = '';
        } else if (char === '\n' || char === '\r') {
          if (char === '\r' && nextChar === '\n') {
            i++;
          }
          row.push(currentField.trim());
          if (row.some(field => field !== '')) {
            lines.push(row);
          }
          row = [];
          currentField = '';
        } else {
          currentField += char;
        }
      }
    }
    if (currentField || row.length > 0) {
      row.push(currentField.trim());
      if (row.some(field => field !== '')) {
        lines.push(row);
      }
    }

    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].map(h => h.toLowerCase().trim());
    
    const rows = lines.slice(1).map(line => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = line[index] || '';
      });
      return record;
    });

    return { headers, rows };
  };

  const normalizePhone = (val: string): string => {
    const digits = val.replace(/\D/g, '');
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
      return digits.slice(2);
    }
    return digits;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const { headers, rows } = parseCSV(text);
      if (headers.length === 0) {
        toast.error('O arquivo CSV parece estar vazio ou mal formatado.');
        return;
      }
      setCsvHeaders(headers);
      setCsvRows(rows);

      // Guess initial mapping
      const newMapping = { ...mapping };
      const findMatch = (keys: string[]) => {
        return headers.find(h => keys.some(k => h.includes(k))) || '';
      };

      newMapping.nome = findMatch(['nome', 'name', 'completo', 'lead']);
      newMapping.whatsapp = findMatch(['whatsapp', 'celular', 'telefone', 'phone', 'numero', 'contato']);
      newMapping.cidade = findMatch(['cidade', 'city', 'municipio', 'localidade']);
      newMapping.created_at = findMatch(['data', 'time', 'created', 'submitted', 'horario']);
      newMapping.utm_source = findMatch(['utm_source', 'source', 'origem']);
      newMapping.utm_campaign = findMatch(['utm_campaign', 'campaign', 'campanha']);
      newMapping.utm_medium = findMatch(['utm_medium', 'medium', 'conjunto', 'adset']);
      newMapping.utm_content = findMatch(['utm_content', 'content', 'anuncio', 'ad']);
      newMapping.utm_term = findMatch(['utm_term', 'term']);
      newMapping.utm_id = findMatch(['utm_id']);
      newMapping.fbclid = findMatch(['fbclid']);
      newMapping.score = findMatch(['score', 'pontos', 'pontuacao']);

      setMapping(newMapping);
      setStep('mapping');
    };
    reader.readAsText(selected);
  };

  const handleStartAnalysis = async () => {
    if (!mapping.nome || !mapping.whatsapp) {
      toast.error('Mapeamento de Nome e WhatsApp são obrigatórios!');
      return;
    }

    setStep('importing'); // transition loading state
    try {
      // 1. Fetch all existing leads for the current organization
      const { data: dbLeads, error } = await supabase
        .from('leads')
        .select('id, nome, whatsapp')
        .eq('org_id', orgId);

      if (error) throw error;

      const dbMap = new Map<string, string | number>();
      dbLeads?.forEach(l => {
        if (l.whatsapp) {
          dbMap.set(normalizePhone(l.whatsapp), l.id);
        }
      });

      // 2. Map CSV rows
      const parsedLeads: ParsedLead[] = csvRows.map(row => {
        const scoreVal = mapping.score ? Number(row[mapping.score]) : null;
        return {
          nome: row[mapping.nome]?.trim() || '',
          whatsapp: normalizePhone(row[mapping.whatsapp] || ''),
          cidade: mapping.cidade ? row[mapping.cidade]?.trim() || '' : '',
          created_at: mapping.created_at ? row[mapping.created_at]?.trim() || '' : new Date().toISOString(),
          utm_source: mapping.utm_source ? row[mapping.utm_source]?.trim() || '' : '',
          utm_campaign: mapping.utm_campaign ? row[mapping.utm_campaign]?.trim() || '' : '',
          utm_medium: mapping.utm_medium ? row[mapping.utm_medium]?.trim() || '' : '',
          utm_content: mapping.utm_content ? row[mapping.utm_content]?.trim() || '' : '',
          utm_term: mapping.utm_term ? row[mapping.utm_term]?.trim() || '' : '',
          utm_id: mapping.utm_id ? row[mapping.utm_id]?.trim() || '' : '',
          fbclid: mapping.fbclid ? row[mapping.fbclid]?.trim() || '' : '',
          score: scoreVal && !isNaN(scoreVal) ? scoreVal : null,
          rawRow: row,
        };
      }).filter(lead => lead.nome && lead.whatsapp); // Skip empty/incomplete rows

      // 3. Reconcile
      const seenCsv = new Set<string>();
      const processed: ReconciliationResult[] = parsedLeads.map(lead => {
        if (seenCsv.has(lead.whatsapp)) {
          return { lead, status: 'duplicado_csv' };
        }
        seenCsv.add(lead.whatsapp);

        if (dbMap.has(lead.whatsapp)) {
          return { lead, status: 'existente', dbId: dbMap.get(lead.whatsapp) };
        }
        return { lead, status: 'ausente' };
      });

      setResults(processed);
      setStep('preview');
    } catch (err) {
      console.error(err);
      toast.error('Erro na análise dos dados.');
      setStep('mapping');
    }
  };

  const handleImport = async () => {
    const missing = results.filter(r => r.status === 'ausente');
    if (missing.length === 0) {
      toast.error('Não há leads ausentes para importar!');
      return;
    }

    setStep('importing');
    setImportingProgress(0);

    const CHUNK_SIZE = 15;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunk = missing.slice(i, i + CHUNK_SIZE);
      const inserts = chunk.map(m => ({
        org_id: orgId,
        nome: m.lead.nome,
        whatsapp: m.lead.whatsapp,
        cidade: m.lead.cidade || null,
        status: 0,
        wa_sent: false,
        created_at: m.lead.created_at || new Date().toISOString(),
        quiz_respostas: m.lead.rawRow,
        utm_source: m.lead.utm_source || null,
        utm_campaign: m.lead.utm_campaign || null,
        utm_medium: m.lead.utm_medium || null,
        utm_content: m.lead.utm_content || null,
        utm_term: m.lead.utm_term || null,
        utm_id: m.lead.utm_id || null,
        fbclid: m.lead.fbclid || null,
        score: m.lead.score || 0,
      }));

      const { error } = await supabase.from('leads').insert(inserts);

      if (error) {
        console.error('Import chunk error:', error);
        failed += chunk.length;
      } else {
        succeeded += chunk.length;
      }

      setImportingProgress(Math.min(100, Math.round(((i + chunk.length) / missing.length) * 100)));
    }

    toast.success(`Importação finalizada! Sucesso: ${succeeded}, Falhas: ${failed}`);
    setStep('completed');
  };

  const ausentes = results.filter(r => r.status === 'ausente');
  const existentes = results.filter(r => r.status === 'existente');
  const todosFiltered = results.filter(r => {
    if (activeTab === 'ausentes') return r.status === 'ausente';
    if (activeTab === 'existentes') return r.status === 'existente';
    return true;
  });

  return (
    <div className="w-full space-y-6">
      {step === 'upload' && (
        <div className="border-2 border-dashed border-zinc-800 rounded-xl p-10 flex flex-col items-center justify-center space-y-4 hover:border-zinc-700 transition duration-150">
          <div className="p-4 bg-zinc-900 rounded-full text-zinc-400">
            <Upload size={32} />
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm font-semibold text-zinc-200">Upload de CSV Inlead</p>
            <p className="text-xs text-zinc-500">Selecione o arquivo CSV exportado da Inlead</p>
          </div>
          <input
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow transition duration-150"
          >
            Selecionar Arquivo
          </button>
        </div>
      )}

      {step === 'mapping' && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 space-y-6">
          <div className="flex items-center space-x-2">
            <HelpCircle className="text-blue-500" size={18} />
            <h3 className="text-sm font-semibold text-zinc-200">Mapeamento de Colunas</h3>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.keys(mapping).map((key) => {
              const required = key === 'nome' || key === 'whatsapp';
              return (
                <div key={key} className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
                    {key.replace('_', ' ')} {required && <span className="text-red-500">*</span>}
                  </label>
                  <select
                    value={mapping[key]}
                    onChange={(e) => setMapping(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-zinc-200 text-xs font-medium focus:outline-none focus:border-zinc-700"
                  >
                    <option value="">-- Não importar / Não encontrado --</option>
                    {csvHeaders.map(header => (
                      <option key={header} value={header}>{header}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between items-center pt-4 border-t border-zinc-800/80">
            <button
              onClick={() => setStep('upload')}
              className="px-4 py-2 bg-transparent hover:bg-zinc-800 border border-zinc-800 text-zinc-400 rounded-lg text-xs font-semibold transition"
            >
              Voltar
            </button>
            <button
              onClick={handleStartAnalysis}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition flex items-center space-x-2"
            >
              <Play size={12} />
              <span>Analisar Leads</span>
            </button>
          </div>
        </div>
      )}

      {step === 'importing' && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center space-y-4">
          <Loader2 className="animate-spin text-blue-500" size={32} />
          <div className="text-center space-y-1">
            <p className="text-sm font-semibold text-zinc-200">Importando leads ausentes...</p>
            <p className="text-xs text-zinc-500">Por favor, não feche a página.</p>
          </div>
          <div className="w-full max-w-xs bg-zinc-950 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${importingProgress}%` }}
            />
          </div>
          <p className="text-xs text-zinc-400">{importingProgress}%</p>
        </div>
      )}

      {step === 'preview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 text-center">
              <span className="text-2xl font-bold text-zinc-200 block">{ausentes.length}</span>
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">Leads Ausentes</span>
            </div>
            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 text-center">
              <span className="text-2xl font-bold text-zinc-400 block">{existentes.length}</span>
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">Existentes no Flow</span>
            </div>
            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 text-center">
              <span className="text-2xl font-bold text-zinc-400 block">{results.length}</span>
              <span className="text-[10px] text-zinc-500 uppercase font-semibold">Total de Linhas</span>
            </div>
          </div>

          <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 overflow-hidden">
            {/* Header Tabs */}
            <div className="flex border-b border-zinc-800 bg-zinc-900/60 p-2 justify-between items-center">
              <div className="flex space-x-1">
                <button
                  onClick={() => setActiveTab('ausentes')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${activeTab === 'ausentes' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  Ausentes ({ausentes.length})
                </button>
                <button
                  onClick={() => setActiveTab('existentes')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${activeTab === 'existentes' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  Existentes ({existentes.length})
                </button>
                <button
                  onClick={() => setActiveTab('todos')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${activeTab === 'todos' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  Todos ({results.length})
                </button>
              </div>

              {ausentes.length > 0 && (
                <button
                  onClick={handleImport}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition flex items-center space-x-1.5"
                >
                  <Play size={10} />
                  <span>Importar {ausentes.length} Ausentes</span>
                </button>
              )}
            </div>

            {/* List */}
            <div className="max-h-[300px] overflow-y-auto divide-y divide-zinc-800/80">
              {todosFiltered.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">Nenhum registro para exibir.</div>
              ) : (
                todosFiltered.map((res, idx) => (
                  <div key={idx} className="p-3 flex justify-between items-center text-xs">
                    <div className="space-y-0.5">
                      <p className="font-semibold text-zinc-200">{res.lead.nome}</p>
                      <p className="text-zinc-500 text-[10px] font-mono">{res.lead.whatsapp}</p>
                    </div>
                    <div className="flex items-center space-x-2">
                      {res.lead.utm_source && (
                        <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 text-[9px] font-medium text-zinc-400 rounded">
                          {res.lead.utm_source}
                        </span>
                      )}
                      {res.status === 'ausente' && (
                        <span className="px-2 py-0.5 bg-blue-900/30 text-blue-400 text-[9px] font-bold rounded flex items-center space-x-1">
                          <CheckCircle2 size={10} />
                          <span>Ausente (Pronto)</span>
                        </span>
                      )}
                      {res.status === 'existente' && (
                        <span className="px-2 py-0.5 bg-green-900/30 text-green-400 text-[9px] font-bold rounded flex items-center space-x-1">
                          <CheckCircle2 size={10} />
                          <span>Existente</span>
                        </span>
                      )}
                      {res.status === 'duplicado_csv' && (
                        <span className="px-2 py-0.5 bg-amber-900/30 text-amber-400 text-[9px] font-bold rounded flex items-center space-x-1">
                          <AlertTriangle size={10} />
                          <span>Duplicado CSV</span>
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex justify-start">
            <button
              onClick={() => setStep('mapping')}
              className="px-4 py-2 bg-transparent hover:bg-zinc-800 border border-zinc-800 text-zinc-400 rounded-lg text-xs font-semibold transition"
            >
              Voltar ao Mapeamento
            </button>
          </div>
        </div>
      )}

      {step === 'completed' && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center space-y-4">
          <div className="p-3 bg-green-500/20 text-green-500 rounded-full">
            <CheckCircle2 size={36} />
          </div>
          <div className="text-center space-y-1">
            <p className="text-base font-semibold text-zinc-200">Reconciliação Concluída!</p>
            <p className="text-xs text-zinc-500">Todos os leads selecionados foram inseridos no Flow com sucesso.</p>
          </div>
          <button
            onClick={() => {
              setFile(null);
              setResults([]);
              setStep('upload');
            }}
            className="px-5 py-2.5 bg-zinc-850 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg text-xs font-semibold transition"
          >
            Iniciar Outra Importação
          </button>
        </div>
      )}
    </div>
  );
}
