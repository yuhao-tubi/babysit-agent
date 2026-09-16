/**
 * Bedrock auth via a Token Vending Machine (TVM).
 *
 * We do not hold AWS credentials. Instead we sign a request with our TVM key
 * (HMAC-SHA256) and receive a short-lived Bedrock *bearer* token plus the
 * Application Inference Profile ARNs our profile is allowed to invoke. The
 * token feeds the Agent SDK via AWS_BEARER_TOKEN_BEDROCK; the ARN is the only
 * model id the token's IAM role may call (the plain inference-profile id is
 * denied by a service control policy).
 *
 * The vendor endpoint is entirely configuration: set BEDROCK_TVM_URL,
 * BEDROCK_TVM_KEY_ID and BEDROCK_TVM_SECRET in `.env` (see `.env.example`).
 * The wire protocol is a signed `POST /api/v1/tokens` — see `mint()` below for
 * the exact signing string and headers if you point this at your own service.
 *
 * Token lifecycle: mint-on-demand with a single cached value, refreshed ~5 min
 * before expiry. A failed mint throws (never caches) and lets the pipeline move
 * the Thread to `error` for retry next poll cycle — we do not retry here.
 */
import { createHash, createHmac } from "node:crypto";
import { loadConfig } from "./config.js";

const TOKEN_PATH = "/api/v1/tokens";
const TTL_SECONDS = 3600;
/** Re-mint this long before the hard expiry so a token can't lapse mid-query. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface BedrockSession {
  /** Bedrock bearer token (→ AWS_BEARER_TOKEN_BEDROCK). Treat as a secret. */
  token: string;
  /** Region the token is scoped to (→ AWS_REGION). */
  region: string;
  /** Application Inference Profile ARN for the configured DEFAULT model (`bedrockModelName`) — the SDK `model`. */
  modelArn: string;
  /**
   * ALL model ARNs the minted token may invoke, keyed by the TVM's friendly name
   * (e.g. `claude-opus`, `claude-sonnet`). One token covers every model in the
   * profile (see `allowedModels` in the token response), so a caller can pick a
   * cheaper/faster model per task WITHOUT minting a second token. Resolve via
   * `resolveModelArn`.
   */
  models: Record<string, string>;
  /** Epoch ms after which the token must be re-minted. */
  expiresAt: number;
}

interface TokenResponse {
  token: string;
  expiresIn: number;
  region: string;
  profile: string;
  allowedModels: string[];
  models: { name: string; modelId: string }[];
}

let cache: BedrockSession | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `bedrock-auth: missing ${name}. Set it in .env (see .env.example).`
    );
  }
  return v;
}

