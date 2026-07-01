/**
 * KeySmith — Tubi's Bedrock Token Vending Machine.
 *
 * We do not hold AWS credentials. Instead we sign a request with our KeySmith
 * key (HMAC-SHA256) and receive a short-lived Bedrock *bearer* token plus the
 * Application Inference Profile ARNs our profile is allowed to invoke. The
 * token feeds the Agent SDK via AWS_BEARER_TOKEN_BEDROCK; the ARN is the only
 * model id the token's IAM role may call (the plain inference-profile id is
 * denied by a service control policy).
 *
 * Token lifecycle: mint-on-demand with a single cached value, refreshed ~5 min
 * before expiry. A failed mint throws (never caches) and lets the pipeline move
 * the Thread to `error` for retry next poll cycle — we do not retry here.
 *
 * See https://keysmith.int.tubi.io/docs
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
  /** Application Inference Profile ARN for the configured model — the SDK `model`. */
  modelArn: string;
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
      `KeySmith: missing ${name}. Set it in .env (see .env.example).`
    );
  }
  return v;
}

/** POST a signed token request and return the parsed response. Throws on failure. */
async function mint(): Promise<BedrockSession> {
  const cfg = loadConfig();
  const url = requireEnv("KEYSMITH_URL");
  const keyId = requireEnv("KEYSMITH_KEY_ID");
  const secret = requireEnv("KEYSMITH_SECRET");

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
      `KeySmith: token request failed (network): ${(err as Error).message}`
    );
  }
  if (!res.ok) {
    // Surface status + a short body excerpt to aid debugging (signature/timestamp
    // errors show here). Never logs the token or secret.
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `KeySmith: token request rejected ${res.status} ${res.statusText}: ${text}`
    );
  }

  const data = (await res.json()) as TokenResponse;
  const want = cfg.bedrockModelName;
  const match = data.models?.find((m) => m.name === want);
  if (!match) {
    const available = (data.models ?? []).map((m) => m.name).join(", ");
    throw new Error(
      `KeySmith: model "${want}" not in profile "${data.profile}". Available: ${available || "(none)"}`
    );
  }

  return {
    token: data.token,
    region: data.region,
    modelArn: match.modelId,
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
