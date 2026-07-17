const [token] = process.argv.slice(2);
if (!token) {
  console.error("Uso: node scripts/test-lead-ingestion.mjs <webhook_token>");
  process.exit(1);
}

const baseUrl = `https://obguidmfvfjaekaskgob.supabase.co/functions/v1/receber-lead?token=${encodeURIComponent(token)}`;
const runId = Date.now().toString();
const prefix = `Codex Ingestion ${runId}`;
const results = [];

async function send(name, init) {
  const startedAt = Date.now();
  const response = await fetch(baseUrl, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  const result = {
    name,
    status: response.status,
    duration_ms: Date.now() - startedAt,
    body,
  };
  results.push(result);
  return result;
}

const jsonPhone = `1197${runId.slice(-7)}`;
await send("json_normalized", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-request-id": `${runId}-json`,
  },
  body: JSON.stringify({
    nome: `  ${prefix}   JSON  `,
    whatsapp: `+55 (11) 97${runId.slice(-7)}`,
  }),
});

const encodedPhone = `1196${runId.slice(-7)}`;
await send("urlencoded", {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-request-id": `${runId}-urlencoded`,
  },
  body: new URLSearchParams({
    nome: `${prefix} URL Encoded`,
    whatsapp: encodedPhone,
    utm_source: "codex-test",
  }),
});

const formPhone = `1195${runId.slice(-7)}`;
const form = new FormData();
form.set("nome", `${prefix} Form Data`);
form.set("whatsapp", formPhone);
form.set("cidade", "Limeira");
await send("form_data", {
  method: "POST",
  headers: { "x-request-id": `${runId}-form` },
  body: form,
});

await send("duplicate_request", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-request-id": `${runId}-json`,
  },
  body: JSON.stringify({
    nome: `${prefix} JSON`,
    whatsapp: jsonPhone,
  }),
});

await send("missing_fields_queued", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-request-id": `${runId}-invalid`,
  },
  body: JSON.stringify({ cidade: "Limeira" }),
});

const loadPhone = `1194${runId.slice(-7)}`;
for (const concurrency of [10, 50, 100]) {
  const startedAt = Date.now();
  const responses = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": `${runId}-load-${concurrency}-${index}`,
        },
        body: JSON.stringify({
          nome: `${prefix} Load`,
          whatsapp: loadPhone,
        }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => ({})),
      };
    }),
  );

  results.push({
    name: `load_${concurrency}`,
    duration_ms: Date.now() - startedAt,
    requests: concurrency,
    http_success: responses.filter((item) => item.status === 200).length,
    created: responses.filter((item) => item.body.created).length,
    duplicates: responses.filter((item) => item.body.duplicate).length,
    queued: responses.filter((item) => item.body.queued).length,
    lead_ids: [...new Set(responses.map((item) => item.body.lead_id).filter(Boolean))],
  });
}

const invalidTokenResponse = await fetch(
  "https://obguidmfvfjaekaskgob.supabase.co/functions/v1/receber-lead?token=invalid-codex-load-test",
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `${runId}-invalid-token`,
    },
    body: "{}",
  },
);
results.push({
  name: "invalid_token",
  status: invalidTokenResponse.status,
  body: await invalidTokenResponse.json().catch(() => ({})),
});

console.log(JSON.stringify({
  run_id: runId,
  prefix,
  phones: [jsonPhone, encodedPhone, formPhone, loadPhone],
  results,
}, null, 2));
