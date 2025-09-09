import React, { useMemo, useState, useEffect, useRef } from 'react';

/*
 * MMD Supply Chain Strategy Simulator – HPV vaccine demo
 *
 * This version mirrors the Collins Aerospace simulator UI but uses
 * Merck Manufacturing Division (MMD) terminology, sites and logic.
 * It features an interactive network graph, optimizer, Monte Carlo and
 * sensitivity analysis. All numbers are synthetic.
 */

// ------------ Core simulation logic (copied/adapted from previous MMD version) ------------
const MODES = {
  ground: { name: 'Ground', unitCostPerKm: 0.002, co2PerKm: 0.0005, baseRisk: 0.01, leadTime: 3 },
  air:    { name: 'Air',    unitCostPerKm: 0.020, co2PerKm: 0.0100, baseRisk: 0.03, leadTime: 2 },
  ocean:  { name: 'Ocean',  unitCostPerKm: 0.005, co2PerKm: 0.0020, baseRisk: 0.02, leadTime: 16 }
};

const initialData = {
  products: [
    { id: 'HPV_Gardasil9', name: 'HPV Vaccine (Gardasil® 9)', unit: 'doses', monthlyDemand: { US: 120000, EU: 80000 } }
  ],
  plants: [
    { id: 'WEST_POINT_PA', name: 'West Point, PA – FF & Packaging', region: 'US', capacity: 180000, convCost: 3.6, uptime: 0.97, baseRisk: 0.015 },
    { id: 'DURHAM_NC',     name: 'Durham, NC – Vaccine FF (new)',   region: 'US', capacity: 150000, convCost: 3.9, uptime: 0.95, baseRisk: 0.018 },
    { id: 'CMO_EU',        name: 'EU CMO – Vaccine FF (contract)',  region: 'EU', capacity: 70000,  convCost: 4.5, uptime: 0.92, baseRisk: 0.024 }
  ],
  dcs: [
    { id: 'US_DC_WP',  name: 'US DC – West Point, PA', region: 'US' },
    { id: 'EU_DC_HEI', name: 'EU DC – Heist‑op‑den‑Berg, BE', region: 'EU' }
  ],
  lanes: {
    'WEST_POINT_PA->US_DC_WP': 50,
    'DURHAM_NC->US_DC_WP': 700,
    'CMO_EU->EU_DC_HEI': 300,
    'WEST_POINT_PA->EU_DC_HEI': 6200,
    'DURHAM_NC->EU_DC_HEI': 6600
  }
};

// Helper maths
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = (n, d = 0) => n?.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = x => `${(100 * x).toFixed(1)}%`;
const sum = arr => arr.reduce((a, b) => a + b, 0);
const rnd = (mean, sd) => mean + (gauss() * sd);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Evaluate a scenario (copied from earlier MMD logic).  Returns cost, service etc.
 */
function evaluateScenario(state) {
  const { products, plants, dcs, lanes, choices, levers } = state;
  const demandUS = products[0].monthlyDemand.US;
  const demandEU = products[0].monthlyDemand.EU;
  const alloc = { ...choices.alloc };
  const capUsed = {};
  for (const key of Object.keys(alloc)) {
    const [pId] = key.split('->');
    const p = plants.find(x => x.id === pId);
    capUsed[pId] = (capUsed[pId] || 0) + alloc[key];
    if (capUsed[pId] > p.capacity) {
      const over = capUsed[pId] - p.capacity;
      alloc[key] = Math.max(0, alloc[key] - over);
      capUsed[pId] = p.capacity;
    }
  }
  const supplyByDC = { US_DC_WP: 0, EU_DC_HEI: 0 };
  const plantUtil = {};
  let convCost = 0, transportCost = 0, carbon = 0, riskScore = 0;
  for (const key of Object.keys(alloc)) {
    const vol = alloc[key];
    if (vol <= 0) continue;
    const [pId, dcId] = key.split('->');
    const p = plants.find(x => x.id === pId);
    const dc = dcs.find(x => x.id === dcId);
    const km = lanes[`${pId}->${dcId}`] ?? 0;
    const modeKey = choices.mode[`${pId}->${dcId}`] || 'ground';
    const mode = MODES[modeKey];
    plantUtil[pId] = (plantUtil[pId] || 0) + vol;
    supplyByDC[dcId] += vol;
    convCost += vol * p.convCost;
    transportCost += vol * (mode.unitCostPerKm * km + levers.fuelSurcharge);
    carbon += vol * (mode.co2PerKm * km);
    const regionalRisk = dc.region === 'EU' ? 0.012 : 0.010;
    riskScore += vol * (p.baseRisk + mode.baseRisk + regionalRisk) * (1 - p.uptime) * 100;
  }
  const shortageUS = Math.max(0, demandUS - supplyByDC.US_DC_WP);
  const shortageEU = Math.max(0, demandEU - supplyByDC.EU_DC_HEI);
  let overflowCost = 0, overflowCarbon = 0, overflowPenalty = 0;
  let servedUS = supplyByDC.US_DC_WP;
  let servedEU = supplyByDC.EU_DC_HEI;
  const overflowEnabled = levers.overflow;
  function fillOverflow(units) {
    if (!overflowEnabled || units <= 0) return [0, 0, 0];
    const c = units * 6.0;
    const co2 = units * 0.5;
    const pen = units * 0.15;
    return [c, co2, pen];
  }
  if (shortageUS > 0) {
    const [c, co2, pen] = fillOverflow(shortageUS);
    overflowCost += c;
    overflowCarbon += co2;
    overflowPenalty += pen;
    servedUS += shortageUS;
  }
  if (shortageEU > 0) {
    const [c, co2, pen] = fillOverflow(shortageEU);
    overflowCost += c;
    overflowCarbon += co2;
    overflowPenalty += pen;
    servedEU += shortageEU;
  }
  const totalDemand = demandUS + demandEU;
  const served = Math.min(servedUS, demandUS) + Math.min(servedEU, demandEU);
  const rawService = served / totalDemand;
  const otif = clamp(rawService - (overflowPenalty / totalDemand), 0, 1);
  const cost = convCost + transportCost + overflowCost + (levers.carbonPrice * (carbon + overflowCarbon));
  const riskWeighted = levers.riskWeight * riskScore * 1_000;
  const objective = cost + riskWeighted;
  return {
    metrics: {
      demand: totalDemand,
      served,
      otif,
      cost,
      convCost,
      transportCost,
      overflowCost,
      carbon: carbon + overflowCarbon,
      riskScore,
      objective
    },
    plantUtil,
    supplyByDC,
    shortage: { US: shortageUS, EU: shortageEU }
  };
}