/** POST a signed token request and return the parsed response. Throws on failure. */
async function mint(): Promise<BedrockSession> {
  const cfg = loadConfig();
  const url = requireEnv("BEDROCK_TVM_URL");
  const keyId = requireEnv("BEDROCK_TVM_KEY_ID");
  const secret = requireEnv("BEDROCK_TVM_SECRET");

  const body = JSON.stringify({ ttlSeconds: TTL_SECONDS });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signingString = `POST\n${TOKEN_PATH}\n${timestamp}\n${bodyHash}`;
  const signature = createHmac("sha256", secret)
    .update(signingString)
    .digest("hex");

  let res: Response;
  try {
    res = await fetch(`${url}${TOKEN_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BTV-App-Id": keyId,
        "X-BTV-Timestamp": timestamp,
        "X-BTV-Signature": `hmac-sha256=${signature}`,
      },
      body,
    });
  } catch (err) {
    throw new Error(
      `bedrock-auth: token request failed (network): ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    // Surface status + a short body excerpt to aid debugging (signature/timestamp
    // errors show here). Never logs the token or secret.
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `bedrock-auth: token request rejected ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as TokenResponse;
  const want = cfg.bedrockModelName;
  const match = data.models?.find((m) => m.name === want);
  if (!match) {
    const available = (data.models ?? []).map((m) => m.name).join(", ");
    throw new Error(
      `bedrock-auth: model "${want}" not in profile "${data.profile}". Available: ${available || "(none)"}`
    );
  }

  // Keep every vended ARN so a caller can invoke a non-default model (e.g. the
  // read-only overview/risk/quiz artifacts on sonnet) under the SAME token.
  const models: Record<string, string> = {};
  for (const m of data.models ?? []) models[m.name] = m.modelId;

  return {
    token: data.token,
    region: data.region,
    modelArn: match.modelId,
    models,
    expiresAt: Date.now() + data.expiresIn * 1000,
  };
}

/**
 * Return a valid Bedrock session, minting a fresh token if the cache is empty
 * or within REFRESH_MARGIN_MS of expiry. Concurrent callers may briefly double
 * mint — harmless and intentionally not guarded.
 */
export async function getBedrockSession(): Promise<BedrockSession> {
  if (cache && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS) return cache;
  cache = await mint();
  return cache;
}

/** One-shot `InvokeModel` request. No tools, no multi-turn loop — just text in, text out. */
export interface InvokeModelInput {
  /** System prompt. */
  system: string;
  /** The single user message. */
  prompt: string;
  maxTokens: number;
  /**
   * Sampling temperature — sent ONLY when given, and current models reject it.
   * Sonnet 5 / Opus 5 and the 4.6+ family removed the sampling parameters
   * (`temperature`/`top_p`/`top_k`) and answer a request carrying one with
   * `400 "temperature is deprecated for this model"`. Since `invokeModel` is the
   * whole surface for the tool-less paths (AI-refine, the Verdict pre-triage),
   * defaulting it meant BOTH of them 400'd on every call the moment the
   * configured model moved forward — silently, because the pre-triage is
   * fail-open and refine's failure only shows as a dead button.
   *
   * So: no default. Leave it unset unless a caller has pinned a model old enough
   * to accept it. Determinism now comes from the prompt, not from `temperature: 0`.
   */
  temperature?: number;
  /** Friendly model name; omit for the default (`bedrockModelName`). */
  modelName?: string;
  /** Hard wall-clock cap. A hung connection must never stall a caller (default 30s). */
  timeoutMs?: number;
  /** Prefix for thrown error messages, e.g. "refine" / "pre-triage". */
  label: string;
}

/**
 * The single direct-Bedrock call path for one-shot, tool-less model use (the
 * dashboard's AI-refine helper, the Verdict pre-triage). Agent runs go through
 * the Agent SDK with `sdkEnv()` instead — this is deliberately the ONE other
 * surface, so URL/auth/body/timeout/response-shape live in exactly one place.
 *
 * Throws on network failure, a non-2xx response, or the timeout; callers decide
 * whether that is fatal or a fall-through.
 */
export async function invokeModel(input: InvokeModelInput): Promise<string> {
  const { token, region } = await getBedrockSession();
  const modelArn = await resolveModelArn(input.modelName);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(
    modelArn
  )}/invoke`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: input.maxTokens,
        // Omitted unless a caller explicitly asks for it — see InvokeModelInput.
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      }),
      // A stalled socket is worse than an error for the callers on the per-repo
      // SerialQueue: it holds the queue open with nothing to show for it.
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new Error(`${input.label}: Bedrock request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${input.label}: Bedrock rejected ${res.status} ${res.statusText}: ${text}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * Resolve the inference-profile ARN for a friendly model name (e.g.
 * `claude-sonnet`) under the current token. `undefined`/empty falls back to the
 * default model (`bedrockModelName`). Throws if the requested name isn't one the
 * token may invoke — a config typo should fail loudly, not silently downgrade.
 */
export async function resolveModelArn(name?: string): Promise<string> {
  const session = await getBedrockSession();
  if (!name) return session.modelArn;
  const arn = session.models[name];
  if (!arn) {
    const available = Object.keys(session.models).join(", ");
    throw new Error(
      `bedrock-auth: model "${name}" not vended by the current token. Available: ${available || "(none)"}`
    );
  }
  return arn;
}
