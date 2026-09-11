-- ============================================================================
-- Sunshine Gadgets POS - Supabase schema
-- Run this once in the Supabase SQL Editor for a freshly created project.
-- Mirrors the IndexedDB stores in js/db.js field-for-field (minus the
-- local-only `synced` flag, which never leaves the device).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- products
create table if not exists products (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  category       text not null default '',
  icon           text not null default '📦',
  default_price  numeric not null default 0,
  deleted        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists products_updated_at_idx on products (updated_at);
create index if not exists products_category_idx on products (category);

-- ------------------------------------------------------------------- sales
create table if not exists sales (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid,
  product_name    text not null,
  category        text not null default '',
  quantity        integer not null default 1,
  unit_price      numeric not null default 0,
  total           numeric not null default 0,
  description     text not null default '',
  payment_status  text not null default 'paid' check (payment_status in ('paid', 'credit')),
  customer_name   text not null default '',
  customer_phone  text not null default '',
  amount_paid     numeric not null default 0,
  balance         numeric not null default 0,
  sold_at         timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  device_id       text
);

create index if not exists sales_updated_at_idx on sales (updated_at);
create index if not exists sales_sold_at_idx on sales (sold_at);
create index if not exists sales_payment_status_idx on sales (payment_status);

-- ---------------------------------------------------------------- payments
create table if not exists payments (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references sales(id),
  amount      numeric not null,
  paid_at     timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  device_id   text
);

create index if not exists payments_updated_at_idx on payments (updated_at);
create index if not exists payments_sale_id_idx on payments (sale_id);

-- ============================================================================
-- Row Level Security
--
-- Permissive "anyone with the anon key can read/write everything" policy.
-- Fine for a small trusted-staff internal tool where the anon key itself is
-- the access control (counter tablet + owner's phone + back-office PC, all
-- run by people the shop trusts). If this ever needs to distinguish staff
-- from the owner, or lock down deletes, tighten these into per-role
-- policies keyed off Supabase Auth instead of leaving the anon key this
-- open - that's a deliberate future step, not an oversight.
-- ============================================================================

alter table products enable row level security;
alter table sales    enable row level security;
alter table payments enable row level security;

create policy "allow all via anon key" on products
  for all using (true) with check (true);

create policy "allow all via anon key" on sales
  for all using (true) with check (true);

create policy "allow all via anon key" on payments
  for all using (true) with check (true);