/**
 * Optimizer from earlier MMD version.  Not used directly in UI but kept for completeness.
 */
function optimize(state) {
  const s = JSON.parse(JSON.stringify(state));
  const target = s.levers.serviceTarget;
  const demandUS = s.products[0].monthlyDemand.US;
  const demandEU = s.products[0].monthlyDemand.EU;
  s.choices.alloc = {};
  s.choices.mode = {};
  const allocFrom = (plantId, dcId, units, modeKey) => {
    const k = `${plantId}->${dcId}`;
    s.choices.alloc[k] = (s.choices.alloc[k] || 0) + units;
    s.choices.mode[k] = modeKey;
  };
  let remainingUS = demandUS;
  const usDC = 'US_DC_WP';
  const usPlants = s.plants.filter(p => p.region === 'US').sort((a, b) => (s.lanes[`${a.id}->${usDC}`] || 0) - (s.lanes[`${b.id}->${usDC}`] || 0));
  for (const p of usPlants) {
    const avail = Math.max(0, p.capacity - (Object.values(s.choices.alloc).filter((_, k2) => k2.startsWith(`${p.id}->`)).reduce((a, b) => a + b, 0)));
    const take = Math.min(avail, remainingUS);
    if (take > 0) {
      allocFrom(p.id, usDC, take, 'ground');
      remainingUS -= take;
    }
  }
  let remainingEU = demandEU;
  const euDC = 'EU_DC_HEI';
  const cmo = s.plants.find(p => p.id === 'CMO_EU');
  if (cmo) {
    const avail = cmo.capacity;
    const take = Math.min(avail, remainingEU);
    if (take > 0) {
      allocFrom(cmo.id, euDC, take, 'ground');
      remainingEU -= take;
    }
  }
  for (const p of usPlants) {
    if (remainingEU <= 0) break;
    const key = `${p.id}->${euDC}`;
    if (!s.lanes[key]) continue;
    const avail = Math.max(0, p.capacity - (Object.values(s.choices.alloc).filter((_, k2) => k2.startsWith(`${p.id}->`)).reduce((a, b) => a + b, 0)));
    const take = Math.min(avail, remainingEU);
    if (take > 0) {
      allocFrom(p.id, euDC, take, 'ocean');
      remainingEU -= take;
    }
  }
  let eval1 = evaluateScenario(s);
  if (eval1.metrics.otif < target && remainingEU > 0) {
    for (const p of usPlants) {
      if (remainingEU <= 0) break;
      const key = `${p.id}->${euDC}`;
      if (!s.lanes[key]) continue;
      const avail = Math.max(0, p.capacity - (Object.values(s.choices.alloc).filter((_, k2) => k2.startsWith(`${p.id}->`)).reduce((a, b) => a + b, 0)));
      const take = Math.min(avail, remainingEU);
      if (take > 0) {
        allocFrom(p.id, euDC, take, 'air');
        remainingEU -= take;
      }
    }
  }
  let best = s;
  let bestEval = evaluateScenario(s);
  if (bestEval.metrics.otif >= target) {
    for (const key of Object.keys(best.choices.alloc)) {
      if (!key.endsWith(`->${euDC}`)) continue;
      const mode = best.choices.mode[key];
      if (mode !== 'air') continue;
      const original = best.choices.mode[key];
      best.choices.mode[key] = 'ocean';
      const e = evaluateScenario(best);
      if (e.metrics.otif >= target && e.metrics.objective <= bestEval.metrics.objective) {
        bestEval = e;
      } else {
        best.choices.mode[key] = original;
      }
    }
  }
  return best;
}

/**
 * Monte Carlo simulation (reused).
 */
/**
 * Monte Carlo simulation.  Runs N random scenarios and returns summary
 * statistics.  Demand is perturbed by demandVol and plant capacity is
 * shocked by relShock (standard deviation).  Defaults: relShock=0.03.
 */
