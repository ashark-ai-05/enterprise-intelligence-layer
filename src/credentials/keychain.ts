import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SERVICE = "enterprise-intelligence-layer";

export const CREDENTIAL_SOURCES = ["confluence", "jira", "bitbucket"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface CredentialProfile {
  source: CredentialSource;
  url: string;
  token: string;
  principal: string;
  email?: string;
}

export interface CredentialStore {
  set(profile: CredentialProfile): Promise<void>;
  get(source: CredentialSource): Promise<CredentialProfile | null>;
  remove(source: CredentialSource): Promise<boolean>;
}

type Run = (file: string, args: readonly string[]) => Promise<string>;

async function systemRun(
  file: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFile(file, args, { encoding: "utf8" });
  return result.stdout;
}

/** macOS Keychain-backed credentials. Secrets never enter EIL's database. */
export class MacOsKeychainStore implements CredentialStore {
  constructor(private readonly run: Run = systemRun) {}

  async set(profile: CredentialProfile): Promise<void> {
    // `security` has no stdin form for add-generic-password. The value is
    // passed directly to execFile (never a shell), then retained only by the
    // OS keychain. It is never logged or persisted by EIL.
    await this.run("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      profile.source,
      "-w",
      JSON.stringify(profile),
    ]);
  }

  async get(source: CredentialSource): Promise<CredentialProfile | null> {
    try {
      const value = await this.run("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        source,
        "-w",
      ]);
      return parseProfile(value.trim(), source);
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 44) return null;
      throw error;
    }
  }

  async remove(source: CredentialSource): Promise<boolean> {
    try {
      await this.run("security", [
        "delete-generic-password",
        "-s",
        SERVICE,
        "-a",
        source,
      ]);
      return true;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 44) return false;
      throw error;
    }
  }
}

function parseProfile(
  value: string,
  expected: CredentialSource,
): CredentialProfile {
  const parsed = JSON.parse(value) as Partial<CredentialProfile>;
  if (
    parsed.source !== expected ||
    typeof parsed.url !== "string" ||
    typeof parsed.token !== "string" ||
    typeof parsed.principal !== "string"
  ) {
    throw new Error(`Invalid ${expected} credential profile in OS keychain`);
  }
  return {
    source: expected,
    url: parsed.url,
    token: parsed.token,
    principal: parsed.principal,
    ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
  };
}

export function openCredentialStore(
  platform = process.platform,
): CredentialStore {
  if (platform === "darwin") return new MacOsKeychainStore();
  throw new Error(
    `OS keychain credentials are not yet supported on ${platform}. Use EIL_* environment variables for this run; EIL will not store them.`,
  );
}

export async function credentialsEnvironment(
  store: CredentialStore,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const merged = { ...environment };
  for (const source of CREDENTIAL_SOURCES) {
    const prefix = `EIL_${source.toUpperCase()}`;
    // Explicit environment values are ephemeral overrides and always win.
    if (merged[`${prefix}_TOKEN`]) continue;
    const profile = await store.get(source);
    if (!profile) continue;
    merged[`${prefix}_URL`] ??= profile.url;
    merged[`${prefix}_TOKEN`] = profile.token;
    merged[`${prefix}_PRINCIPAL`] ??= profile.principal;
    if (profile.email) merged[`${prefix}_EMAIL`] ??= profile.email;
  }
  return merged;
}

export function isCredentialSource(value: string): value is CredentialSource {
  return CREDENTIAL_SOURCES.includes(value as CredentialSource);
}
