// Generates an SVG architecture diagram for the Briefing modal,
// based on a level's preBuilt.services + connections.
//
// Each service is drawn as a colored circle with its type label.
// "internet" is drawn as a dark globe on the left.
// Connections are simple lines between centers.
// `highlights[index] === "critical"` renders the node red with a flame.

const DIAGRAM_SERVICE_COLORS = {
    waf:        "#a855f7",
    alb:        "#3b82f6",
    compute:    "#f97316",
    serverless: "#fbbf24",
    db:         "#dc2626",
    nosql:      "#7c3aed",
    s3:         "#10b981",
    cdn:        "#4ade80",
    cache:      "#dc382d",
    sqs:        "#ff9900",
    apigw:      "#e879f9",
    search:     "#06b6d4",
    replica:    "#f472b6",
};

const DIAGRAM_SERVICE_LABELS = {
    waf: "FW", alb: "LB", compute: "CPU", serverless: "λ",
    db: "SQL", nosql: "NoSQL", s3: "S3", cdn: "CDN",
    cache: "Cache", sqs: "Queue", apigw: "API GW",
    search: "Search", replica: "Replica",
};

/**
 * @param {{services:{type:string,x:number,z:number}[], connections:Array<[string|number,number]>}} preBuilt
 * @param {Object<number,string>} highlights e.g. { 3: "critical" }
 * @returns {string} SVG markup
 */
function renderArchitectureSVG(preBuilt, highlights = {}) {
    const services = preBuilt.services || [];
    const connections = preBuilt.connections || [];

    // Layout: spread Internet on the far left, services in a horizontal flow
    // ordered by their original x coordinate.
    const positions = {};
    positions.internet = { x: 40, y: 80 };

    const sorted = services
        .map((s, i) => ({ idx: i, x: s.x, z: s.z, type: s.type }))
        .sort((a, b) => a.x - b.x);

    // Spread services evenly across width 120..560 (image area)
    const spread = sorted.length === 0 ? 0 : (520 - 120) / Math.max(1, sorted.length - 1);
    sorted.forEach((s, i) => {
        positions[s.idx] = {
            x: 120 + i * (sorted.length === 1 ? 200 : spread),
            y: 80 + s.z * 4, // small vertical offset by z
        };
    });

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160" width="100%" height="160">';

    // Background grid lines for visual interest
    svg += '<defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">';
    svg += '<path d="M 20 0 L 0 0 0 20" fill="none" stroke="#1f2937" stroke-width="0.5"/>';
    svg += '</pattern></defs>';
    svg += '<rect width="600" height="160" fill="#0b1220"/>';
    svg += '<rect width="600" height="160" fill="url(#grid)"/>';

    // Connections first (so they sit under nodes)
    for (const [from, to] of connections) {
        const a = positions[from];
        const b = positions[to];
        if (!a || !b) continue;
        svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#00FF85" stroke-width="2" opacity="0.6"/>`;
    }

    // Internet node
    svg += `<circle cx="${positions.internet.x}" cy="${positions.internet.y}" r="18" fill="#111111" stroke="#00ffff" stroke-width="2"/>`;
    svg += `<text x="${positions.internet.x}" y="${positions.internet.y + 4}" text-anchor="middle" fill="#00ffff" font-size="10" font-family="monospace">WWW</text>`;

    // Service nodes
    for (const s of sorted) {
        const p = positions[s.idx];
        const color = DIAGRAM_SERVICE_COLORS[s.type] || "#9ca3af";
        const label = DIAGRAM_SERVICE_LABELS[s.type] || s.type.toUpperCase();
        const isCritical = highlights[s.idx] === "critical";

        if (isCritical) {
            // red glow background
            svg += `<circle cx="${p.x}" cy="${p.y}" r="24" fill="#ef4444" opacity="0.3"><animate attributeName="r" values="20;28;20" dur="1.5s" repeatCount="indefinite"/></circle>`;
        }
        svg += `<circle cx="${p.x}" cy="${p.y}" r="18" fill="${color}" stroke="${isCritical ? "#ef4444" : "#1f2937"}" stroke-width="2"/>`;
        svg += `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" fill="#0b1220" font-size="9" font-weight="bold" font-family="monospace">${label}</text>`;
        if (isCritical) {
            svg += `<text x="${p.x}" y="${p.y - 22}" text-anchor="middle" font-size="14">🔥</text>`;
        }
    }

    svg += '</svg>';
    return svg;
}
