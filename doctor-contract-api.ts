/**
 * OpenClaw Doctor contract for the VK plugin.
 *
 * OpenClaw Doctor treats an external channel plugin as "state migration
 * pending" until the plugin reports its retained state migrations. VK keeps
 * every durable value in OpenClaw-owned config and secrets, so there is
 * nothing to migrate: the surface is declared explicitly with an empty list.
 *
 * `openclaw.plugin.json` → `doctorContract.stateMigrations` must mirror this
 * array exactly (ids, order, `doctorOnly`, `phase`); Doctor refuses the plugin
 * when the declaration and the export diverge.
 */
export type VkDoctorStateMigration = {
  id: string;
  label: string;
  doctorOnly?: true;
  phase?: "after-session-repair";
  detectLegacyState: (...args: never[]) => unknown;
  migrateLegacyState: (...args: never[]) => unknown;
};

export const stateMigrations: readonly VkDoctorStateMigration[] = [];
