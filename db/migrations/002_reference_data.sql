-- Reference data (Sprint 1). Everything here is editable per deployment.
-- Rows with is_code_value = false are *typical industry allowances*, not code-mandated numbers;
-- they must be calibrated to the project before the estimate is relied on (docs/risks.md R4).
-- Clause numbers in docs are to be verified against the owner's licensed copy of each standard.

INSERT INTO standards_refs (code, title, body, used_for) VALUES
 ('ACI 211.1',  'Standard Practice for Selecting Proportions for Normal-Density and High-Density, and Mass Concrete', 'American Concrete Institute', 'Absolute-volume mix design: water, cement, aggregate quantities per m3 of concrete'),
 ('ACI 318',    'Building Code Requirements for Structural Concrete', 'American Concrete Institute', 'Required average strength (f''cr) margin; minimum reinforcement ratios used as estimate sanity checks'),
 ('ACI 224R',   'Control of Cracking in Concrete Structures', 'American Concrete Institute', 'Reference for tolerable crack widths (manual hazard entries in Sprint 1)'),
 ('ACI 201.1R', 'Guide for Conducting a Visual Inspection of Concrete in Service', 'American Concrete Institute', 'Vocabulary and severity language for honeycombing and corrosion defects'),
 ('ACI 309R',   'Guide for Consolidation of Concrete', 'American Concrete Institute', 'Preventive controls for honeycombing'),
 ('ISO 31000',  'Risk management - Guidelines', 'International Organization for Standardization', 'Overall risk-assessment process (identify, analyse, evaluate, treat)'),
 ('IEC 31010',  'Risk management - Risk assessment techniques', 'International Electrotechnical Commission', 'Risk matrix (consequence x likelihood) and bow-tie analysis'),
 ('HSE R2P2',   'Reducing Risks, Protecting People', 'UK Health and Safety Executive', 'ALARP / tolerability-of-risk framework (three zones)'),
 ('ISO 45001',  'Occupational health and safety management systems', 'International Organization for Standardization', 'Hazard identification and hierarchy of controls'),
 ('OSHA 29 CFR 1926', 'Safety and Health Regulations for Construction', 'US Occupational Safety and Health Administration', 'Fall protection (Subpart M), excavation (P), concrete and masonry (Q), electrical (K)'),
 ('ANSI/EIA-748', 'Earned Value Management Systems', 'American National Standards Institute / EIA', 'Cost and schedule performance indices (CPI, SPI) and estimate-at-completion forecasting'),
 ('PMBOK EVM', 'PMBOK Guide - Earned Value Analysis', 'Project Management Institute', 'EAC = BAC / CPI, time-based schedule forecast');

INSERT INTO material_catalog (code, name, unit) VALUES
 ('CEMENT',    'Portland cement (50 kg bag)', 'bag'),
 ('SAND',      'Fine aggregate (sand)',       'm3'),
 ('AGGREGATE', 'Coarse aggregate (crush)',    'm3'),
 ('REBAR',     'Reinforcing steel (deformed bar)', 'kg'),
 ('BRICK',     'Clay brick (standard)',       'nos');

-- standard_id is looked up by code so the file does not depend on serial values.
INSERT INTO estimation_factors (key, value, unit, description, standard_id, is_code_value)
SELECT f.key, f.value, f.unit, f.description, s.id, f.is_code
FROM (VALUES
 ('cement_bag_kg',            50,    'kg',     'Mass of one cement bag',                                                                NULL,       true),
 ('sg_cement',                3.15,  '-',      'Specific gravity of cement (absolute volume method)',                                   'ACI 211.1', false),
 ('sg_fine_agg',              2.65,  '-',      'Specific gravity (SSD) of sand - replace with lab value',                               'ACI 211.1', false),
 ('sg_coarse_agg',            2.65,  '-',      'Specific gravity (SSD) of coarse aggregate - replace with lab value',                   'ACI 211.1', false),
 ('coarse_rodded_density',    1600,  'kg/m3',  'Dry-rodded bulk density of coarse aggregate (used for ACI 211.1 coarse volume)',        'ACI 211.1', false),
 ('coarse_loose_density',     1450,  'kg/m3',  'Loose bulk density of coarse aggregate as delivered (compaction factor = rodded/loose)', NULL,       false),
 ('sand_loose_density',       1500,  'kg/m3',  'Loose bulk density of sand as delivered (compaction factor for purchase volume)',        NULL,       false),
 ('wastage_concrete_pct',     5,     '%',      'Allowance for spillage / over-break on concrete materials',                              NULL,       false),
 ('wastage_steel_pct',        3,     '%',      'Allowance for cutting waste and laps on reinforcement',                                  NULL,       false),
 ('wastage_brick_pct',        5,     '%',      'Allowance for breakage on bricks',                                                       NULL,       false),
 ('bricks_per_m3_wall',       500,   'nos/m3', 'Standard clay bricks per m3 of masonry including mortar joints',                         NULL,       false),
 ('aci318_min_rho_column',    0.01,  '-',      'Minimum longitudinal steel ratio, columns (As/Ag)',                                      'ACI 318',  true),
 ('aci318_min_rho_slab',      0.0018,'-',      'Minimum shrinkage/temperature steel ratio, slabs (Grade 420)',                           'ACI 318',  true),
 ('steel_density',            7850,  'kg/m3',  'Density of reinforcing steel',                                                           NULL,       true),
 ('max_aggregate_mm',         25,    'mm',     'Nominal maximum aggregate size assumed for mixes',                                       'ACI 211.1', false),
 ('crews',                    1,     'nos',    'Number of crews working in parallel on the schedule',                                    NULL,       false)
) AS f(key, value, unit, description, std, is_code)
LEFT JOIN standards_refs s ON s.code = f.std;

