// deno-lint-ignore-file no-explicit-any
import "@supabase/functions-js/edge-runtime.d.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

type JsonRecord = Record<string, unknown>;

type ParsedRequest = {
  rawBody: string;
  body: JsonRecord;
  contentType: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROVIDER = "inlead";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id, X-Webhook-Token",
  "Content-Type": "application/json",
};

const REST_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

function jsonResponse(payload: JsonRecord, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: CORS });
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeHeaders(headers: Headers) {
  const allowed = ["content-type", "content-length", "user-agent", "x-request-id", "x-forwarded-for"];
  return Object.fromEntries(
    allowed
      .map((name) => [name, headers.get(name)])
      .filter((entry) => entry[1] != null),
  );
}

async function saveLog(
  eventType: string,
  status: string,
  payload: JsonRecord,
  orgId?: string | null,
) {
  try {
    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/webhook_logs`,
      {
        method: "POST",
        headers: { ...REST_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({
          event_type: eventType,
          status,
          payload,
          ...(orgId ? { org_id: orgId } : {}),
        }),
      },
      3500,
    );

    if (!response.ok) {
      console.error("[receber-lead] log_failed", eventType, response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("[receber-lead] log_exception", eventType, String(error));
    return false;
  }
}

function normalizeName(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeWhatsapp(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return digits.slice(2);
  }
  return digits;
}

function normalizeKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(field|fields|input|answer|resposta|respostas|campo|custom field)\s*:\s*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function valueToText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const object = value as JsonRecord;
    const direct = object.value ?? object.label ?? object.name ?? object.text ?? object.title ?? object.answer;
    return direct != null ? valueToText(direct) : "";
  }
  return String(value).trim();
}

function flattenPayload(value: unknown, prefix = "", depth = 0): Array<{ key: string; value: unknown; text: string }> {
  if (depth > 4 || value == null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [{ key: prefix, value, text: valueToText(value) }] : [];
  }

  return Object.entries(value as JsonRecord).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const own = [{ key: fullKey, value: child, text: valueToText(child) }];
    return typeof child === "object" && child != null
      ? own.concat(flattenPayload(child, fullKey, depth + 1))
      : own;
  });
}

function findField(body: JsonRecord, exact: string[], contains: string[] = []) {
  const fields = flattenPayload(body).map((field) => ({
    ...field,
    normalized: normalizeKey(field.key.split(".").at(-1) ?? field.key),
  }));
  const exactSet = new Set(exact.map(normalizeKey));
  const found = fields.find((field) => exactSet.has(field.normalized))
    ?? fields.find((field) => contains.some((part) => field.normalized.includes(normalizeKey(part))));
  return found?.value;
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
  } catch {
    return null;
  }
  return null;
}

function unwrapEmbeddedJson(body: JsonRecord) {
  for (const key of ["payload", "data", "body", "submission", "response", "respostas"]) {
    const value = body[key];
    if (typeof value === "string") {
      const parsed = parseJsonObject(value.trim());
      if (parsed) return { ...body, ...parsed };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...body, ...(value as JsonRecord) };
    }
  }
  return body;
}

async function parseIncomingRequest(req: Request): Promise<ParsedRequest> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch (err) {
    rawBody = "";
  }

  if (!rawBody.trim()) {
    return { rawBody, body: {}, contentType };
  }

  try {
    const json = parseJsonObject(rawBody.trim());
    if (json) {
      return { rawBody, body: unwrapEmbeddedJson(json), contentType };
    }

    if (contentType.includes("multipart/form-data")) {
      const clone = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": req.headers.get("content-type") ?? "" },
        body: rawBody,
      });
      const form = await clone.formData();
      const body: JsonRecord = {};
      for (const [key, value] of form.entries()) {
        body[key] = typeof value === "string" ? value : value.name;
      }
      return { rawBody, body: unwrapEmbeddedJson(body), contentType };
    }

    if (
      contentType.includes("application/x-www-form-urlencoded")
      || rawBody.includes("=")
    ) {
      const params = new URLSearchParams(rawBody);
      const body: JsonRecord = {};
      for (const [key, value] of params.entries()) {
        body[key] = value;
      }
      return { rawBody, body: unwrapEmbeddedJson(body), contentType };
    }

    return { rawBody, body: { raw_body: rawBody }, contentType };
  } catch (err) {
    return {
      rawBody,
      body: { error: "parse_failed", details: String(err), raw_body: rawBody },
      contentType,
    };
  }
}

function extractLead(body: JsonRecord) {
  const nome = normalizeName(findField(body, ["nome", "nome completo", "name", "full name", "lead nome"], ["nome completo"]));
  const whatsapp = normalizeWhatsapp(findField(body, ["whatsapp", "telefone", "celular", "phone", "telefone celular", "numero", "contato"], ["whatsapp", "telefone", "celular"]));
  const cidade = normalizeName(findField(body, ["cidade", "city", "municipio", "localidade"], ["cidade", "municipio"]));
  const instagram = normalizeName(findField(body, ["instagram", "insta", "usuario instagram", "perfil instagram"], ["instagram"]));

  const read = (names: string[]) => valueToText(findField(body, names));
  const scoreValue = findField(body, ["score", "pontuacao"]);
  const score = scoreValue != null && Number.isFinite(Number(scoreValue)) ? Number(scoreValue) : undefined;
  const originalCreatedAt = read([
    "created at",
    "created_at",
    "submitted at",
    "submitted_at",
    "data preenchimento",
    "horario preenchimento",
  ]);

  return {
    nome,
    whatsapp,
    cidade,
    instagram,
    status: 0,
    wa_sent: false,
    quiz_respostas: body,
    utm_source: read(["utm source", "utm_source"]),
    utm_campaign: read(["utm campaign", "utm_campaign", "campanha"]),
    utm_medium: read(["utm medium", "utm_medium", "conjunto", "adset"]),
    utm_content: read(["utm content", "utm_content", "anuncio", "ad"]),
    utm_term: read(["utm term", "utm_term"]),
    utm_id: read(["utm id", "utm_id"]),
    fbclid: read(["fbclid", "tracking fbclid"]),
    ...(score !== undefined ? { score } : {}),
    ...(originalCreatedAt ? { created_at: originalCreatedAt } : {}),
  };
}

function extractExternalEventId(body: JsonRecord, req: Request) {
  const headerId = normalizeName(req.headers.get("x-request-id"));
  if (headerId) return headerId;

  const value = findField(body, [
    "request id",
    "request_id",
    "event id",
    "event_id",
    "submission id",
    "submission_id",
    "session id",
    "session_id",
    "codigo sessao",
    "codigo formulario",
  ]);
  return normalizeName(value) || null;
}

async function resolveWebhook(token: string) {
  if (!token) return null;

  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/webhooks?select=id,org_id,ativo,nome&token=eq.${encodeURIComponent(token)}&limit=1`,
    { headers: REST_HEADERS },
    5000,
  );
  if (!response.ok) throw new Error(`webhook_lookup_failed:${response.status}`);
  const rows = await response.json();
  return rows?.[0] ?? null;
}

