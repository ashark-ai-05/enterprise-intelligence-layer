ALTER TABLE principal_mappings RENAME TO principal_mappings_legacy;

CREATE TABLE principal_mappings (
  tenant_id text NOT NULL,
  authorization_domain text NOT NULL,
  source_identifier text NOT NULL,
  enterprise_identity_id uuid NOT NULL REFERENCES enterprise_identities(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,
    authorization_domain,
    source_identifier,
    enterprise_identity_id
  )
);

INSERT INTO principal_mappings (
  tenant_id,
  authorization_domain,
  source_identifier,
  enterprise_identity_id,
  updated_at
)
SELECT
  tenant_id,
  authorization_domain,
  source_identifier,
  enterprise_identity_id,
  updated_at
FROM principal_mappings_legacy
WHERE status = 'mapped' AND enterprise_identity_id IS NOT NULL;

CREATE INDEX principal_mappings_identity_v2_idx
  ON principal_mappings (tenant_id, enterprise_identity_id);

CREATE TABLE unmapped_principals (
  tenant_id text NOT NULL,
  authorization_domain text NOT NULL,
  source_identifier text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, authorization_domain, source_identifier)
);

INSERT INTO unmapped_principals (
  tenant_id,
  authorization_domain,
  source_identifier,
  updated_at
)
SELECT tenant_id, authorization_domain, source_identifier, updated_at
FROM principal_mappings_legacy
WHERE status = 'unmapped';

DROP TABLE principal_mappings_legacy;
