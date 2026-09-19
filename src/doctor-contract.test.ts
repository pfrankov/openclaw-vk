import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";

type ManifestStateMigrationDescriptor = {
  id: string;
  doctorOnly?: true;
  phase?: "after-session-repair";
};

type PluginManifest = {
  doctorContract?: {
    stateMigrations?: ManifestStateMigrationDescriptor[] | boolean;
  };
};

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as PluginManifest;

// Mirrors the descriptor shape OpenClaw Doctor compares against the exported contract.
function describeExportedMigrations(): ManifestStateMigrationDescriptor[] {
  return stateMigrations.map((migration) => ({
    id: migration.id,
    ...(migration.doctorOnly === true ? { doctorOnly: true as const } : {}),
    ...(migration.phase === "after-session-repair"
      ? { phase: "after-session-repair" as const }
      : {}),
  }));
}

describe("doctor contract", () => {
  it("declares the state-migration surface in the manifest without any migrations", () => {
    expect(manifest.doctorContract).toEqual({ stateMigrations: [] });
  });

  it("exports a state-migration list that matches the manifest declaration exactly", () => {
    const declared = manifest.doctorContract?.stateMigrations;

    expect(Array.isArray(declared)).toBe(true);
    expect(describeExportedMigrations()).toEqual(declared);
  });

  it("keeps the VK plugin stateless for Doctor", () => {
    expect(stateMigrations).toEqual([]);
  });
});
