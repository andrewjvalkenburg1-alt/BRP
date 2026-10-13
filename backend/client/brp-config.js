/* BRP One backend config. The ONE file to edit after creating the Supabase project.
   Paste the Project URL and the anon (public) key from Supabase > Project Settings > API.
   The anon key is safe in a public repo: row-level security decides what each signed-in person can see.
   NEVER put the service_role key (or an sb_secret_ key) here. brp-backend.js refuses to start with one.
   Leave both empty to run the apps in local demo mode (no server, browser-only sample data). */
window.BRP_BACKEND_CONFIG = {
  url: '',      // for example 'https://abcdefghijklmnop.supabase.co'
  anonKey: ''   // for example 'eyJhbGciOi...' or 'sb_publishable_...'
};
