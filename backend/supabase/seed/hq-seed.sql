-- BRP HQ demo accounts. Runs after seed.sql (needs the profiles trigger) and before hq-seed-data.sql.
-- Two demo accounts on the same published password as the other demo accounts (BRPdemo2026!):
--   owner@brp.demo    HQ owner (BRP role admin, demo). Sees and changes sample HQ rows only.
--   partner@brp.demo  HQ partner for Rynoc (BRP role cor, read-only on operations data). Sees Rynoc tasks and shared rows.
-- The site lead view uses the existing sitelead@brp.demo (Fort Stewart).
-- Andrew's own account is NOT made here: an Admin is already an HQ owner, and hq_set_member adds anyone else.
do $$
declare a record; v_id uuid;
begin
  for a in select * from (values ('owner@brp.demo', 'HQ owner (demo)', 'admin', 'owner', 'Andrew'),
                                 ('partner@brp.demo', 'Rynoc partner (demo)', 'cor', 'partner', 'Rynoc')) x(email, full_name, role, hq_role, party) loop
   begin
    select id into v_id from auth.users where lower(email) = a.email;
    if v_id is null then
      v_id := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                              created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', a.email,
              extensions.crypt('BRPdemo2026!', extensions.gen_salt('bf')), now(),
              jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'brp_role', a.role, 'brp_active', true, 'brp_demo', true),
              jsonb_build_object('full_name', a.full_name), now(), now(), '', '', '', '');
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', a.email, 'email_verified', true), 'email', now(), now(), now());
    else
      insert into public.profiles (id, email, full_name, role, active, demo) values (v_id, a.email, a.full_name, a.role, true, true)
      on conflict (id) do nothing;
    end if;
    insert into public.hq_members (profile_id, hq_role, party) values (v_id, a.hq_role, a.party)
    on conflict (profile_id) do update set hq_role = excluded.hq_role, party = excluded.party;
   exception when insufficient_privilege then
     raise warning 'Could not write auth.users for %. Create it with supabase/seed/create-demo-users.mjs, then run this file again.', a.email;
   end;
  end loop;
end $$;