async function queueFailure(input: {
  orgId?: string | null;
  requestId: string;
  externalEventId?: string | null;
  rawPayload: unknown;
  leadPayload?: JsonRecord | null;
  errorCode: string;
  errorMessage: string;
  token?: string | null;
  metadata?: JsonRecord | null;
}) {
  try {
    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/failed_lead_ingestions`,
      {
        method: "POST",
        headers: { ...REST_HEADERS, Prefer: "return=representation" },
        body: JSON.stringify({
          org_id: input.orgId ?? null,
          request_id: input.requestId,
          provider: PROVIDER,
          external_event_id: input.externalEventId ?? null,
          payload: input.rawPayload,
          lead_payload: input.leadPayload ?? null,
          error_code: input.errorCode,
          error_message: input.errorMessage,
          status: "pending",
          token: input.token ?? null,
          metadata: input.metadata ?? null,
        }),
      },
      5000,
    );
    if (!response.ok) throw new Error(await response.text());
    const rows = await response.json();
    return rows?.[0]?.id ?? null;
  } catch (error) {
    console.error("[receber-lead] queue_failed", input.requestId, String(error));
    return null;
  }
}

async function ingestLead(input: {
  orgId: string;
  requestId: string;
  externalEventId: string | null;
  leadPayload: JsonRecord;
  webhookId: string;
  webhookName: string;
}) {
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/rpc/ingest_lead_webhook`,
    {
      method: "POST",
      headers: REST_HEADERS,
      body: JSON.stringify({
        p_org_id: input.orgId,
        p_provider: PROVIDER,
        p_external_event_id: input.externalEventId,
        p_request_id: input.requestId,
        p_lead: input.leadPayload,
        p_context: {
          webhook_id: input.webhookId,
          webhook_name: input.webhookName,
        },
      }),
    },
    12000,
  );

  const text = await response.text();
  if (!response.ok) throw new Error(`ingest_failed:${response.status}:${text}`);
  return JSON.parse(text) as JsonRecord;
}

