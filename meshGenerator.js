import Delaunator from "delaunator";

export class MeshGenerator {
    constructor(canvasWidth, canvasHeight, voronoiNoiseScale = 0.02, voronoiNoiseStrength = 30.0, voronoiAnimationSpeed = 0.03) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        
        // voronoi parameters
        this.voronoiCellSize = 30; // approximate size of Voronoi cells in pixels
        this.voronoiAnimationSpeed = voronoiAnimationSpeed; // speed of Voronoi animation
        this.time = 0; // animation time
        
        // displacement parameters
        this.voronoiNoiseScale = voronoiNoiseScale; // scale for site displacement
        this.voronoiNoiseStrength = voronoiNoiseStrength; // strength of site displacement in pixels
        
        // triangulation parameters
        // filter degenerate triangles to prevent gaps
        this.minTriangleArea = 1e-10; // minimum triangle area in normalized coordinates
        this.minEdgeLength = 1e-10; // minimum edge length
        
        this.siteJitter = new Map(); // store jitter values per site for consistency
    }
    
    // simple displacement function for Voronoi cells
    displacement(p) {
        // use sine waves for smooth, periodic displacement
        // combine multiple frequencies for more organic pattern
        const d1 = Math.sin(p[0] * 0.1 + p[1] * 0.15 + this.time);
        const d2 = Math.sin(p[1] * 0.12 - p[0] * 0.08 + this.time * 0.7);
        return (d1 + d2) * 0.5; // average, maps to [-1, 1]
    }
    
    // update animation time
    update(deltaTime) {
        this.time += deltaTime * this.voronoiAnimationSpeed;
    }

    // calculate triangle area (using cross product)
    triangleArea(p0, p1, p2) {
        return Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) / 2;
    }
    
    // calculate edge length
    edgeLength(p0, p1) {
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // generate Voronoi sites
    generateVoronoiSites() {
        const sites = [];
        const cols = Math.ceil(this.canvasWidth / this.voronoiCellSize);
        const rows = Math.ceil(this.canvasHeight / this.voronoiCellSize);
        
        // generate grid of sites
        for (let row = 0; row <= rows; row++) {
            for (let col = 0; col <= cols; col++) {
                // base position on grid
                let x = col * this.voronoiCellSize;
                let y = row * this.voronoiCellSize;
                
                // add some jitter for more organic pattern (use stored jitter for consistency)
                const jitterKey = `${col},${row}`;
                if (!this.siteJitter.has(jitterKey)) {
                    this.siteJitter.set(jitterKey, {
                        x: (Math.random() - 0.5) * this.voronoiCellSize * 0.3,
                        y: (Math.random() - 0.5) * this.voronoiCellSize * 0.3
                    });
                }
                const jitter = this.siteJitter.get(jitterKey);
                x += jitter.x;
                y += jitter.y;
                
                // apply displacement to Voronoi sites (pre-tesselation)
                const noiseX = x * this.voronoiNoiseScale;
                const noiseY = y * this.voronoiNoiseScale;
                const displacementX = this.displacement([noiseX, noiseY]);
                const displacementY = this.displacement([noiseY, noiseX + 100.0]); // offset for different pattern
                
                // displace position (displacement is already in [-1, 1] range)
                x += displacementX * this.voronoiNoiseStrength;
                y += displacementY * this.voronoiNoiseStrength;
                
                // clamp to canvas bounds
                x = Math.max(0, Math.min(x, this.canvasWidth));
                y = Math.max(0, Math.min(y, this.canvasHeight));
                
                sites.push({ x, y, originalCol: col, originalRow: row });
            }
        }
        
        return sites;
    }
    
    // extract Voronoi cells from Delaunay triangulation
    getVoronoiCells(delaunay, sites) {
        const cells = [];
        const { triangles, halfedges, coords } = delaunay;
        
        // build edge map: site index -> list of triangles containing it
        const siteTriangles = new Map();
        for (let i = 0; i < sites.length; i++) {
            siteTriangles.set(i, []);
        }
        
        // find all triangles for each site
        for (let t = 0; t < triangles.length / 3; t++) {
            const i0 = triangles[t * 3];
            const i1 = triangles[t * 3 + 1];
            const i2 = triangles[t * 3 + 2];
            
            siteTriangles.get(i0).push(t);
            siteTriangles.get(i1).push(t);
            siteTriangles.get(i2).push(t);
        }
        
        // for each site, build Voronoi cell from circumcenters of adjacent triangles
        for (let i = 0; i < sites.length; i++) {
            const site = sites[i];
            const cellVertices = [];
            const triList = siteTriangles.get(i);
            
            if (triList.length === 0) continue;
            
            // get circumcenters of all triangles containing this site
            const circumcenters = [];
            for (const t of triList) {
                const i0 = triangles[t * 3];
                const i1 = triangles[t * 3 + 1];
                const i2 = triangles[t * 3 + 2];
                
                const p0 = { x: coords[i0 * 2], y: coords[i0 * 2 + 1] };
                const p1 = { x: coords[i1 * 2], y: coords[i1 * 2 + 1] };
                const p2 = { x: coords[i2 * 2], y: coords[i2 * 2 + 1] };
                
                const cc = this.circumcenter(p0, p1, p2);
                circumcenters.push({ x: cc.x, y: cc.y, tri: t });
            }
            
            // sort circumcenters by angle around site
            circumcenters.sort((a, b) => {
                const angleA = Math.atan2(a.y - site.y, a.x - site.x);
                const angleB = Math.atan2(b.y - site.y, b.x - site.x);
                return angleA - angleB;
            });
            
            // use sorted circumcenters as cell vertices
            for (const cc of circumcenters) {
                // clip to canvas bounds
                const x = Math.max(0, Math.min(cc.x, this.canvasWidth));
                const y = Math.max(0, Math.min(cc.y, this.canvasHeight));
                cellVertices.push({ x, y });
            }
            
            if (cellVertices.length >= 3) {
                cells.push({
                    site: site,
                    vertices: cellVertices
                });
            }
        }
        
        return cells;
    }
    
    // calculate circumcenter of a triangle
    circumcenter(a, b, c) {
        const ax = a.x, ay = a.y;
        const bx = b.x, by = b.y;
        const cx = c.x, cy = c.y;
        
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-10) {
            // degenerate triangle, return centroid
            return {
                x: (ax + bx + cx) / 3,
                y: (ay + by + cy) / 3
            };
        }
        
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
        
        return { x: ux, y: uy };
    }
    
    // generate mesh from Voronoi pattern covering whole canvas
    generateVoronoiMesh() {
        // generate Voronoi sites covering whole canvas
        const sites = this.generateVoronoiSites();
        
        if (sites.length < 3) {
            return { vertices: [], uvs: [], indices: [] };
        }
        
        // flatten sites for Delaunator
        const coords = [];
        for (const site of sites) {
            coords.push(site.x, site.y);
        }
        
        // compute Delaunay triangulation
        const delaunay = new Delaunator(coords);
        
        // extract Voronoi cells covering whole canvas
        const cells = this.getVoronoiCells(delaunay, sites);
        
        // build mesh: triangulate all cells
        const allVertices = [];
        const allUvs = [];
        const allIndices = [];
        const allOffsets = [];
        
        // store triangle data
        const triangleData = [];
        
        for (const cell of cells) {
            // triangulate cell using fan from site
            const vertices = cell.vertices;
            if (vertices.length < 3) continue;
            
            const site = cell.site;
            
            // convert site to normalized device coordinates
            const siteNDC = {
                x: (site.x / this.canvasWidth) * 2 - 1,
                y: 1 - (site.y / this.canvasHeight) * 2
            };
            
            // convert cell vertices to NDC
            const cellVerticesNDC = [];
            for (const v of vertices) {
                cellVerticesNDC.push({
                    x: (v.x / this.canvasWidth) * 2 - 1,
                    y: 1 - (v.y / this.canvasHeight) * 2
                });
            }
            
            // create fan triangles from site to cell vertices
            for (let i = 0; i < cellVerticesNDC.length; i++) {
                const next = (i + 1) % cellVerticesNDC.length;
                const v0 = siteNDC;
                const v1 = cellVerticesNDC[i];
                const v2 = cellVerticesNDC[next];
                
                // check triangle area and edge length
                const area = this.triangleArea(v0, v1, v2);
                if (area < this.minTriangleArea) continue;
                
                const edge1 = this.edgeLength(v0, v1);
                const edge2 = this.edgeLength(v1, v2);
                const edge3 = this.edgeLength(v2, v0);
                const minEdge = Math.min(edge1, edge2, edge3);
                if (minEdge < this.minEdgeLength) continue;
                
                // calculate triangle center in pixel coordinates for UV rotation
                const centerX = (v0.x + v1.x + v2.x) / 3;
                const centerY = (v0.y + v1.y + v2.y) / 3;
                const centerPixelX = ((centerX + 1) / 2) * this.canvasWidth;
                const centerPixelY = ((1 - centerY) / 2) * this.canvasHeight;
                
                triangleData.push({
                    v0, v1, v2,
                    centerPixelX, centerPixelY
                });
            }
        }
        
        // assign UVs to all triangles (threshold filtering is done in shader)
        for (let triIndex = 0; triIndex < triangleData.length; triIndex++) {
            const tri = triangleData[triIndex];
            // add vertices
            const baseIndex = allVertices.length / 2;
            allVertices.push(tri.v0.x, tri.v0.y);
            allVertices.push(tri.v1.x, tri.v1.y);
            allVertices.push(tri.v2.x, tri.v2.y);
            
            // generate stable offset based on triangle index
            // use triangle index to create a stable offset (0-1 range)
            // this ensures each triangle gets a unique, stable offset
            const triangleOffset = (triIndex % 1000) / 1000.0; // cycle through 0-1 over 1000 triangles
            
            // generate stable angle based on triangle properties (not aligned with first edge)
            // use triangle center position to create a stable angle that varies per triangle
            // this creates a unique orientation for each triangle that's stable between frames
            const angleFromPosition = Math.atan2(tri.centerPixelY, tri.centerPixelX);
            
            // also incorporate triangle area to add variation
            const area = this.triangleArea(tri.v0, tri.v1, tri.v2);
            const areaFactor = area * 1000; // scale area to get meaningful variation
            
            // combine position and area to get stable angle
            // add 45 degrees offset to ensure it's not aligned with first edge
            const stableAngle = angleFromPosition + areaFactor + Math.PI / 4;
            
            // standard triangle UVs (v0 at origin, v1 along U axis, v2 at standard position)
            const baseUv0 = { u: 0, v: 0 };
            const baseUv1 = { u: 1, v: 0 };
            const baseUv2 = { u: 0.5, v: 1 };
            
            // rotate UV coordinates around v0 (origin) by stable angle
            const cosAngle = Math.cos(stableAngle);
            const sinAngle = Math.sin(stableAngle);
            
            // rotate v1 around origin
            const uv1 = {
                u: baseUv1.u * cosAngle - baseUv1.v * sinAngle,
                v: baseUv1.u * sinAngle + baseUv1.v * cosAngle
            };
            
            // rotate v2 around origin
            const uv2 = {
                u: baseUv2.u * cosAngle - baseUv2.v * sinAngle,
                v: baseUv2.u * sinAngle + baseUv2.v * cosAngle
            };
            
            // v0 stays at origin (0, 0)
            const uv0 = { u: 0, v: 0 };
            
            // normalize to ensure UVs are in valid range (0-1)
            // find bounding box of rotated UVs
            const minU = Math.min(0, uv1.u, uv2.u);
            const minV = Math.min(0, uv1.v, uv2.v);
            const maxU = Math.max(0, uv1.u, uv2.u);
            const maxV = Math.max(0, uv1.v, uv2.v);
            
            // normalize to 0-1 range, keeping v0 at (0, 0) if possible
            const rangeU = maxU - minU || 1;
            const rangeV = maxV - minV || 1;
            
            const normalizedUv0 = { u: (0 - minU) / rangeU, v: (0 - minV) / rangeV };
            const normalizedUv1 = { u: (uv1.u - minU) / rangeU, v: (uv1.v - minV) / rangeV };
            const normalizedUv2 = { u: (uv2.u - minU) / rangeU, v: (uv2.v - minV) / rangeV };
            
            allUvs.push(normalizedUv0.u, normalizedUv0.v);
            allUvs.push(normalizedUv1.u, normalizedUv1.v);
            allUvs.push(normalizedUv2.u, normalizedUv2.v);
            
            // add triangle offset to all 3 vertices (same offset for all vertices in triangle)
            allOffsets.push(triangleOffset);
            allOffsets.push(triangleOffset);
            allOffsets.push(triangleOffset);
            
            // add triangle indices
            allIndices.push(baseIndex, baseIndex + 1, baseIndex + 2);
        }
        
        return { vertices: allVertices, uvs: allUvs, indices: allIndices, offsets: allOffsets };
    }

    // generate triangles from Voronoi pattern
    generateMesh() {
        return this.generateVoronoiMesh();
    }
}
