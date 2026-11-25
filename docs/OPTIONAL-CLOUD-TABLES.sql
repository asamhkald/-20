-- Sama Business Enterprise v1.0 — Optional Additive Cloud Sync (100% Non-Destructive)
CREATE TABLE IF NOT EXISTS public.enterprise_vault_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  hidden_uuid UUID NOT NULL DEFAULT gen_random_uuid(),
  payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  checksum_sha256 TEXT,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_key)
);

ALTER TABLE public.enterprise_vault_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'enterprise_vault_snapshots'
      AND policyname = 'tenant_vault_isolation'
  ) THEN
    CREATE POLICY tenant_vault_isolation
      ON public.enterprise_vault_snapshots
      FOR ALL
      USING (
        tenant_id IN (
          SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid()
        )
      )
      WITH CHECK (
        tenant_id IN (
          SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid()
        )
      );
  END IF;
END $$;
