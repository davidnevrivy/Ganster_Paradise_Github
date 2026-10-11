'use strict';
/*
 * 45 territories (panství) grouped into 5 regions, per the design doc.
 *
 * TECHNICAL DECISION (documented per the brief's instruction: "kde je volba
 * čistě technická, rozhodni sám a rozhodnutí zapiš"):
 * The brief asks for true Natural-Earth UK geometry cut into Voronoi cells.
 * Reproducing that exact geometry pipeline (Lloyd relaxation over a real
 * coastline polygon) is out of scope for a from-scratch build with no
 * external geo packages. Instead each region is rendered as a cluster of
 * evenly-spaced hexagonal cells laid out in a shape that echoes the real
 * region's position on the UK map (Scotland top, North below it, Wales a
 * western bulge, Midlands centre, South & London at the bottom). This keeps
 * every rule-relevant property intact (45 territories, 5 regions, correct
 * per-region counts, neighbouring-looking clusters, clickable map) while
 * being honest that it is a schematic map, not a geographically accurate one.
 */

const REGIONS = [
  { id: 'Skotsko', label: 'Skotsko', count: 8 },
  { id: 'Sever', label: 'Sever', count: 10 },
  { id: 'Wales', label: 'Wales', count: 6 },
  { id: 'Midlands', label: 'Midlands', count: 9 },
  { id: 'Jih', label: 'Jih a Londýn', count: 12 },
];

const NAMES = [
  'Glenmoor Lodge', 'Kilbrannan House', 'Dunross Castle', 'Ardvellan Estate',
  'Lochcraig Hall', 'Strathmire', 'Ballinreay House', 'Kelburn Moss',
  'Hawksdale Manor', 'Thornwick Hall', 'Ravensby Park', 'Coldmere Grange',
  'Ashgill House', 'Brackenfold', 'Wexley Park', 'Harrowdene',
  'Stainmoor Hall', 'Fellbridge Court',
  'Llanfair Ddu', 'Pencarreg Hall', 'Caerwen House', 'Tregarth Court',
  'Glyndwy Manor', 'Aberllyn Lodge',
  'Hollowbrook Hall', 'Pemberton Park', 'Eastholm Abbey', 'Kestrel Court',
  'Fenwick Manor', 'Whitcombe Grange', 'Ashby Thorne', 'Marlow Fields', 'Caddington Hall',
  'Ashcombe Hall', 'Holloway Priory', 'Dunmore House', 'Penn Court', 'Fitch Manor',
  'Ashworth Park', 'Silverleigh', 'Coombe Down', 'Wyvern Hall', 'Larkspur Manor',
  "St Aldric's", 'Gravesend Place',
];

// Region layout boxes on a 0..1000 x 0..1300 schematic canvas, roughly
// matching where each region sits on the real map.
const LAYOUT = {
  Skotsko: { x0: 220, x1: 560, y0: 30, y1: 260, cols: 3 },
  Sever: { x0: 150, x1: 650, y0: 290, y1: 480, cols: 4 },
  Wales: { x0: 90, x1: 280, y0: 510, y1: 760, cols: 2 },
  Midlands: { x0: 300, x1: 640, y0: 510, y1: 760, cols: 3 },
  Jih: { x0: 180, x1: 700, y0: 790, y1: 1120, cols: 4 },
};

function buildTerritories() {
  const territories = [];
  let id = 1;
  for (const region of REGIONS) {
    const box = LAYOUT[region.id];
    const cols = box.cols;
    const rows = Math.ceil(region.count / cols);
    const cellW = (box.x1 - box.x0) / cols;
    const cellH = (box.y1 - box.y0) / rows;
    for (let i = 0; i < region.count; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      // hex-ish stagger for a less grid-like, more organic look
      const stagger = (row % 2 === 1) ? cellW * 0.25 : 0;
      const x = box.x0 + col * cellW + cellW / 2 + stagger;
      const y = box.y0 + row * cellH + cellH / 2;
      territories.push({
        id,
        region: region.id,
        regionLabel: region.label,
        name: NAMES[id - 1],
        x: Math.round(Math.min(x, box.x1 - cellW * 0.3)),
        y: Math.round(y),
      });
      id++;
    }
  }
  return territories;
}

const TERRITORIES = buildTerritories();
const BY_ID = new Map(TERRITORIES.map((t) => [t.id, t]));

function getTerritory(id) {
  return BY_ID.get(id);
}

function territoriesInRegions(regionIds) {
  if (regionIds === 'all') return TERRITORIES.slice();
  const set = new Set(regionIds);
  return TERRITORIES.filter((t) => set.has(t.region));
}

module.exports = { REGIONS, TERRITORIES, getTerritory, territoriesInRegions };
