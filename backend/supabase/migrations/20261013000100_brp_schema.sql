-- BRP One backend, migration 1 of 3: schema.
-- Plain PostgreSQL 15+. The only Supabase-specific pieces are the auth.users table (profiles.id points at it)
-- and auth.uid(), which is read in one place (brp.uid() in migration 2). Everything else ports to any Postgres.
-- Sample data only. Nothing in the seed happened.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists brp;       -- private helpers. Not exposed through the API.
create schema if not exists brp_seed;  -- pristine copy of the demo data, used by the admin reset.

-- ---------------------------------------------------------------------------
-- Roles. The nine BRP One roles (ecosystem/HOST-API.md). Stored as stable keys.
--   soldier, technician, barracks_manager, site_lead, program_manager, buyer, cor, commander, admin
-- ---------------------------------------------------------------------------
create domain public.brp_role as text
  check (value in ('soldier','technician','barracks_manager','site_lead','program_manager','buyer','cor','commander','admin'));

create sequence public.wo_seq start 10001;     -- new work orders: WO-1xxxx
create sequence public.alert_seq start 1;      -- AL-0001
create sequence public.plist_seq start 1;      -- PL-0001
create sequence public.csat_seq start 2001;    -- CS-2001 for new satisfaction records

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------
create table public.installations (
  id            text primary key check (id ~ '^[A-Za-z0-9-]{2,40}$'),
  name          text not null,
  state         text,
  climate       text,
  lead_name     text,
  manager_name  text,
  tech_names    text[] not null default '{}',
  pilot         boolean not null default false,       -- true for the three demo pilot sites (STW, BRG, BLS)
  stats         jsonb not null default '{}'::jsonb,    -- dashboard KPIs from the sample dataset
  sample        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  full_name     text not null default '',
  role          public.brp_role not null default 'soldier',
  inst          text references public.installations(id) deferrable initially deferred,  -- null = all installations
  home_bldg     text,
  home_room     text,
  phone         text,
  active        boolean not null default false,
  demo          boolean not null default false,     -- one of the nine @brp.demo accounts
  email_alerts  boolean not null default true,
  push_alerts   boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index profiles_role_inst on public.profiles (role, inst);

create table public.buildings (
  id               text primary key,                  -- STW-412
  inst             text not null references public.installations(id) on delete cascade,
  bldg             text not null,
  type             text,
  built            int,
  floors           int check (floors between 1 and 60),
  rooms_per_floor  int,
  numbering        text not null default 'letter' check (numbering in ('letter','number','custom')),
  sensor_pod       text check (sensor_pod in ('Mold','Heat/AC','Freeze','Base')),
  stats            jsonb not null default '{}'::jsonb,
  sample           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (inst, bldg)
);

create table public.rooms (
  id              text primary key,                   -- STW-412-3F
  inst            text not null references public.installations(id) on delete cascade,
  building_id     text not null references public.buildings(id) on delete cascade,
  bldg            text not null,
  room            text not null,
  floor           int,
  room_type       text not null default '1+1' check (room_type in ('1+1','2-person','Suite','Other')),
  beds            int not null default 1 check (beds between 0 and 8),
  occupancy       text not null default 'unknown' check (occupancy in ('occupied','vacant','unknown')),
  status          text not null default 'ok' check (status in ('ok','watch','action','offline')),
  offline_reason  text,
  note            text,
  sensor_id       text,
  sensor_pod      text check (sensor_pod in ('Mold','Heat/AC','Freeze','Base')),
  sensor_rh       numeric(5,1),
  sensor_temp_f   numeric(5,1),
  sensor_wall_rh  numeric(5,1),
  sensor_state    text check (sensor_state in ('reporting','low_battery','offline')),
  sensor_read_at  timestamptz,
  sample          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (inst, bldg, room)
);
create index rooms_building on public.rooms (building_id);

-- ---------------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------------
create table public.work_orders (
  id            text primary key,                     -- WO-24366, T-2107, BRP-26-41207, WO-26-04127, new: WO-1xxxx
  ticket        text,                                 -- Soldier-facing ticket (RT-BLS-54324)
  alias         text,                                 -- ArMA number on dashboard tickets
  inst          text not null references public.installations(id),
  bldg          text not null,
  room          text not null,
  room_id       text references public.rooms(id) on delete set null,
  title         text not null,
  descr         text,
  prio          text not null check (prio in ('Emergency','Urgent','Routine')),
  status        text not null default 'open' check (status in ('open','in_progress','waiting_parts','closed')),
  step          text,                                 -- the owning app's step name, display only
  source        text not null default 'Office' check (source in ('Soldier','Field','Sensor','Office','Inspection','Dashboard')),
  origin        text not null default 'app' check (origin in ('office','field','dashboard','sim','app')),
  created_at    timestamptz not null default now(),
  due_at        timestamptz,                          -- DoD resolve clock for the priority
  closed_at     timestamptz,
  sched_at      timestamptz,
  room_down     boolean not null default false,
  tech_name     text,
  tech_id       uuid references public.profiles(id) on delete set null,
  soldier_name  text,
  soldier_id    uuid references public.profiles(id) on delete set null,
  parts         jsonb not null default '[]'::jsonb,   -- [{ sku, qty }]
  po_ids        text[] not null default '{}',
  interim       text,
  contractor    text,
  created_by    uuid,
  sample        boolean not null default false,
  updated_at    timestamptz not null default now()
);
create index work_orders_inst_status on public.work_orders (inst, status);
create index work_orders_tech on public.work_orders (tech_id);
create index work_orders_soldier on public.work_orders (soldier_id);

create table public.wo_events (
  id          bigint generated by default as identity primary key,
  wo_id       text not null references public.work_orders(id) on delete cascade,
  at          timestamptz not null default now(),
  actor_name  text,
  actor_id    uuid,
  kind        text not null default 'note',
  body        text not null
);
create index wo_events_wo on public.wo_events (wo_id, at);

-- ---------------------------------------------------------------------------
-- Parts, catalog, vendors, stock
-- ---------------------------------------------------------------------------
create table public.vendors (
  id          text primary key,
  name        text not null,
  city        text,
  cat         text,
  terms       text,
  contact     text,
  sample      boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- The cited research catalog (research/parts-catalog.json). Sources and price basis labels are kept as published.
create table public.catalog_items (
  id                          text primary key,       -- H01, P07, BRP-RS1-GW
  name                        text not null,
  category                    text not null,
  description                 text,
  typical_spec                jsonb,
  manufacturer                text,
  mfr_part_number             text,
  mfr_part_number_source_url  text,
  nsn                         text,                   -- only when found on a public page; never invented
  nsn_source_url              text,
  price_low                   numeric(12,2),
  price_high                  numeric(12,2),
  price_currency              text,
  price_unit                  text,
  price_basis                 text check (price_basis in ('listing_page_opened','search_index_snapshot','dod_standard_price')),
  price_basis_label           text,
  price_as_of                 date,
  price_note                  text,
  lead_time                   text,
  fixes_failures              text[] not null default '{}',
  status                      text,
  notes                       text,
  sources                     jsonb not null default '[]'::jsonb,   -- [{ title, publisher, date, url, date_kind }]
  stocked_for                 text[] not null default '{}',
  updated_at                  timestamptz not null default now()
);

create table public.parts (
  sku          text primary key,
  name         text not null,
  cat          text,
  cost         numeric(12,2),                         -- sample cost, USD
  vendor_id    text references public.vendors(id) on delete set null,
  lead_days    int,
  rop          int,                                   -- reorder point, per cabinet (sample)
  roq          int,                                   -- reorder quantity (sample)
  catalog_id   text references public.catalog_items(id) on delete set null,
  design_only  boolean not null default false,        -- BRP-RS1 family: design, not yet built
  sample       boolean not null default true,
  updated_at   timestamptz not null default now()
);

create table public.cabinets (
  id          text primary key,                       -- CAB-STW, CAB-412
  inst        text not null references public.installations(id) on delete cascade,
  name        text not null,
  kind        text not null default 'cage' check (kind in ('cage','field')),
  sample      boolean not null default true
);

create table public.stock (
  cabinet_id  text not null references public.cabinets(id) on delete cascade,
  sku         text not null references public.parts(sku) on delete cascade,
  inst        text not null references public.installations(id) on delete cascade,
  qty         int not null default 0 check (qty >= 0),
  rop         int,
  roq         int,
  updated_at  timestamptz not null default now(),
  primary key (cabinet_id, sku)
);

-- ---------------------------------------------------------------------------
-- Purchasing
-- ---------------------------------------------------------------------------
create table public.purchase_orders (
  id           text primary key,                      -- BRP-STW-27-0430
  wo_id        text references public.work_orders(id) on delete set null,
  kind         text not null default 'work_order' check (kind in ('work_order','replenishment')),
  inst         text not null references public.installations(id),
  vendor_id    text references public.vendors(id),
  status       text not null default 'requested' check (status in ('requested','issued','shipped','backordered','received','cancelled')),
  total        numeric(12,2) not null default 0,
  issued_at    timestamptz,
  eta          timestamptz,
  flag         int not null default 0,
  carrier      text,
  tracking     text,
  received_at  timestamptz,
  created_by   uuid,
  sample       boolean not null default false,
  updated_at   timestamptz not null default now()
);
create index purchase_orders_inst on public.purchase_orders (inst, status);

create table public.po_lines (
  id         bigint generated by default as identity primary key,
  po_id      text not null references public.purchase_orders(id) on delete cascade,
  sku        text not null references public.parts(sku),
  qty        int not null check (qty > 0),
  unit_cost  numeric(12,2)
);
create index po_lines_po on public.po_lines (po_id);

-- The purchasing list: items people asked to buy that are not on a PO yet.
-- Also the store for the BRP One purchasing module (brp-purchasing.js), which upserts rows keyed by its own line id
-- (for example 'D01') with { id, status, note, po_id, updated_at, updated_by }. Those rows may carry no installation
-- (inst null = program-wide); only roles that see every installation can read or write them.
create table public.purchase_list (
  id                 text primary key default ('PL-' || lpad(nextval('public.plist_seq')::text, 4, '0')),
  inst               text references public.installations(id),
  sku                text references public.parts(sku) on delete set null,
  catalog_id         text references public.catalog_items(id) on delete set null,
  description        text not null default '',
  qty                int not null default 1 check (qty > 0),
  est_unit_cost      numeric(12,2),
  vendor_id          text references public.vendors(id) on delete set null,
  reason             text,
  note               text,
  source             text not null default 'manual' check (source in ('requisition','low_stock','manual','work_order','purchasing_module')),
  wo_id              text references public.work_orders(id) on delete set null,
  status             text not null default 'requested' check (status in ('not_ordered','requested','approved','ordered','received','cancelled')),
  po_id              text,                     -- a purchase_orders id when ordered through BRP; free text for the purchasing module
  requested_by       uuid,
  requested_by_name  text,
  needed_by          date,
  sample             boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         text                      -- email of the last person to change the row
);

-- ---------------------------------------------------------------------------
-- Satisfaction
-- ---------------------------------------------------------------------------
create table public.satisfaction (
  id        text primary key default ('CS-' || nextval('public.csat_seq')::text),
  at        timestamptz not null default now(),
  inst      text not null references public.installations(id),
  bldg      text,
  room      text,
  wo_id     text,
  channel   text not null default 'app' check (channel in ('app','text','wall','pulse')),
  score     int not null check (score between 1 and 5),
  scale     text not null default '3' check (scale in ('3','5')),
  text      text,
  anon      boolean not null default true,
  by_name   text,          -- null when anon
  by_id     uuid,          -- null when anon, so staff can never re-identify an anonymous answer
  sample    boolean not null default false
);
create index satisfaction_inst_at on public.satisfaction (inst, at desc);

-- ---------------------------------------------------------------------------
-- Alerts, email outbox, push tokens
-- ---------------------------------------------------------------------------
create table public.alerts (
  id               text primary key default ('AL-' || lpad(nextval('public.alert_seq')::text, 4, '0')),
  at               timestamptz not null default now(),
  type             text not null default 'custom' check (type in ('wo.emergency','clock.risk','clock.missed','part.delivered','part.backorder','verify.failed','sensor.threshold','target.missed','setup.failures','custom')),
  severity         text not null default 'info' check (severity in ('critical','high','info')),
  title            text not null,
  body             text,
  inst             text references public.installations(id),
  ref              text,                                -- tag, for example wo:WO-24366
  tags             text[] not null default '{}',
  created_by       uuid,
  created_by_name  text,
  sample           boolean not null default false
);
create index alerts_at on public.alerts (at desc);

create table public.alert_recipients (
  id           bigint generated by default as identity primary key,
  alert_id     text not null references public.alerts(id) on delete cascade,
  profile_id   uuid references public.profiles(id) on delete set null,
  email        text not null,
  name         text,
  role         text,
  read_at      timestamptz,
  push_status  text not null default 'none' check (push_status in ('none','not_configured','no_token','sent','failed','off')),
  unique (alert_id, email)
);
create index alert_recipients_profile on public.alert_recipients (profile_id);

-- One row per tagged person per alert. status 'logged' means written here and not sent (the demo default).
create table public.email_outbox (
  id                   bigint generated by default as identity primary key,
  alert_id             text references public.alerts(id) on delete cascade,
  inst                 text,
  to_email             text not null,
  to_name              text,
  to_role              text,
  subject              text not null,
  body                 text not null,
  status               text not null default 'logged' check (status in ('logged','queued','sent','failed','suppressed')),
  provider             text,
  provider_message_id  text,
  error                text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz
);
create index email_outbox_created on public.email_outbox (created_at desc);

create table public.push_tokens (
  id            bigint generated by default as identity primary key,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  platform      text not null check (platform in ('ios','android','web')),
  token         text not null unique,
  environment   text not null default 'production' check (environment in ('sandbox','production')),
  device_name   text,
  app_version   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  disabled_at   timestamptz,
  last_error    text
);
create index push_tokens_profile on public.push_tokens (profile_id) where disabled_at is null;

-- ---------------------------------------------------------------------------
-- Audit and settings
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated by default as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid,
  actor_email  text,
  actor_role   text,
  action       text not null,                     -- insert | update | delete | role.change | demo.reset | ...
  table_name   text,
  row_id       text,
  old_row      jsonb,
  new_row      jsonb
);
create index audit_log_at on public.audit_log (at desc);

create table public.settings (
  key         text primary key,
  value       jsonb not null,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
insert into public.settings (key, value, note) values
  ('email_delivery', '{"enabled": false}', 'Second switch for real email. The notify function also needs EMAIL_PROVIDER set. Demo accounts (@brp.demo) are never emailed.'),
  ('demo_clock', '{"anchor": "2026-10-07T08:00:00-04:00"}', 'The sample data runs on Oct 7, 2026, 8:00 AM Eastern.');

-- ---------------------------------------------------------------------------
-- Seed snapshot tables (same columns as the live tables, no constraints).
-- ---------------------------------------------------------------------------
create table brp_seed.installations    (like public.installations);
create table brp_seed.buildings        (like public.buildings);
create table brp_seed.rooms            (like public.rooms);
create table brp_seed.work_orders      (like public.work_orders);
create table brp_seed.wo_events        (like public.wo_events);
create table brp_seed.vendors          (like public.vendors);
create table brp_seed.catalog_items    (like public.catalog_items);
create table brp_seed.parts            (like public.parts);
create table brp_seed.cabinets         (like public.cabinets);
create table brp_seed.stock            (like public.stock);
create table brp_seed.purchase_orders  (like public.purchase_orders);
create table brp_seed.po_lines         (like public.po_lines);
create table brp_seed.purchase_list    (like public.purchase_list);
create table brp_seed.satisfaction     (like public.satisfaction);
create table brp_seed.alerts           (like public.alerts);
create table brp_seed.alert_recipients (like public.alert_recipients);
create table brp_seed.email_outbox     (like public.email_outbox);
create table brp_seed.demo_accounts (
  email      text primary key,
  full_name  text not null,
  role       text not null,
  inst       text,
  home_bldg  text,
  home_room  text
);