function runMonteCarlo(state, N = 200, relShock = 0.03) {
  const res = [];
  for (let i = 0; i < N; i++) {
    // Deep clone the state since we'll modify it
    const s = JSON.parse(JSON.stringify(state));
    const dv = s.levers.demandVol;
    const muUS = s.products[0].monthlyDemand.US;
    const muEU = s.products[0].monthlyDemand.EU;
    // Perturb demand using a normal distribution with sd = demandVol * mean
    s.products[0].monthlyDemand.US = Math.max(0, Math.round(rnd(muUS, muUS * dv)));
    s.products[0].monthlyDemand.EU = Math.max(0, Math.round(rnd(muEU, muEU * dv)));
    // Shock plant capacities based on reliability shock parameter
    for (const p of s.plants) {
      const shock = clamp(p.uptime + rnd(0, relShock), 0.80, 0.995);
      p.capacity = Math.floor(p.capacity * shock);
    }
    // Evaluate the scenario and store metrics
    res.push(evaluateScenario(s).metrics);
  }
  const otifs = res.map(x => x.otif);
  const costs = res.map(x => x.cost);
  const probHit = otifs.filter(x => x >= state.levers.serviceTarget).length / N;
  const meanCost = sum(costs) / N;
  const sorted = costs.slice().sort((a, b) => a - b);
  const p90Cost = sorted[Math.floor(0.90 * N)];
  return { probHit, meanCost, p90Cost, sample: res };
}

/**
 * Tornado sensitivity (reused).
 */
function tornado(state) {
  const base = evaluateScenario(state).metrics.objective;
  const variants = [
    ['Service Target +5pt', s => ({ ...s, levers: { ...s.levers, serviceTarget: clamp(s.levers.serviceTarget + 0.05, 0.8, 0.99) } })],
    ['Service Target −5pt', s => ({ ...s, levers: { ...s.levers, serviceTarget: clamp(s.levers.serviceTarget - 0.05, 0.8, 0.99) } })],
    ['Risk Weight +50%', s => ({ ...s, levers: { ...s.levers, riskWeight: s.levers.riskWeight * 1.5 } })],
    ['Risk Weight −50%', s => ({ ...s, levers: { ...s.levers, riskWeight: s.levers.riskWeight * 0.5 } })],
    ['Carbon Price +50%', s => ({ ...s, levers: { ...s.levers, carbonPrice: s.levers.carbonPrice * 1.5 } })],
    ['Carbon Price −50%', s => ({ ...s, levers: { ...s.levers, carbonPrice: s.levers.carbonPrice * 0.5 } })],
    ['Fuel Surcharge +$0.05', s => ({ ...s, levers: { ...s.levers, fuelSurcharge: s.levers.fuelSurcharge + 0.05 } })],
    ['Fuel Surcharge −$0.05', s => ({ ...s, levers: { ...s.levers, fuelSurcharge: Math.max(0, s.levers.fuelSurcharge - 0.05) } })]
  ];
  const rows = variants.map(([name, fn]) => {
    const s2 = fn(JSON.parse(JSON.stringify(state)));
    const obj = evaluateScenario(s2).metrics.objective;
    return { name, delta: obj - base };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { base, rows };
}

// ------------ Graph & UI primitives (adapted from P&C) ------------
function useDrag(position, onChange) {
  const ref = useRef(null);
  const baseRef = useRef({ x: position.x, y: position.y });
  useEffect(() => { baseRef.current = { x: position.x, y: position.y }; }, [position.x, position.y]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dragging = false;
    let startX = 0, startY = 0;
    const down = (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      onChange({ x: baseRef.current.x + dx, y: baseRef.current.y + dy });
    };
    const up = (e) => {
      dragging = false;
      try { el.releasePointerCapture?.(e.pointerId); } catch {}
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [onChange]);
  return ref;
}

function Graph({ network, assignment, setAssignment, activeLruId, pendingSupplier, setPendingSupplier }) {
  const width = 1000;
  const height = 520;
  const nodeW = 140;
  const nodeH = 36;
  const [positions, setPositions] = useState(() => {
    const p = {};
    const xGap = network.assemblySites.length > 0 ? 220 : 300;
    network.suppliers.forEach((s, i) => { p[s.id] = { x: 40 + i * xGap, y: 40 }; });
    network.assemblySites.forEach((a, i) => { p[a.id] = { x: 150 + i * xGap, y: 240 }; });
    network.dcs.forEach((d, i) => { p[d.id] = { x: 200 + i * xGap, y: 420 }; });
    return p;
  });
  function setPos(id, xy) { setPositions((prev) => ({ ...prev, [id]: xy })); }
  function centerOf(id) { const p = positions[id]; return { cx: (p?.x || 0) + nodeW / 2, cy: (p?.y || 0) + nodeH / 2 }; }
  const edges = Object.entries(assignment).map(([lruId, pick]) => ({ lruId, from: pick.supplierId, to: pick.assemblyId, mode: pick.mode }));
  const modeStyle = { air: { dash: '0', width: 3 }, ground: { dash: '6 6', width: 2.5 }, ocean: { dash: '2 6', width: 2 } };
  return (
    <svg width={width} height={height} style={{ background: 'transparent' }}>
      {/* edges */}
      {edges.map((e, idx) => {
        const a = centerOf(e.from);
        const b = centerOf(e.to);
        const midX = (a.cx + b.cx) / 2;
        const midY = (a.cy + b.cy) / 2;
        const dash = modeStyle[e.mode].dash;
        const strokeWidth = modeStyle[e.mode].width;
        return (
          <g key={idx}>
            <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke="#94a3b8" strokeWidth={strokeWidth} strokeDasharray={dash} />
            <rect x={midX - 30} y={midY - 12} width={60} height={20} fill="#0f172a" stroke="#475569" strokeWidth="1" rx="4"
              onClick={() => {
                setAssignment((prev) => {
                  const cur = prev[e.lruId];
                  const nextMode = cur.mode === 'air' ? 'ground' : cur.mode === 'ground' ? 'ocean' : 'air';
                  return { ...prev, [e.lruId]: { ...cur, mode: nextMode } };
                });
              }}
              style={{ cursor: 'pointer' }}
            />
            <text x={midX} y={midY + 3} fontSize="10" fill="#e2e8f0" textAnchor="middle">{e.lruId}•{e.mode}</text>
          </g>
        );
      })}
      {/* nodes */}
      {[...network.suppliers, ...network.assemblySites, ...network.dcs].map((n) => {
        const pos = positions[n.id] || { x: 0, y: 0 };
        return (
          <g key={n.id} transform={`translate(${pos.x},${pos.y})`} style={{ cursor: 'pointer' }}
            onClick={() => {
              if (n.id.startsWith('WEST') || n.id.startsWith('DURHAM') || n.id.startsWith('CMO')) {
                // treat as supplier
                setPendingSupplier(n.id);
              }
              // If assembly/dc clicked after a supplier is pending, assign to that LRU
              if ((n.id.startsWith('US_DC') || n.id.startsWith('EU_DC')) && pendingSupplier) {
                const sId = pendingSupplier;
                const aId = n.id;
                setAssignment((prev) => ({
                  ...prev,
                  [activeLruId]: { ...prev[activeLruId], supplierId: sId, assemblyId: aId }
                }));
                setPendingSupplier(null);
              }
            }}>
            <rect width={nodeW} height={nodeH} fill="#0f172a" stroke="#475569" strokeWidth="1" rx="6" />
            <text x={nodeW/2} y={nodeH/2 + 4} fontSize="10" fill="#e2e8f0" textAnchor="middle">{n.name}</text>
            {pendingSupplier && n.id === pendingSupplier && (
              <rect width={nodeW} height={nodeH} fill="rgba(0,255,255,0.1)" stroke="#00f5c4" strokeWidth="2" rx="6" />
            )}
          </g>
        );
      })}
      <text x={20} y={height - 10} fontSize="10" fill="#6b7280">Click supplier then DC to connect • Click edge tag to change mode</text>
    </svg>
  );
}

// UI primitives
function Panel({ title, subtitle, children }) {
  return (
    <div className="border border-slate-700 bg-slate-800 rounded-lg p-3">
      <h3 className="text-slate-200 text-sm font-bold mb-1">{title}</h3>
      {subtitle && <div className="text-slate-400 text-xs mb-2">{subtitle}</div>}
      {children}
    </div>
  );
}
function Label({ children }) { return <div className="text-slate-400 text-xs mb-1">{children}</div>; }
function KPI({ label, value }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-2 flex flex-col gap-1 min-w-[150px]">
      <div className="text-slate-500 text-xs">{label}</div>
      <div className="text-slate-200 text-lg font-semibold">{value}</div>
    </div>
  );
}
function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={onChange} className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-md p-1">
      {options.map((o) => (<option key={o.id || o.name} value={o.id || o.value}>{o.name || o.label}</option>))}
    </select>
  );
}
function Range({ label, min, max, step, value, onChange }) {
  return (
    <div className="flex flex-col mb-2">
      <div className="flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>{typeof value === 'number' ? value.toFixed(2) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full accent-indigo-500" />
    </div>
  );
}

