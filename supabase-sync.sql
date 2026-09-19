-- รันครั้งเดียวใน Supabase → SQL Editor
-- ตารางเก็บพอร์ตจำลอง 1 แถวต่อ "รหัสซิงค์" อ่าน/เขียนได้เฉพาะคำขอที่ส่ง header x-sync-code ตรงกับแถวนั้น
create table if not exists public.paper_port (
  code text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.paper_port enable row level security;

drop policy if exists "paper_port by sync code" on public.paper_port;
create policy "paper_port by sync code" on public.paper_port
  for all to anon
  using (code = (current_setting('request.headers', true)::json ->> 'x-sync-code'))
  with check (code = (current_setting('request.headers', true)::json ->> 'x-sync-code'));

grant select, insert, update on public.paper_port to anon;