-- Typical output per crew-day. Placeholders until the contractor supplies real productivity.
INSERT INTO productivity_rates (element_type, unit, output_per_day, min_duration_days, sequence_no) VALUES
 ('footing',      'm3', 12, 2, 1),
 ('column',       'm3',  5, 2, 2),
 ('beam',         'm3',  7, 2, 3),
 ('slab',         'm3', 18, 2, 4),
 ('masonry_wall', 'm3', 10, 2, 5);

-- Hazard library: bow-tie content (causes -> top event -> consequences, with barriers on each side).
INSERT INTO hazard_library
 (code, category, title, description, causes, consequences, preventive_controls, mitigating_controls, default_likelihood, default_severity, standard_id)
SELECT h.code, h.category, h.title, h.description, h.causes::jsonb, h.consequences::jsonb, h.prev::jsonb, h.mitig::jsonb, h.lik, h.sev, s.id
FROM (VALUES
 ('STR-HONEY', 'Structural integrity', 'Honeycombed concrete',
  'Voids and exposed aggregate caused by incomplete consolidation of fresh concrete.',
  '["Inadequate vibration","Congested reinforcement","Low-workability mix","Leaking formwork joints"]',
  '["Reduced strength and durability","Exposed reinforcement and corrosion","Costly repair or demolition","Delay to following works"]',
  '["Use poker vibrator at correct spacing and depth","Check slump on delivery","Verify bar spacing against aggregate size before pour","Inspect formwork tightness"]',
  '["Engineer inspection and NDT (e.g. ultrasonic pulse velocity) of the member","Repair by chipping and patching with approved material","Structural review before the member is loaded"]',
  3, 4, 'ACI 309R'),
 ('STR-RUST', 'Structural integrity', 'Corroded reinforcement',
  'Rust on reinforcing steel reduces bar section and weakens the steel-to-concrete bond.',
  '["Rebar stored on ground or uncovered","Long exposure before concreting","Insufficient concrete cover","Marine or humid environment"]',
  '["Loss of steel section","Bond failure and spalling","Shortened service life"]',
  '["Store rebar raised and covered","Clean loose rust before placing","Use correct cover spacers","Schedule pours soon after steel fixing"]',
  '["Wire-brush and treat light surface rust","Replace bars with significant section loss","Apply protective coating on exposed bars"]',
  3, 3, 'ACI 201.1R'),
 ('STR-CRACK', 'Structural integrity', 'Excessive cracking',
  'Cracks wider than the serviceability limit for the exposure condition.',
  '["Early-age shrinkage","Inadequate curing","Overloading or settlement","Insufficient reinforcement"]',
  '["Water ingress and corrosion","Loss of stiffness","Public confidence loss"]',
  '["Proper curing for the specified period","Control joints at design spacing","Follow reinforcement detailing"]',
  '["Measure and monitor crack widths","Inject or seal cracks","Engineer assessment for structural cracks"]',
  3, 3, 'ACI 224R'),
 ('FALL', 'Working at height', 'Fall from height',
  'Workers falling from slab edges, scaffolds or formwork.',
  '["Missing edge protection","Unsafe scaffold","No harness use","Wet or cluttered surfaces"]',
  '["Serious injury or fatality","Work stoppage","Legal liability"]',
  '["Guardrails on all open edges","Inspected scaffolds","Harness and anchor points","Housekeeping"]',
  '["Rescue plan and first aid on site","Incident reporting and investigation"]',
  3, 5, 'OSHA 29 CFR 1926'),
 ('EXC', 'Excavation', 'Excavation or trench collapse',
  'Soil collapse into foundation excavations or trenches.',
  '["No shoring or sloping","Surcharge from spoil or plant near edge","Rain-softened soil","Unsupported adjacent structures"]',
  '["Worker burial or injury","Damage to adjacent structures","Project delay"]',
  '["Slope or shore to soil type","Keep spoil and plant back from the edge","Daily inspection by competent person"]',
  '["Emergency rescue plan","Stop work and re-inspect after rain"]',
  2, 5, 'OSHA 29 CFR 1926'),
 ('FORM', 'Temporary works', 'Formwork or shoring failure',
  'Collapse of formwork or props during or after concrete placement.',
  '["Inadequate props or bracing","Premature stripping","Overload during pour","Poor ground under props"]',
  '["Workers struck or crushed","Failed element and rework","Cost and schedule impact"]',
  '["Design and inspect formwork before every pour","Follow stripping times","Control pour rate"]',
  '["Exclusion zone below pours","Immediate stop and evacuation procedure"]',
  2, 5, 'OSHA 29 CFR 1926'),
 ('ELEC', 'Electrical', 'Electric shock or fire from temporary supply',
  'Contact with live parts or damaged cables on site.',
  '["Damaged cables","No earth-leakage protection","Wet conditions","Unqualified work"]',
  '["Shock or electrocution","Fire","Equipment damage"]',
  '["Residual-current devices on all circuits","Cable inspection and routing off the ground","Qualified electricians only"]',
  '["First aid and emergency isolation points known to all"]',
  2, 5, 'OSHA 29 CFR 1926'),
 ('HANDLE', 'Plant and materials handling', 'Struck by plant, vehicles or falling materials',
  'Impact from site vehicles, lifting operations or dropped objects.',
  '["No traffic management","Unsecured loads","Blind spots","No hard hats"]',
  '["Crush or impact injury","Material damage","Delay"]',
  '["Segregate pedestrians and vehicles","Banksman for reversing and lifting","PPE enforcement"]',
  '["First aid and emergency response","Incident review"]',
  3, 4, 'ISO 45001')
) AS h(code, category, title, description, causes, consequences, prev, mitig, lik, sev, std)
LEFT JOIN standards_refs s ON s.code = h.std;
