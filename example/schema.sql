-- Demo schema for example/better-auth-hono.ts.
--
-- Creates the Postgres roles pgbase impersonates, a `todos` table guarded by
-- RLS, and grants. Run once against your database:
--
--   psql "$DATABASE_URL" -f example/schema.sql

-- Roles pgbase switches into via `SET LOCAL ROLE`.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

create table if not exists todos (
  id         bigint generated always as identity primary key,
  owner_id   text not null,
  title      text not null,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);

alter table todos enable row level security;

-- Anyone (anonymous) may read. Authenticated users see only their own rows.
create policy todos_read on todos
  for select
  using (
    current_setting('request.jwt.claims', true) is null
    or current_setting('request.jwt.claim.sub', true) is null
    or owner_id = current_setting('request.jwt.claim.sub', true)
  );

-- Authenticated users may write only their own rows.
create policy todos_insert on todos
  for insert
  with check (owner_id = current_setting('request.jwt.claim.sub', true));

create policy todos_update on todos
  for update
  using (owner_id = current_setting('request.jwt.claim.sub', true))
  with check (owner_id = current_setting('request.jwt.claim.sub', true));

create policy todos_delete on todos
  for delete
  using (owner_id = current_setting('request.jwt.claim.sub', true));

grant usage on schema public to anon, authenticated;
grant select on todos to anon;
grant select, insert, update, delete on todos to authenticated;
grant usage, select on all sequences in schema public to authenticated;