// Compute loads for capacity & bottlenecks
function computeLoads(data, assignment, demandMultiplier) {
  const plantLoad = {};
  const dcLoad = {};
  const lrus = [
    { id: 'US', baseDemand: data.products[0].monthlyDemand.US },
    { id: 'EU', baseDemand: data.products[0].monthlyDemand.EU }
  ];
  lrus.forEach((l) => {
    const pick = assignment[l.id];
    const units = l.baseDemand * demandMultiplier;
    plantLoad[pick.supplierId] = (plantLoad[pick.supplierId] || 0) + units;
    dcLoad[pick.assemblyId] = (dcLoad[pick.assemblyId] || 0) + units;
  });
  const supplierUtil = data.plants.map((p) => {
    const load = plantLoad[p.id] || 0;
    const util = load / p.capacity;
    return { id: p.id, name: p.name, load, cap: p.capacity, util };
  });
  const assemblyUtil = data.dcs.map((dc) => {
    const load = dcLoad[dc.id] || 0;
    const cap = 999999;
    const util = load / cap;
    return { id: dc.id, name: dc.name, load, cap, util };
  });
  return { supplierUtil, assemblyUtil };
}

// Evaluate solution from assignment
function evaluateSolutionWrapper({ assignment, params, network }) {
  // Build a state for evaluateScenario based on assignment and params
  const data = JSON.parse(JSON.stringify(initialData));
  const alloc = {};
  const mode = {};
  network.lrus.forEach((lru) => {
    const pick = assignment[lru.id];
    if (!pick) return;
    const units = Math.round(lru.baseDemand * params.demandMultiplier);
    const key = `${pick.supplierId}->${pick.assemblyId}`;
    alloc[key] = (alloc[key] || 0) + units;
    mode[key] = pick.mode;
  });
  data.choices = { alloc, mode };
  data.levers = {
    serviceTarget: params.serviceTarget,
    riskWeight: params.riskWeight,
    carbonPrice: params.carbonPrice,
    demandVol: params.demandVol,
    overflow: params.allowOverflow,
    fuelSurcharge: params.fuelSurcharge
  };
  const res = evaluateScenario(data);
  // Map metrics into P&C-style totals
  const totals = {
    units: res.metrics.demand,
    material: 0,
    tariffs: 0,
    transportCost: res.metrics.transportCost,
    assembly: res.metrics.convCost,
    overhead: 0,
    inventory: res.metrics.overflowCost,
    carbonKg: res.metrics.carbon,
    riskIndex: res.metrics.riskScore,
    serviceLevel: res.metrics.otif
  };
  const cost = res.metrics.cost;
  const feasible = res.metrics.otif >= params.serviceTarget;
  const objective = cost + params.riskWeight * res.metrics.riskScore * 1000;
  const capacity = {
    supLoad: res.plantUtil,
    asmLoad: res.supplyByDC,
    matBySup: {},
    asmCostBySite: {}
  };
  return { totals, cost, feasible, objective, capacity };
}

