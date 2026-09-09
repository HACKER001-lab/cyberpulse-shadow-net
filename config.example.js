/* -----------------------------------------------------------------------
 * CyberPulse: Shadow Net — runtime configuration
 * -----------------------------------------------------------------------
 * Copy this file to config.js and fill in your project values, or let
 * build.sh generate config.js from the SUPABASE_URL / SUPABASE_ANON_KEY
 * environment variables during a Cloudflare Pages build.
 *
 * The anon key is a PUBLIC key. It is safe in the browser because every
 * table is protected by row level security and every state change goes
 * through a SECURITY DEFINER database function.
 *
 * NEVER place the service_role / secret key in this file.
 * --------------------------------------------------------------------- */
window.CYBERPULSE_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-PUBLIC-ANON-KEY'
};
