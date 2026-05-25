import json
import math

GEOJSON_PATH = "world.geojson"
OUTPUT_PATH = "map_output.txt"
WORLD_W = 4800
WORLD_H = 2400
MIN_AREA = 200

def lonlat_to_xy(lon, lat):
    x = (lon + 180) / 360 * WORLD_W
    y = (90 - lat) / 180 * WORLD_H
    return [round(x, 1), round(y, 1)]

def polygon_area(points):
    area = 0
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        area += points[i][0] * points[j][1]
        area -= points[j][0] * points[i][1]
    return abs(area) / 2

def simplify_polygon(points, tolerance=3.0):
    if len(points) <= 10:
        return points
    
    def perp_dist(p, p1, p2):
        if p1[0] == p2[0] and p1[1] == p2[1]:
            return math.hypot(p[0]-p1[0], p[1]-p1[1])
        num = abs((p2[1]-p1[1])*p[0] - (p2[0]-p1[0])*p[1] + p2[0]*p1[1] - p2[1]*p1[0])
        den = math.hypot(p2[0]-p1[0], p2[1]-p1[1])
        return num / den if den != 0 else 0
    
    def dp(pts, eps):
        if len(pts) <= 2:
            return pts
        dmax, idx = 0, 0
        for i in range(1, len(pts)-1):
            d = perp_dist(pts[i], pts[0], pts[-1])
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps:
            left = dp(pts[:idx+1], eps)
            right = dp(pts[idx:], eps)
            return left[:-1] + right
        return [pts[0], pts[-1]]
    
    return dp(points, tolerance)

with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
    geo = json.load(f)

continents = []
for feature in geo["features"]:
    geom = feature["geometry"]
    props = feature.get("properties", {})
    name = props.get("name", f"Land_{len(continents)}")
    if geom is None:
        continue
    
    polys = []
    if geom["type"] == "Polygon":
        polys.append(geom["coordinates"][0])
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            polys.append(poly[0])
    
    for ring in polys:
        pts = [lonlat_to_xy(lon, lat) for lon, lat in ring]
        pts = simplify_polygon(pts, tolerance=3.0)
        if polygon_area(pts) < MIN_AREA:
            continue
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        continents.append({"name": name, "points": pts})

lines = [
    "// 由GeoJSON自动转换的世界地图数据",
    f"// 共 {len(continents)} 个多边形, 总顶点 {sum(len(c['points']) for c in continents)} 个",
    "const worldMap = {",
    "  width: 4800,",
    "  height: 2400,",
    "  continents: ["
]
for c in continents:
    pts = ", ".join([f"[{p[0]}, {p[1]}]" for p in c["points"]])
    lines.append(f"    {{ name: \"{c['name']}\", points: [{pts}] }},")
lines.extend(["  ]", "};"])

with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

print(f"✅ 完成！生成 {len(continents)} 个多边形，共 {sum(len(c['points']) for c in continents)} 个顶点")
print(f"📄 请打开 {OUTPUT_PATH} 复制内容到游戏中")