import { env } from "./env.js";

/** Who may do what. The owner (OWNER_ID on the host) can do everything; the admins set in the control panel can use the features, and the AI too when the panel says so. */
export const isOwner = id => env.owners.includes(id);
export const isAdmin = (config, id) => isOwner(id) || (config.admins ?? []).includes(id);
export const mayUseAi = (config, id) => isOwner(id) || (config.ai?.access === "admins" && (config.admins ?? []).includes(id));
export const mentions = (config, enabled = true) => enabled ? [...new Set([...(config.admins ?? []), ...(config.admins?.length ? [] : env.owners)])].map(id => `<@${id}>`).join(" ") : "";
