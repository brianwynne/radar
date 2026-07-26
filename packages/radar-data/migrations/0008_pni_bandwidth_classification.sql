-- 0008_pni_bandwidth_classification: the PNI Graphs page now logs EVERY top-level link (not just
-- eyeball PNIs) so faults on any link are visible, and it labels each link with its link type and
-- datacentre (Citywest/Parkwest) so the eyeball networks can be identified and listed first. Both
-- columns are nullable and additive; existing rows keep NULLs. READ-ONLY-derived; numeric + label
-- data only, no credentials.

ALTER TABLE pni_bandwidth_samples ADD COLUMN IF NOT EXISTS link_type  text;
ALTER TABLE pni_bandwidth_samples ADD COLUMN IF NOT EXISTS datacentre text;
