CREATE TABLE IF NOT EXISTS public.erp_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.erp_ledger_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL, name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
  account_class TEXT NOT NULL CHECK (account_class IN ('asset','liability','equity','revenue','expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  is_system BOOLEAN NOT NULL DEFAULT false, is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.erp_cashboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.erp_branches(id),
  ledger_account_id UUID NOT NULL REFERENCES public.erp_ledger_accounts(id),
  code TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cash','wallet','bank')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.erp_fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  label TEXT NOT NULL, starts_on DATE NOT NULL, ends_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by UUID REFERENCES auth.users(id), closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_on <= ends_on), UNIQUE (tenant_id, starts_on, ends_on)
);

CREATE TABLE IF NOT EXISTS public.erp_journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.erp_branches(id),
  entry_no BIGSERIAL, idempotency_key UUID NOT NULL,
  business_date DATE NOT NULL DEFAULT CURRENT_DATE,
  memo TEXT NOT NULL DEFAULT '', source_module TEXT NOT NULL DEFAULT 'core',
  reversal_of_id UUID REFERENCES public.erp_journal_entries(id),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_erp_je_single_reversal
  ON public.erp_journal_entries (tenant_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.erp_journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  journal_entry_id UUID NOT NULL REFERENCES public.erp_journal_entries(id) ON DELETE CASCADE,
  ledger_account_id UUID NOT NULL REFERENCES public.erp_ledger_accounts(id),
  party_account_id UUID REFERENCES public.accounts(id),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit_minor NUMERIC(38,0) NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor NUMERIC(38,0) NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  line_memo TEXT,
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);
