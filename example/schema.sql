-- Local demo setup for example/better-auth-hono.ts.
--
-- Run with an administrative connection:
--   psql "$ADMIN_DATABASE_URL" -f example/schema.sql
-- Then run the example's `migrate` command, which creates Better Auth's public
-- tables and grants the limited runtime role access to those tables.
--
-- The authenticator password below is ONLY for local development. Use a secret
-- password (or an external secret manager) outside a throwaway local database.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_admin') then
    create role app_admin nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'pgbase_dev_only' noinherit;
  end if;
end
$$;

alter role anon nologin nosuperuser nobypassrls;
alter role authenticated nologin nosuperuser nobypassrls;
alter role app_admin nologin nosuperuser nobypassrls;
alter role authenticator login noinherit nosuperuser nobypassrls;

-- The runtime pool may SET ROLE to only these application roles. It does not
-- inherit their privileges unless a request explicitly sets one of them.
grant anon, authenticated, app_admin to authenticator;

create schema if not exists app;
grant usage on schema app to anon, authenticated, app_admin;
grant usage on schema public to authenticator;

create table if not exists app.todos (
  id         bigint generated always as identity primary key,
  owner_id   text not null,
  title      text not null,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);

alter table app.todos enable row level security;
drop policy if exists todos_anon_read on app.todos;
drop policy if exists todos_user_read on app.todos;
drop policy if exists todos_insert on app.todos;
drop policy if exists todos_update on app.todos;
drop policy if exists todos_delete on app.todos;
drop policy if exists todos_admin_all on app.todos;

-- Anonymous users may read; regular users are restricted to their own rows.
create policy todos_anon_read on app.todos
  for select to anon using (true);

create policy todos_user_read on app.todos
  for select to authenticated
  using (owner_id = current_setting('request.jwt.claim.sub', true));

create policy todos_insert on app.todos
  for insert to authenticated
  with check (owner_id = current_setting('request.jwt.claim.sub', true));

create policy todos_update on app.todos
  for update to authenticated
  using (owner_id = current_setting('request.jwt.claim.sub', true))
  with check (owner_id = current_setting('request.jwt.claim.sub', true));

create policy todos_delete on app.todos
  for delete to authenticated
  using (owner_id = current_setting('request.jwt.claim.sub', true));

create policy todos_admin_all on app.todos
  for all to app_admin using (true) with check (true);

grant select on app.todos to anon;
grant select, insert, update, delete on app.todos to authenticated, app_admin;
grant usage, select on all sequences in schema app to authenticated, app_admin;
