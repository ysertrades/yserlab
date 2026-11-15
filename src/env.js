import "dotenv/config";

// Every setting the host gives the bot. Only the token is required to start; the rest turn features on.
process.env.TZ = "America/New_York"; // dates on cards follow your trading day (the shared card code reads local dates)

const first = (...names) => names.map(n => process.env[n]?.trim()).find(Boolean) ?? "";

export const env = {
  token: first("DISCORD_TOKEN", "TOKEN", "BOT_TOKEN"),
  /** Your Discord user id(s), comma separated. The owner can always use everything. */
  owners: first("OWNER_ID", "OWNER_IDS").split(/[\s,]+/).filter(Boolean),
  supabaseUrl: first("SUPABASE_URL") || "https://aubplblrooadtfskdcfh.supabase.co",
  supabaseKey: first("SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
  geminiKey: first("GEMINI_API_KEY"),
  geminiModel: first("GEMINI_MODEL") || "gemini-flash-lite-latest",
};

export const missing = () => [
  !env.token && "DISCORD_TOKEN",
  !env.owners.length && "OWNER_ID",
  !env.supabaseKey && "SUPABASE_SERVICE_KEY",
].filter(Boolean);