async function postProcessLead(input: {
  orgId: string;
  requestId: string;
  leadId: string | number;
}) {
  const startedAt = Date.now();
  await saveLog("post_processing_started", "started", {
    request_id: input.requestId,
    org_id: input.orgId,
    lead_id: input.leadId,
    stage: "capi",
    timestamp: new Date().toISOString(),
  }, input.orgId);

  try {
    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/functions/v1/meta-capi-evento`,
      {
        method: "POST",
        headers: REST_HEADERS,
        body: JSON.stringify({
          lead_id: input.leadId,
          tipo: "lead",
          org_id: input.orgId,
        }),
      },
      8000,
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok === false) {
      throw new Error(String(result?.erro ?? `http_${response.status}`));
    }
  } catch (error) {
    await saveLog("post_processing_failed", "error", {
      request_id: input.requestId,
      org_id: input.orgId,
      lead_id: input.leadId,
      stage: "capi",
      error: String(error),
      duration_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }, input.orgId);
    return;
  }

  await saveLog("completed", "success", {
    request_id: input.requestId,
    org_id: input.orgId,
    lead_id: input.leadId,
    stage: "post_processing",
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }, input.orgId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const startedAt = Date.now();
  const receivedAt = new Date().toISOString();
  const generatedRequestId = crypto.randomUUID();
  let requestId = generatedRequestId;
  let rawBody = "";
  let body: JsonRecord = {};
  let orgId: string | null = null;
  let externalEventId: string | null = null;
  let leadPayload: JsonRecord | null = null;
  let token = "";

  try {
    const parsed = await parseIncomingRequest(req);
    rawBody = parsed.rawBody;
    body = parsed.body;
    const contentType = parsed.contentType;

    const url = new URL(req.url);
    token = url.searchParams.get("token") || req.headers.get("x-webhook-token") || "";

    const headers = safeHeaders(req.headers);
    await saveLog("request_received", "received", {
      request_id: generatedRequestId,
      received_at: receivedAt,
      method: req.method,
      url_path: url.pathname,
      content_type: contentType,
      headers_safe: headers,
      raw_body: rawBody.slice(0, 250000),
      raw_body_truncated: rawBody.length > 250000,
      stage: "request_received",
    });

    if (body.error === "parse_failed") {
      throw new Error(`payload_parsing_failed: ${body.details}`);
    }

    externalEventId = extractExternalEventId(body, req);
    requestId = externalEventId || generatedRequestId;

    await saveLog("request_parsed", "success", {
      request_id: requestId,
      generated_request_id: generatedRequestId,
      external_event_id: externalEventId,
      provider: PROVIDER,
      stage: "request_parsed",
      duration_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });

    const webhook = await resolveWebhook(token);

    if (!webhook || !webhook.ativo || !webhook.org_id) {
      await saveLog("validation_failed", webhook && !webhook.ativo ? "forbidden" : "unauthorized", {
        request_id: requestId,
        external_event_id: externalEventId,
        provider: PROVIDER,
        error: webhook && !webhook.ativo ? "webhook_inactive" : "invalid_webhook",
        token_present: Boolean(token),
        stage: "webhook_resolution",
        duration_ms: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      });
      return jsonResponse(
        { ok: false, error: webhook && !webhook.ativo ? "Webhook inativo" : "Token invalido" },
        webhook && !webhook.ativo ? 403 : 401,
      );
    }

    orgId = String(webhook.org_id);
    await saveLog("webhook_resolved", "success", {
      request_id: requestId,
      org_id: orgId,
      webhook_id: webhook.id,
      webhook_name: webhook.nome,
      provider: PROVIDER,
      external_event_id: externalEventId,
      stage: "webhook_resolved",
      duration_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }, orgId);

    leadPayload = extractLead(body);
    const nome = String(leadPayload.nome ?? "");
    const whatsapp = String(leadPayload.whatsapp ?? "");

    if (!externalEventId && orgId && whatsapp) {
      const windowMinutes = Math.floor(Date.now() / (10 * 60 * 1000));
      externalEventId = `fallback_${whatsapp}_${windowMinutes}`;
      requestId = externalEventId;
    }

    if (!nome || !whatsapp) {
      const queueId = await queueFailure({
        orgId,
        requestId,
        externalEventId,
        rawPayload: body,
        leadPayload,
        errorCode: "missing_required_fields",
        errorMessage: "Nome e WhatsApp sao obrigatorios",
        token,
        metadata: { url: req.url, headers, method: req.method },
      });

      await saveLog("failed_and_queued", "pending", {
        request_id: requestId,
        org_id: orgId,
        webhook_id: webhook.id,
        provider: PROVIDER,
        external_event_id: externalEventId,
        queue_id: queueId,
        error: "missing_required_fields",
        stage: "validation",
        duration_ms: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      }, orgId);

      if (!queueId) {
        return jsonResponse({
          ok: false,
          error: "failed_to_queue_payload",
          message: "Nome e WhatsApp sao obrigatorios, e a fila de falhas falhou",
        }, 500);
      }

      return jsonResponse({
        ok: true,
        queued: true,
        queue_id: queueId,
        message: "Payload recebido para revisao",
      }, 202);
    }

    if (whatsapp.length < 10 || whatsapp.length > 11) {
      await saveLog("invalid_phone_review", "review", {
        request_id: requestId,
        org_id: orgId,
        webhook_id: webhook.id,
        provider: PROVIDER,
        external_event_id: externalEventId,
        nome,
        whatsapp,
        stage: "validation",
        timestamp: new Date().toISOString(),
      }, orgId);
    }

    let result: JsonRecord;
    try {
      result = await ingestLead({
        orgId,
        requestId,
        externalEventId,
        leadPayload,
        webhookId: String(webhook.id),
        webhookName: String(webhook.nome ?? "Principal"),
      });
    } catch (error) {
      const queueId = await queueFailure({
        orgId,
        requestId,
        externalEventId,
        rawPayload: body,
        leadPayload,
        errorCode: "database_ingestion_failed",
        errorMessage: String(error),
        token,
        metadata: { url: req.url, headers, method: req.method },
      });

      await saveLog("failed_and_queued", "pending", {
        request_id: requestId,
        org_id: orgId,
        webhook_id: webhook.id,
        provider: PROVIDER,
        external_event_id: externalEventId,
        queue_id: queueId,
        error: String(error),
        stage: "database_ingestion",
        duration_ms: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      }, orgId);

      if (!queueId) {
        return jsonResponse({
          ok: false,
          error: "failed_to_queue_payload",
          message: String(error),
        }, 500);
      }

      return jsonResponse({
        ok: true,
        queued: true,
        queue_id: queueId,
        message: "Ingestao falhou, payload enfileirado para retry",
      }, 202);
    }

    const leadId = result.lead_id as string | number | undefined;
    const eventType = result.idempotency_hit
      ? "idempotency_hit"
      : result.created
      ? "lead_created"
      : result.updated
      ? "lead_updated"
      : "duplicate_ignored";

    await saveLog(eventType, "success", {
      request_id: requestId,
      org_id: orgId,
      webhook_id: webhook.id,
      provider: PROVIDER,
      external_event_id: externalEventId,
      lead_id: leadId,
      stage: "response",
      created: Boolean(result.created),
      updated: Boolean(result.updated),
      duplicate: Boolean(result.duplicate),
      duration_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }, orgId);

    if (leadId && result.created) {
      EdgeRuntime.waitUntil(postProcessLead({ orgId, requestId, leadId }));
    }

    return jsonResponse({
      ok: true,
      lead_id: leadId,
      created: Boolean(result.created),
      updated: Boolean(result.updated),
      duplicate: Boolean(result.duplicate),
      idempotency_hit: Boolean(result.idempotency_hit),
    });

  } catch (error) {
    const headers = safeHeaders(req.headers);
    const queueId = await queueFailure({
      orgId,
      requestId,
      externalEventId,
      rawPayload: body && Object.keys(body).length > 0 ? body : { raw_body: rawBody },
      leadPayload,
      errorCode: "unexpected_error",
      errorMessage: String(error),
      token,
      metadata: { url: req.url, headers, method: req.method },
    });

    await saveLog("failed_and_queued", "pending", {
      request_id: requestId,
      org_id: orgId,
      provider: PROVIDER,
      external_event_id: externalEventId,
      queue_id: queueId,
      error: String(error),
      stage: "unexpected",
      duration_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }, orgId);

    if (!queueId) {
      return jsonResponse({
        ok: false,
        error: "failed_to_queue_payload",
        message: String(error),
      }, 500);
    }

    return jsonResponse({
      ok: true,
      queued: true,
      queue_id: queueId,
      message: "Payload preservado para recuperacao",
    }, 202);
  }
});
