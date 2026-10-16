-- Optional cache smoke-test fixture; intentionally contains no video IDs.
insert into public.search_cache (query, results, cached_at)
values ('__seed_cache_smoke_test__', '[]'::jsonb, now())
on conflict (query) do nothing;