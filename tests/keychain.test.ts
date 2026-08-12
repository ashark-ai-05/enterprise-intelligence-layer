import { describe, expect, it, vi } from "vitest";
import {
  type CredentialProfile,
  type CredentialStore,
  MacOsKeychainStore,
  credentialsEnvironment,
  openCredentialStore,
} from "../src/credentials/keychain.js";

const jira: CredentialProfile = {
  source: "jira",
  url: "https://jira.example.test",
  principal: "account-1",
  email: "agent@example.test",
  token: "pat-secret",
};

describe("OS keychain credentials", () => {
  it("stores and reads a profile through macOS Keychain without a shell", async () => {
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === "find-generic-password") return JSON.stringify(jira);
      return "";
    });
    const store = new MacOsKeychainStore(run);
    await store.set(jira);
    expect(run.mock.calls[0]?.[0]).toBe("security");
    expect(run.mock.calls[0]?.[1]).toContain("add-generic-password");
    await expect(store.get("jira")).resolves.toEqual(jira);
  });

  it("treats keychain item-not-found as an absent profile", async () => {
    const error = Object.assign(new Error("not found"), { code: 44 });
    const store = new MacOsKeychainStore(async () => {
      throw error;
    });
    await expect(store.get("confluence")).resolves.toBeNull();
    await expect(store.remove("confluence")).resolves.toBe(false);
  });

  it("loads keychain values while preserving explicit environment overrides", async () => {
    const store: CredentialStore = {
      set: vi.fn(),
      remove: vi.fn(),
      get: vi.fn(async (source) => (source === "jira" ? jira : null)),
    };
    const environment = await credentialsEnvironment(store, {
      EIL_JIRA_TOKEN: "one-run-override",
      EIL_JIRA_URL: "https://override.example.test",
    });
    expect(environment.EIL_JIRA_TOKEN).toBe("one-run-override");
    expect(environment.EIL_JIRA_URL).toBe("https://override.example.test");
    // A token override makes the whole stored profile opt-out; metadata cannot
    // accidentally mix credentials from two identities.
    expect(environment.EIL_JIRA_PRINCIPAL).toBeUndefined();
  });

  it("fails clearly on unsupported OSes instead of writing a plaintext fallback", () => {
    expect(() => openCredentialStore("win32")).toThrow("not yet supported");
  });
});
