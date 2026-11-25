CREATE OR REPLACE FUNCTION public.erp_post_journal_atomic(
  p_idempotency_key UUID, p_business_date DATE, p_memo TEXT, p_source_module TEXT, p_lines JSONB
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID := public.erp_current_tenant_id(); v_existing UUID; v_je_id UUID; v_line JSONB; v_acc_id UUID;
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Unauthorized or expired tenant.'; END IF;
  IF NOT public.erp_has_permission('can_post_finance') THEN RAISE EXCEPTION 'Permission denied.'; END IF;
  SELECT id INTO v_existing FROM public.erp_journal_entries WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  INSERT INTO public.erp_journal_entries (tenant_id, idempotency_key, business_date, memo, source_module, created_by)
  VALUES (v_tenant_id, p_idempotency_key, COALESCE(p_business_date, CURRENT_DATE), COALESCE(p_memo, ''), COALESCE(p_source_module, 'core'), auth.uid())
  RETURNING id INTO v_je_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT id INTO v_acc_id FROM public.erp_ledger_accounts WHERE tenant_id = v_tenant_id AND code = (v_line->>'account_code') AND is_active = true LIMIT 1;
    IF v_acc_id IS NULL THEN RAISE EXCEPTION 'Ledger account % not found.', v_line->>'account_code'; END IF;
    INSERT INTO public.erp_journal_lines (tenant_id, journal_entry_id, ledger_account_id, currency, debit_minor, credit_minor, line_memo)
    VALUES (v_tenant_id, v_je_id, v_acc_id, (v_line->>'currency')::CHAR(3), (v_line->>'debit_minor')::NUMERIC(38,0), (v_line->>'credit_minor')::NUMERIC(38,0), v_line->>'line_memo');
  END LOOP;
  RETURN v_je_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_reverse_journal_atomic(
  p_original_journal_id UUID, p_idempotency_key UUID, p_reason TEXT DEFAULT 'تصحيح قيد محاسبي'
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID := public.erp_current_tenant_id(); v_existing UUID; v_orig RECORD; v_rev_id UUID;
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Unauthorized.'; END IF;
  IF NOT public.erp_has_permission('can_reverse') THEN RAISE EXCEPTION 'Permission denied.'; END IF;
  SELECT id INTO v_existing FROM public.erp_journal_entries WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT * INTO v_orig FROM public.erp_journal_entries WHERE id = p_original_journal_id AND tenant_id = v_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original journal entry not found.'; END IF;
  IF v_orig.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'Cannot reverse a reversal entry.'; END IF;

  INSERT INTO public.erp_journal_entries (tenant_id, idempotency_key, memo, source_module, reversal_of_id, created_by)
  VALUES (v_tenant_id, p_idempotency_key, 'قيد عكسي: ' || v_orig.memo || ' (' || COALESCE(p_reason, '') || ')', v_orig.source_module, v_orig.id, auth.uid())
  RETURNING id INTO v_rev_id;

  INSERT INTO public.erp_journal_lines (tenant_id, journal_entry_id, ledger_account_id, party_account_id, currency, debit_minor, credit_minor, line_memo)
  SELECT v_tenant_id, v_rev_id, ledger_account_id, party_account_id, currency, credit_minor, debit_minor, 'Reversal'
  FROM public.erp_journal_lines WHERE journal_entry_id = v_orig.id;
  RETURN v_rev_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_get_trial_balance(p_currency CHAR(3))
RETURNS TABLE (account_code TEXT, account_name_ar TEXT, account_class TEXT, total_debit_minor NUMERIC(38,0), total_credit_minor NUMERIC(38,0), normal_balance_minor NUMERIC(38,0))
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant_id UUID := public.erp_current_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Unauthorized.'; END IF;
  IF NOT public.erp_has_permission('can_view_ifrs') THEN RAISE EXCEPTION 'Permission denied.'; END IF;
  RETURN QUERY
  SELECT la.code, la.name_ar, la.account_class,
    COALESCE(SUM(jl.debit_minor), 0)::NUMERIC(38,0), COALESCE(SUM(jl.credit_minor), 0)::NUMERIC(38,0),
    CASE WHEN la.normal_balance = 'debit' THEN (COALESCE(SUM(jl.debit_minor), 0) - COALESCE(SUM(jl.credit_minor), 0))::NUMERIC(38,0)
         ELSE (COALESCE(SUM(jl.credit_minor), 0) - COALESCE(SUM(jl.debit_minor), 0))::NUMERIC(38,0) END
  FROM public.erp_ledger_accounts la
  LEFT JOIN public.erp_journal_lines jl ON jl.ledger_account_id = la.id AND jl.currency = p_currency AND jl.tenant_id = v_tenant_id
  WHERE la.tenant_id = v_tenant_id GROUP BY la.code, la.name_ar, la.account_class, la.normal_balance ORDER BY la.code;
END;
$$;
