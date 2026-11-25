CREATE OR REPLACE FUNCTION public.erp_verify_journal_balanced()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_cnt INT; v_u RECORD;
BEGIN
  SELECT COUNT(*) INTO v_cnt FROM public.erp_journal_lines WHERE journal_entry_id = NEW.id;
  IF v_cnt < 2 THEN RAISE EXCEPTION 'IFRS Violation: Journal % requires at least 2 lines.', NEW.id; END IF;
  SELECT currency, SUM(debit_minor) AS dr, SUM(credit_minor) AS cr INTO v_u
  FROM public.erp_journal_lines WHERE journal_entry_id = NEW.id
  GROUP BY currency HAVING SUM(debit_minor) <> SUM(credit_minor) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'IFRS Violation: Unbalanced journal % (% Dr=% Cr=%).', NEW.id, v_u.currency, v_u.dr, v_u.cr; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_verify_journal_balanced ON public.erp_journal_entries;
CREATE CONSTRAINT TRIGGER trg_erp_verify_journal_balanced
  AFTER INSERT ON public.erp_journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.erp_verify_journal_balanced();

CREATE OR REPLACE FUNCTION public.erp_verify_open_period()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.erp_fiscal_periods
    WHERE tenant_id = NEW.tenant_id AND NEW.business_date BETWEEN starts_on AND ends_on AND status = 'closed'
  ) THEN RAISE EXCEPTION 'Fiscal period for % is CLOSED.', NEW.business_date; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_verify_open_period ON public.erp_journal_entries;
CREATE TRIGGER trg_erp_verify_open_period BEFORE INSERT ON public.erp_journal_entries FOR EACH ROW EXECUTE FUNCTION public.erp_verify_open_period();

DROP TRIGGER IF EXISTS trg_erp_immutable_je ON public.erp_journal_entries;
CREATE TRIGGER trg_erp_immutable_je BEFORE UPDATE OR DELETE ON public.erp_journal_entries FOR EACH ROW EXECUTE FUNCTION public.erp_block_immutable_mutation();

DROP TRIGGER IF EXISTS trg_erp_immutable_jl ON public.erp_journal_lines;
CREATE TRIGGER trg_erp_immutable_jl BEFORE UPDATE OR DELETE ON public.erp_journal_lines FOR EACH ROW EXECUTE FUNCTION public.erp_block_immutable_mutation();

DROP TRIGGER IF EXISTS trg_erp_audit_je ON public.erp_journal_entries;
CREATE TRIGGER trg_erp_audit_je AFTER INSERT ON public.erp_journal_entries FOR EACH ROW EXECUTE FUNCTION public.erp_write_audit_log();

ALTER TABLE public.erp_branches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_cashboxes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_fiscal_periods  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_journal_lines   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['erp_branches','erp_ledger_accounts','erp_cashboxes','erp_fiscal_periods','erp_journal_entries','erp_journal_lines'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS erp_tenant_iso ON public.%I;', tbl);
    EXECUTE format('CREATE POLICY erp_tenant_iso ON public.%I FOR ALL USING (tenant_id = public.erp_current_tenant_id()) WITH CHECK (tenant_id = public.erp_current_tenant_id());', tbl);
  END LOOP;
END $$;