// Enumerate best solution for assignment (search over small combos)
function enumerateBestSolutionMMD({ network, params }) {
  const lrus = network.lrus;
  const suppliers = network.suppliers;
  const assemblySites = network.assemblySites;
  const modes = ['air', 'ground', 'ocean'];
  let best = null;
  function dfs(idx, current) {
    if (idx === lrus.length) {
      const res = evaluateSolutionWrapper({ assignment: current, params, network });
      if (res.feasible) {
        if (!best || res.objective < best.objective) {
          best = { ...res, assignment: { ...current } };
        }
      }
      return;
    }
    const lru = lrus[idx];
    for (const s of suppliers) {
      for (const a of assemblySites) {
        for (const m of modes) {
          current[lru.id] = { supplierId: s.id, assemblyId: a.id, mode: m };
          dfs(idx + 1, current);
        }
      }
    }
  }
  dfs(0, {});
  return best;
}

export default function App() {
  // Create network representation
  const network = useMemo(() => {
    const regionMeta = {
      US: { id: 'US', name: 'US', risk: 0.02, carbon: 0.5 },
      EU: { id: 'EU', name: 'EU', risk: 0.02, carbon: 0.5 }
    };
    const suppliers = initialData.plants.map((p) => ({
      id: p.id,
      name: p.name,
      region: regionMeta[p.region],
      unitCost: p.convCost,
      leadTimeDays: 5,
      reliability: p.uptime,
      capacity: p.capacity,
      tariffRate: 0
    }));
    const assemblySites = initialData.dcs.map((dc) => ({
      id: dc.id,
      name: dc.name,
      region: regionMeta[dc.region],
      laborCostMultiplier: 1.0,
      fixedOverhead: 0,
      capacity: 999999
    }));
    const dcs = [];
    const lrus = [
      { id: 'US', name: 'US Demand', baseDemand: initialData.products[0].monthlyDemand.US, bomLaborHours: 1.0, bomScrapRate: 0 },
      { id: 'EU', name: 'EU Demand', baseDemand: initialData.products[0].monthlyDemand.EU, bomLaborHours: 1.0, bomScrapRate: 0 }
    ];
    const transport = {
      air: { costPerTonMi: 0.02, leadPenaltyDays: -1, carbonPerTonMi: 1.0 },
      ocean: { costPerTonMi: 0.005, leadPenaltyDays: +10, carbonPerTonMi: 0.2 },
      ground: { costPerTonMi: 0.002, leadPenaltyDays: 0, carbonPerTonMi: 0.4 }
    };
    const distances = { 'US-US': 0.4, 'US-EU': 3.9, 'EU-US': 3.9, 'EU-EU': 0.2 };
    return { suppliers, assemblySites, dcs, lrus, transport, distances };
  }, []);
  // Parameter levers
  const [serviceTarget, setServiceTarget] = useState(0.95);
  const [riskWeight, setRiskWeight] = useState(0.002);
  const [carbonPrice, setCarbonPrice] = useState(0.02);
  const [demandVol, setDemandVol] = useState(0.10);
  const [fuelSurcharge, setFuelSurcharge] = useState(0.02);
  const [allowOverflow, setAllowOverflow] = useState(true);
  const [demandMultiplier, setDemandMultiplier] = useState(1.0);
  // Reliability shock (σ) used in Monte Carlo; default ±2%
  const [relShock, setRelShock] = useState(0.02);
  // Assignment per LRU
  const [assignment, setAssignment] = useState(() => ({
    US: { supplierId: 'WEST_POINT_PA', assemblyId: 'US_DC_WP', mode: 'ground' },
    EU: { supplierId: 'CMO_EU', assemblyId: 'EU_DC_HEI', mode: 'ground' }
  }));
  // Active LRU for graph interactions
  const [activeLruId, setActiveLruId] = useState('US');
  const [pendingSupplier, setPendingSupplier] = useState(null);
  // Monte Carlo / Sensitivity
  const [mcStats, setMcStats] = useState(null);
  const [sens, setSens] = useState(null);
  // Saved scenarios
  const [saved, setSaved] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mmd_scenarios') || '[]'); } catch { return []; }
  });
  // Compare modal
  const [showCompare, setShowCompare] = useState(false);
  const [baselineId, setBaselineId] = useState(null);

  // Derived params object
  const params = useMemo(() => ({
    serviceTarget,
    riskWeight,
    carbonPrice,
    demandVol,
    demandMultiplier,
    allowOverflow,
    fuelSurcharge,
    relShock
  }), [serviceTarget, riskWeight, carbonPrice, demandVol, demandMultiplier, allowOverflow, fuelSurcharge, relShock]);

  // Evaluate current assignment
  const result = useMemo(() => evaluateSolutionWrapper({ assignment, params, network }), [assignment, params, network]);
  const loads = useMemo(() => computeLoads(initialData, assignment, demandMultiplier), [assignment, demandMultiplier]);

  // Run optimize
  const [optBusy, setOptBusy] = useState(false);
  async function runOptimize() {
    setOptBusy(true);
    try {
      const best = enumerateBestSolutionMMD({ network, params });
      if (best) {
        setAssignment(best.assignment);
      }
    } finally { setOptBusy(false); }
  }

  // Monte Carlo simulation
  function handleRunMC(samples = 200) {
    setMcStats(null);
    setTimeout(() => {
      const state = {
        products: JSON.parse(JSON.stringify(initialData.products)),
        plants: JSON.parse(JSON.stringify(initialData.plants)),
        dcs: JSON.parse(JSON.stringify(initialData.dcs)),
        lanes: JSON.parse(JSON.stringify(initialData.lanes)),
        choices: { alloc: {}, mode: {} },
        levers: {
          serviceTarget,
          riskWeight,
          carbonPrice,
          demandVol,
          overflow: allowOverflow,
          fuelSurcharge
        }
      };
      // build choices from assignment
      Object.entries(assignment).forEach(([lruId, pick]) => {
        const units = initialData.products[0].monthlyDemand[lruId] * demandMultiplier;
        const key = `${pick.supplierId}->${pick.assemblyId}`;
        state.choices.alloc[key] = (state.choices.alloc[key] || 0) + units;
        state.choices.mode[key] = pick.mode;
      });
      const res = runMonteCarlo(state, samples, relShock);
      setMcStats(res);
    }, 50);
  }

  // Sensitivity
  function handleSensitivity() {
    const state = {
      products: JSON.parse(JSON.stringify(initialData.products)),
      plants: JSON.parse(JSON.stringify(initialData.plants)),
      dcs: JSON.parse(JSON.stringify(initialData.dcs)),
      lanes: JSON.parse(JSON.stringify(initialData.lanes)),
      choices: { alloc: {}, mode: {} },
      levers: {
        serviceTarget,
        riskWeight,
        carbonPrice,
        demandVol,
        overflow: allowOverflow,
        fuelSurcharge
      }
    };
    Object.entries(assignment).forEach(([lruId, pick]) => {
      const units = initialData.products[0].monthlyDemand[lruId] * demandMultiplier;
      const key = `${pick.supplierId}->${pick.assemblyId}`;
      state.choices.alloc[key] = (state.choices.alloc[key] || 0) + units;
      state.choices.mode[key] = pick.mode;
    });
    const res = tornado(state);
    setSens(res);
  }

  // Save scenario
  function saveScenario() {
    const snap = {
      id: `${Date.now()}`,
      params,
      assignment,
      metrics: result,
      ts: new Date().toISOString()
    };
    const next = [snap, ...saved].slice(0, 12);
    setSaved(next);
    localStorage.setItem('mmd_scenarios', JSON.stringify(next));
  }

  function clearSaved() {
    setSaved([]);
    localStorage.removeItem('mmd_scenarios');
  }

  // Export JSON
  function downloadJSON() {
    const payload = {
      assignment,
      params,
      state: {
        products: initialData.products,
        plants: initialData.plants,
        dcs: initialData.dcs
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mmd-scenario-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Share link
  async function copyShareLink() {
    const payload = { assignment, params };
    const url = `${location.origin}${location.pathname}#${btoa(encodeURIComponent(JSON.stringify(payload)))}`;
    try {
      await navigator.clipboard.writeText(url);
      alert('Share link copied to clipboard');
    } catch {
      prompt('Copy link:', url);
    }
  }

  // Load from share link on mount
  useEffect(() => {
    try {
      if (location.hash && location.hash.length > 1) {
        const decoded = JSON.parse(decodeURIComponent(atob(location.hash.slice(1))));
        if (decoded.assignment) setAssignment(decoded.assignment);
        if (decoded.params) {
          const p = decoded.params;
          setServiceTarget(p.serviceTarget ?? 0.95);
          setRiskWeight(p.riskWeight ?? 0.002);
          setCarbonPrice(p.carbonPrice ?? 0.02);
          setDemandVol(p.demandVol ?? 0.10);
          setDemandMultiplier(p.demandMultiplier ?? 1.0);
          setAllowOverflow(p.allowOverflow ?? true);
          setFuelSurcharge(p.fuelSurcharge ?? 0.02);
          setRelShock(p.relShock ?? 0.02);
        }
      }
    } catch {}
  }, []);

  const infeasible = !result.feasible;

  return (
    <div className="text-slate-100">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-4 no-print">
        <div>
          <h1 className="text-lg font-bold">MMD Supply Chain Strategy Simulator</h1>
          <div className="text-xs text-slate-400">Interactive • Optimize • Capacity • Monte Carlo • Sensitivity</div>
        </div>
        <div className="flex gap-2">
          <button className="btn primary" onClick={runOptimize} disabled={optBusy}>{optBusy ? 'Optimizing…' : 'Optimize'}</button>
          <button className="btn" onClick={saveScenario}>Save</button>
          <button className="btn" onClick={downloadJSON}>Export JSON</button>
          <button className="btn" onClick={copyShareLink}>Share Link</button>
          <button className="btn" onClick={() => setShowCompare(true)}>Compare</button>
          <button className="btn" onClick={() => window.print()}>Export PDF</button>
        </div>
      </div>
      {/* Infeasible banner */}
      {infeasible && (
        <div className="bg-rose-600 text-slate-100 text-sm px-3 py-2 rounded-lg mb-3 no-print">
          Infeasible under current constraints (service target, capacity, overflow policy). Adjust targets, allow overflow, or reassign.
        </div>
      )}
      {/* Main layout */}
      <div className="grid grid-cols-5 gap-3">
        {/* Left controls */}
        <div className="col-span-2 flex flex-col gap-3">
          <Panel title="Policy levers">
            <Range label="Service Target" min={0.8} max={0.99} step={0.01} value={serviceTarget} onChange={setServiceTarget} />
            <Range label="Risk Weight" min={0.0005} max={0.01} step={0.0005} value={riskWeight} onChange={setRiskWeight} />
            <Range label="Carbon Price ($/kg)" min={0} max={0.10} step={0.005} value={carbonPrice} onChange={setCarbonPrice} />
            <Range label="Demand Volatility (σ)" min={0} max={0.5} step={0.01} value={demandVol} onChange={setDemandVol} />
            <Range label="Fuel Surcharge ($/u)" min={0} max={0.10} step={0.005} value={fuelSurcharge} onChange={setFuelSurcharge} />
            <div className="checkbox">
              <input type="checkbox" checked={allowOverflow} onChange={(e) => setAllowOverflow(e.target.checked)} id="overflowToggle" />
              <label htmlFor="overflowToggle">Allow surge/overflow (3PL/CMO)</label>
            </div>
          </Panel>
          <Panel title="Monte Carlo & Sensitivity">
            <div className="flex flex-col gap-2">
              {/* Reliability shock slider for Monte Carlo */}
              <Range label="Reliability Shock (σ)" min={0} max={0.10} step={0.005} value={relShock} onChange={setRelShock} />
              <button className="btn" onClick={() => handleRunMC(200)} disabled={mcStats && false}>{mcStats ? 'Run again' : 'Run 200 sims'}</button>
              {mcStats && (
                <div className="text-xs text-slate-300">
                  P(Service ≥ T): {(mcStats.probHit*100).toFixed(1)}% • Avg {fmt(mcStats.meanCost,0)} • 90th {fmt(mcStats.p90Cost,0)}
                </div>
              )}
              <button className="btn" onClick={handleSensitivity}>Run Sensitivity</button>
            </div>
          </Panel>
          <Panel title="Saved scenarios">
            {saved.length === 0 ? (
              <div className="text-xs text-slate-400">No saved scenarios yet.</div>
            ) : (
              <div className="flex flex-col gap-2 max-h-40 overflow-auto">
                {saved.map((s) => (
                  <div key={s.id} className="flex items-center justify-between text-xs">
                    <div className="flex flex-col">
                      <span>{new Date(s.ts).toLocaleString()}</span>
                      <span className="text-slate-500">OTIF {(s.metrics.totals.serviceLevel*100).toFixed(1)}% • Obj {fmt(s.objective ?? (s.metrics.cost + s.params?.riskWeight * s.metrics.totals.riskIndex * 1000),0)}</span>
                    </div>
                    <button className="btn" onClick={() => {
                      setAssignment(s.assignment);
                      setServiceTarget(s.params.serviceTarget);
                      setRiskWeight(s.params.riskWeight);
                      setCarbonPrice(s.params.carbonPrice);
                      setDemandVol(s.params.demandVol);
                      setDemandMultiplier(s.params.demandMultiplier ?? 1);
                      setAllowOverflow(s.params.allowOverflow);
                      setFuelSurcharge(s.params.fuelSurcharge);
                    }}>Load</button>
                  </div>
                ))}
                <button className="btn ghost mt-1 text-xs" onClick={clearSaved}>Clear all</button>
              </div>
            )}
          </Panel>
        </div>
        {/* Center: Graph & LRU edits */}
        <div className="col-span-2 flex flex-col gap-3">
          <Panel title="Network & Flows" subtitle="Click supplier then DC to connect; click edge tag to change mode">
            <div className="mb-2">
              <label className="text-xs text-slate-400 mr-1">Active Demand:</label>
              <select value={activeLruId} onChange={(e) => setActiveLruId(e.target.value)} className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-md p-1">
                {network.lrus.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
              </select>
              {pendingSupplier && <span className="ml-2 text-amber-400 text-xs">Supplier selected… pick a DC or press ESC</span>}
            </div>
            <Graph network={network} assignment={assignment} setAssignment={setAssignment} activeLruId={activeLruId} pendingSupplier={pendingSupplier} setPendingSupplier={setPendingSupplier} />
          </Panel>
          <Panel title="Demands & assignments">
            {network.lrus.map((l) => (
              <div key={l.id} className="flex items-center gap-2 mb-1">
                <strong className="text-slate-200 text-xs" style={{width:'80px'}}>{l.name}</strong>
                <span className="text-slate-400 text-xs">{assignment[l.id].supplierId}→{assignment[l.id].assemblyId} • {assignment[l.id].mode}</span>
              </div>
            ))}
          </Panel>
          <Panel title="Capacity utilisation & bottlenecks">
            <div className="text-xs">
              <div className="mb-1 font-semibold">Plants</div>
              {loads.supplierUtil.map((s) => (
                <div key={s.id} className="flex items-center gap-2 mb-1">
                  <span className="w-36">{s.name}</span>
                  <div className="flex-1 bar"><span style={{ width: `${Math.min(100, s.util*100)}%` }} /></div>
                  <span>{Math.round(s.load)}/{s.cap}</span>
                </div>
              ))}
              <div className="mb-1 font-semibold mt-2">Distribution</div>
              {loads.assemblyUtil.map((a) => (
                <div key={a.id} className="flex items-center gap-2 mb-1">
                  <span className="w-36">{a.name}</span>
                  <div className="flex-1 bar"><span style={{ width: `${Math.min(100, a.util*100)}%` }} /></div>
                  <span>{Math.round(a.load)}/{a.cap}</span>
                </div>
              ))}
              <div className="mt-2">
                <span className="font-semibold">Bottlenecks (≥85%): </span>
                {[
                  ...loads.supplierUtil.map(s=>({ type:'Plant', ...s })),
                  ...loads.assemblyUtil.map(a=>({ type:'DC', ...a }))
                ].filter(x=>x.util>=0.85).sort((a,b)=>b.util-a.util).map((x) => (
                  <span key={x.id} className="mr-3">{x.type}: {x.name} {Math.round(x.util*100)}%</span>
                ))}
                {[
                  ...loads.supplierUtil.map(s=>s.util),
                  ...loads.assemblyUtil.map(a=>a.util)
                ].every(u=>u<0.85) && <span>None</span>}
              </div>
            </div>
          </Panel>
        </div>
        {/* Right: KPIs & charts */}
        <div className="col-span-1 flex flex-col gap-3">
          <Panel title="KPIs (per period)">
            <KPI label="Total Cost" value={`$${fmt(result.cost,0)}`} />
            <KPI label="Service Level" value={`${(result.totals.serviceLevel*100).toFixed(1)}%`} />
            <KPI label="Transport" value={`$${fmt(result.totals.transportCost,0)}`} />
            <KPI label="Conversion" value={`$${fmt(result.totals.assembly,0)}`} />
            <KPI label="Overflow" value={`$${fmt(result.totals.inventory,0)}`} />
            <KPI label="Carbon (kg)" value={`${fmt(result.totals.carbonKg,0)}`} />
            <KPI label="Risk Index" value={`${result.totals.riskIndex.toFixed(0)}`} />
          </Panel>
          <Panel title="Objective Breakdown">
            <div className="text-xs text-slate-300">
              <div>Cost: ${fmt(result.cost,0)}</div>
              <div>Risk Term: ${fmt((params.riskWeight * result.totals.riskIndex * 1000),0)}</div>
              <div>Objective: ${fmt(result.objective,0)}</div>
              <div className="text-slate-500 text-xs mt-1">Objective = Cost + RiskWeight × RiskIndex × 1000</div>
            </div>
          </Panel>
          <Panel title="Service vs Target">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs"><span>Service</span><span>{(result.totals.serviceLevel*100).toFixed(1)}%</span></div>
              <div className="bar"><span style={{ width: `${Math.min(result.totals.serviceLevel*100,100)}%` }} /></div>
              <div className="flex justify-between text-xs mt-2"><span>Target</span><span>{(params.serviceTarget*100).toFixed(1)}%</span></div>
              <div className="bar"><span style={{ width: `${Math.min(params.serviceTarget*100,100)}%` }} /></div>
            </div>
          </Panel>
          {sens && (
            <Panel title="Sensitivity (tornado)">
              {sens.rows.map((r, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs mb-1">
                  <span>{r.name}</span>
                  <span className={r.delta > 0 ? 'text-rose-400' : 'text-emerald-400'}>{r.delta>0?'+':''}${fmt(r.delta,0)}</span>
                </div>
              ))}
              <div className="text-xs text-slate-500 mt-1">Base objective: ${fmt(sens.base,0)}</div>
            </Panel>
          )}
        </div>
      </div>
      {/* Compare modal */}
      {showCompare && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 max-h-[80vh] overflow-auto w-[800px]">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-lg font-bold">Compare Saved Scenarios</h3>
              <button className="btn" onClick={() => setShowCompare(false)}>Close</button>
            </div>
            {saved.length < 2 ? (
              <div className="text-slate-400 text-sm">Save at least two scenarios to compare.</div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <label className="text-slate-400 text-xs">Baseline</label>
                  <select value={baselineId || saved[0].id} onChange={(e) => setBaselineId(e.target.value)} className="bg-slate-700 text-slate-200 text-xs p-1 rounded">
                    {saved.map((s) => (<option key={s.id} value={s.id}>{new Date(s.ts).toLocaleString()}</option>))}
                  </select>
                </div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-slate-300">
                      <th className="border-b border-slate-700 p-1 text-left">Scenario</th>
                      <th className="border-b border-slate-700 p-1">Objective</th>
                      <th className="border-b border-slate-700 p-1">Cost</th>
                      <th className="border-b border-slate-700 p-1">Service</th>
                      <th className="border-b border-slate-700 p-1">Risk</th>
                      <th className="border-b border-slate-700 p-1">Δ vs Base</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saved.map((s) => {
                      const obj = s.metrics.cost + params.riskWeight * s.metrics.totals.riskIndex * 1000;
                      const baseSnap = saved.find(x => x.id === (baselineId || saved[0].id));
                      const baseObj = baseSnap.metrics.cost + params.riskWeight * baseSnap.metrics.totals.riskIndex * 1000;
                      const delta = obj - baseObj;
                      const pctDelta = baseObj ? (delta/baseObj*100) : 0;
                      return (
                        <tr key={s.id} className="text-slate-200 text-center">
                          <td className="border-b border-slate-700 p-1 text-left">{new Date(s.ts).toLocaleTimeString()}</td>
                          <td className="border-b border-slate-700 p-1">${fmt(obj,0)}</td>
                          <td className="border-b border-slate-700 p-1">${fmt(s.metrics.cost,0)}</td>
                          <td className="border-b border-slate-700 p-1">{(s.metrics.totals.serviceLevel*100).toFixed(1)}%</td>
                          <td className="border-b border-slate-700 p-1">{s.metrics.totals.riskIndex.toFixed(0)}</td>
                          <td className="border-b border-slate-700 p-1">
                            <span className={delta>0?'text-rose-400':'text-emerald-400'}>
                              {delta>0?'+':''}${fmt(delta,0)} ({pctDelta.toFixed(1)}%)
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}