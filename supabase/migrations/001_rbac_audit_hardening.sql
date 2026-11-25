CREATE TABLE IF NOT EXISTS public.erp_role_permissions (
  role_code TEXT PRIMARY KEY,
  can_view_cost BOOLEAN NOT NULL DEFAULT false,
  can_post_finance BOOLEAN NOT NULL DEFAULT false,
  can_reverse BOOLEAN NOT NULL DEFAULT false,
  can_view_ifrs BOOLEAN NOT NULL DEFAULT false,
  can_manage_inventory BOOLEAN NOT NULL DEFAULT false,
  can_manage_repairs BOOLEAN NOT NULL DEFAULT false,
  can_manage_fx BOOLEAN NOT NULL DEFAULT false,
  can_close_period BOOLEAN NOT NULL DEFAULT false,
  can_manage_staff BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO public.erp_role_permissions (
  role_code, can_view_cost, can_post_finance, can_reverse, can_view_ifrs,
  can_manage_inventory, can_manage_repairs, can_manage_fx, can_close_period, can_manage_staff
) VALUES
  ('super_admin', true,  true,  true,  true,  true,  true,  true,  true,  true),
  ('owner',       true,  true,  true,  true,  true,  true,  true,  true,  true),
  ('accountant',  true,  true,  true,  true,  false, false, true,  true,  false),
  ('cashier',     false, true,  false, false, false, false, true,  false, false),
  ('sales',       false, true,  false, false, true,  false, false, false, false),
  ('technician',  false, false, false, false, false, true,  false, false, false),
  ('auditor',     true,  false, false, true,  false, false, false, false, false)
ON CONFLICT (role_code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.erp_current_tenant_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.tenant_id FROM public.profiles p JOIN public.tenants t ON t.id = p.tenant_id
  WHERE p.id = auth.uid() AND t.is_active = true AND t.expires_at > now() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.erp_current_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.role FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.erp_has_permission(p_perm TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT := public.erp_current_role(); v_ok BOOLEAN := false;
BEGIN
  IF v_role IS NULL THEN RETURN false; END IF;
  SELECT CASE p_perm
    WHEN 'can_view_cost'        THEN rp.can_view_cost
    WHEN 'can_post_finance'     THEN rp.can_post_finance
    WHEN 'can_reverse'          THEN rp.can_reverse
    WHEN 'can_view_ifrs'        THEN rp.can_view_ifrs
    WHEN 'can_manage_inventory' THEN rp.can_manage_inventory
    WHEN 'can_manage_repairs'   THEN rp.can_manage_repairs
    WHEN 'can_manage_fx'        THEN rp.can_manage_fx
    WHEN 'can_close_period'     THEN rp.can_close_period
    WHEN 'can_manage_staff'     THEN rp.can_manage_staff
    ELSE false
  END INTO v_ok FROM public.erp_role_permissions rp WHERE rp.role_code = v_role;
  RETURN COALESCE(v_ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_block_immutable_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IFRS / ISO 27001 Policy: Posted ledger and audit rows cannot be updated or deleted.';
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_write_audit_log()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (tenant_id, user_id, action, table_name, record_id, old_data, new_data, created_at)
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id), auth.uid(), TG_OP, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END, now()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;
