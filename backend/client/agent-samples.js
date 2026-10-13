/* BRP operations agents: labels and the SAMPLE proposals used by local demo mode in the admin console and BRP HQ.
   SAMPLE DATA: these proposals were written for the demo; no agent has run. The real rows come from public.agent_proposals
   (migration 20261014000100_brp_agents.sql). Shared so the admin console and HQ show the same demo. */
window.BRP_AGENT_SAMPLES = {
  labels: { buyer_dispatch: 'Buyer and Dispatch', sensor_watch: 'Sensor Watch', inspection_scheduler: 'Inspection Scheduler', room_readiness: 'Room Readiness Planner', soldier_liaison: 'Soldier Liaison' },
  flags: { over_per_order_limit: 'Over $500 per order', over_weekly_cap: 'Over the weekly cap', over_site_lead_authority: 'Over $2,500: program manager', total_mismatch: 'Total does not match lines' },
  proposals: [
  { id: 'AP-S0001', sample: true, agent: 'buyer_dispatch', inst: 'STW', kind: 'purchase_order', status: 'proposed', created_at: '2026-10-07T12:10:00.000Z', mode_at_proposal: 'shadow',
    payload: { vendor_id: 'V1', lines: [{ sku: 'CAP-355', qty: 6, unit_cost: 14.6 }], shipping: 0, total: 87.6, approval_level: 'auto' },
    rationale: 'SAMPLE DATA. CAB-STW holds 0 of CAP-355 against a reorder point of 3 (reorder quantity 6). Part record lists V1 at $14.60. My calculation: 6 x $14.60 = $87.60. Inside $500 per order and the weekly cap.',
    cited_ids: ['CAB-STW', 'CAP-355', 'V1'], flags: [], approver_required: null },
  { id: 'AP-S0002', sample: true, agent: 'buyer_dispatch', inst: 'STW', kind: 'purchase_order', status: 'proposed', created_at: '2026-10-07T12:11:00.000Z', mode_at_proposal: 'shadow',
    payload: { vendor_id: 'V1', lines: [{ sku: 'PTAC-12K', qty: 2, unit_cost: 1180 }], shipping: 0, total: 2360, approval_level: 'site_lead' },
    rationale: 'SAMPLE DATA. CAB-STW holds 0 of PTAC-12K (reorder point 1, reorder quantity 2). My calculation: 2 x $1,180.00 = $2,360.00. Over the $500 per-order limit, so the Fort Stewart site lead must approve through an approval task. One order, not split.',
    cited_ids: ['CAB-STW', 'PTAC-12K', 'V1'], flags: ['over_per_order_limit'], approver_required: 'site_lead' },
  { id: 'AP-S0003', sample: true, agent: 'buyer_dispatch', inst: 'STW', kind: 'backorder_decision', status: 'proposed', created_at: '2026-10-07T12:12:00.000Z', mode_at_proposal: 'shadow',
    payload: { po_id: 'BRP-STW-27-0433', recommendation: 'wait', facts: 'PO is backordered with V3. No work order is waiting on it.' },
    rationale: 'SAMPLE DATA. BRP-STW-27-0433 ($532.00, V3) is backordered and is a replenishment order with no work order attached. Recommend the site lead decide to wait. UNVERIFIED: the vendor\'s new ship date is not in the BRP records.',
    cited_ids: ['BRP-STW-27-0433', 'V3'], flags: [], approver_required: null },
  { id: 'AP-S0004', sample: true, agent: 'sensor_watch', inst: 'STW', kind: 'sensor_work_order', status: 'proposed', created_at: '2026-10-07T12:15:00.000Z', mode_at_proposal: 'shadow',
    payload: { room_id: 'STW-412-1C', priority: 'Urgent', condition: 'Humidity above 60%', evidence: [{ room_id: 'STW-412-1C', field: 'sensor_rh', value: 61.8, read_at: '2026-10-07T11:55:00Z' }, { room_id: 'STW-412-1C', field: 'sensor_wall_rh', value: 79, read_at: '2026-10-07T11:55:00Z' }] },
    rationale: 'SAMPLE DATA. STW-412-1C reads 61.8% RH with wall RH 79% at 11:55. Above the 30 to 60% standard. UNVERIFIED: how long it has been above 60%; the backend holds the latest reading only, so the 72-hour mold rule cannot be checked. Priority provisional; the barracks manager confirms at inspection.',
    cited_ids: ['STW-412-1C'], flags: [], approver_required: null },
  { id: 'AP-S0005', sample: true, agent: 'sensor_watch', inst: 'STW', kind: 'sensor_maintenance', status: 'approved', created_at: '2026-10-07T12:16:00.000Z', mode_at_proposal: 'shadow',
    payload: { room_id: 'STW-412-1H', fault: 'low_battery' },
    rationale: 'SAMPLE DATA. The STW-412-1H sensor reports low_battery. Its readings should be treated as unknown until a sensor technician replaces the battery.',
    cited_ids: ['STW-412-1H'], flags: [], approver_required: null, decided_by_email: 'admin@brp.demo', decided_at: '2026-10-07T13:02:00.000Z', decision_note: 'Agree. Battery swap on the next round.' },
  { id: 'AP-S0006', sample: true, agent: 'inspection_scheduler', inst: 'STW', kind: 'inspection_booking', status: 'rejected', created_at: '2026-10-07T12:20:00.000Z', mode_at_proposal: 'shadow',
    payload: { type: 'vacant_walk', building_id: 'STW-118', room_ids: ['STW-118-1F'], manager_name: 'D. Hargrove', start: '2026-10-08T13:00:00-04:00', end: '2026-10-08T13:10:00-04:00' },
    rationale: 'SAMPLE DATA. STW-118-1F is vacant and offline. A monthly vacant-room walk is due. UNVERIFIED: D. Hargrove\'s calendar and duty hours are not in the BRP records.',
    cited_ids: ['STW-118-1F', 'STW-118'], flags: [], approver_required: null, decided_by_email: 'admin@brp.demo', decided_at: '2026-10-07T13:05:00.000Z', decision_note: 'Room is offline for mold remediation. Walk it after remediation, not now.' },
  { id: 'AP-S0007', sample: true, agent: 'room_readiness', inst: 'STW', kind: 'readiness_plan', status: 'proposed', created_at: '2026-10-07T12:30:00.000Z', mode_at_proposal: 'shadow',
    payload: { horizon_start: '2026-10-08', horizon_end: '2026-10-21', ready_now: ['STW-412-1B', 'STW-412-1E', 'STW-412-1G'], fill_next: [{ rank: 1, room_id: 'STW-412-1B', ready_now: true }, { rank: 2, room_id: 'STW-412-1E', ready_now: true }, { rank: 3, room_id: 'STW-412-1G', ready_now: true }], rooms_returned: [], not_planned: [{ room_id: 'STW-305-1A', reason: 'Status action with no work order hour estimate in the records' }] },
    rationale: 'SAMPLE DATA. STW-412-1B, 1E and 1G are vacant, status ok, with sensor readings inside range at 11:55 and no open work order found. STW-305-1A is not planned: no hour estimate exists. The housing office assigns rooms; this is a recommendation.',
    cited_ids: ['STW-412-1B', 'STW-412-1E', 'STW-412-1G', 'STW-305-1A'], flags: [], approver_required: null }
],
  settings: [
  { agent: 'buyer_dispatch', inst: '*', mode: 'shadow', note: 'Readiness L2 (bench run-002). Shadow: proposes only.' },
  { agent: 'sensor_watch', inst: '*', mode: 'shadow', note: 'Readiness L2 (bench run-003). Shadow: proposes only.' },
  { agent: 'inspection_scheduler', inst: '*', mode: 'shadow', note: 'Readiness L2 (bench run-003). Shadow: proposes only.' },
  { agent: 'room_readiness', inst: '*', mode: 'shadow', note: 'Readiness L2 (bench run-003). Shadow: proposes only.' },
  { agent: 'soldier_liaison', inst: '*', mode: 'off', note: 'Not ready. Soldier-facing chat stays off until it passes its benches.' }
],
  /* BRP HQ demo accounts (backend/hq/). Local demo mode only; the server makes them in supabase/seed/hq-seed.sql. */
  hq_profiles: [
    { id: 'demo-hq-owner', email: 'owner@brp.demo', full_name: 'HQ owner (demo)', role: 'admin', inst: null, home_bldg: null, home_room: null, active: true, demo: true, created_at: '2026-10-13T12:00:00.000Z' },
    { id: 'demo-hq-partner', email: 'partner@brp.demo', full_name: 'Rynoc partner (demo)', role: 'cor', inst: null, home_bldg: null, home_room: null, active: true, demo: true, created_at: '2026-10-13T12:00:00.000Z' }
  ]
};
